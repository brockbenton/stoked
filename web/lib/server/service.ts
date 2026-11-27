/**
 * Gift API logic with injected database, chain, clock and rate limiter.
 * Route handlers (web/app/api) only parse HTTP and call this.
 *
 * Claim protocol (docs/build-plan.md § Claim must never pay twice):
 *   1. CAS opened → claiming, binding the wallet. One caller wins.
 *   2. Build and sign: idempotent ATA creation + transferChecked.
 *   3. Store signature + last valid height (CAS) BEFORE sending.
 *   4. Send and confirm, then CAS claiming → claimed.
 *   5. Retry while claiming: confirmed → claimed; pending → 202; expired or
 *      failed (finalized, so nothing moved) → one caller replaces the stored
 *      signature by CAS. The wallet never changes.
 *
 * Escrow gifts (docs/escrow.md) lock their tokens at creation. The same steps
 * claim them, building the program's claim instead of a treasury transfer, and
 * the chain is read first: it is the authority on whether the gift was paid.
 *
 * With payments on, the sender's wallet pays for the gift and is its on-chain
 * sender: prepare hands the wallet a transaction, submit verifies, co-signs and
 * sends it (docs/escrow.md § Wallet-paid gifts).
 */
import type { ChainAdapter, ClaimStatus, SignedClaim } from "@stoked/chain";
import {
  PaymentRejectedError,
  type EscrowAdapter,
  type EscrowGiftState,
  type PaymentAdapter,
  type PaymentTerms,
} from "@stoked/chain/escrow";
import {
  ClaimGiftRequest,
  CreateGiftRequest,
  DEMO_PRICES_CENTS,
  DEMO_PRICE_SOURCE,
  MAX_OPENS_AHEAD_MS,
  OpenGiftRequest,
  PrepareGiftRequest,
  PublicGift,
  SubmitGiftRequest,
  SwapGiftRequest,
  WalletAddress,
  displayShares,
  effectiveMultiplier,
  formatUnits,
  rawToUsdCents,
  usdToRaw,
  type ClaimGiftResponse,
  type CreateGiftResponse,
  type GiftValue,
  type MultiplierSchedule,
  type PrepareGiftResponse,
  type SubmitGiftResponse,
  type Ratio,
  type Ticker,
} from "@stoked/shared";
import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { randomBytes, randomUUID } from "node:crypto";
import { ApiError, invalidState, notFound } from "./errors";
import type { RateLimiter } from "./rate-limit";
import type { GiftRecord, GiftStore, NewGift } from "./store";
import { readTicket, signTicket, type PaymentTicket } from "./ticket";
import { hashToken, newClaimToken, tokenMatches } from "./tokens";

/** How long after the later of creation and opensAt an escrow gift can be claimed. */
export const ESCROW_TTL_SECONDS = 30 * 86_400;
/** Time allowed to create an escrow gift: the web client gives up after 20 seconds. */
export const ESCROW_CREATE_TIMEOUT_MS = 15_000;
/** How long after prepare a payment may still be sent. After that a submit only reports on it. */
export const PAYMENT_TICKET_TTL_MS = 10 * 60_000;
/** SOL a paying wallet needs for fees and the new accounts' rent. */
export const MIN_SENDER_LAMPORTS = 10_000_000n;

export interface EscrowDeps {
  adapter: EscrowAdapter;
  /** The STOKED_ESCROW flag, for new gifts only: each gift keeps the mode it was created with. */
  createGifts: boolean;
  /** Overrides ESCROW_CREATE_TIMEOUT_MS. */
  createTimeoutMs?: number;
  /** Also stop waiting for the lock after this many status checks. */
  createConfirmPolls?: number;
}

export interface PaymentDeps {
  adapter: PaymentAdapter;
  /** Signs the terms the browser holds between prepare and submit. */
  ticketKey: Uint8Array;
  /** Display name of the payment token. */
  symbol: string;
  /** Status checks after sending before submit answers 202. */
  confirmPolls?: number;
}

export interface ServiceDeps {
  store: GiftStore;
  chain: ChainAdapter;
  rateLimiter: RateLimiter;
  now?: () => Date;
  /** After sending, how many status checks to wait for confirmation before answering 202. */
  confirmPolls?: number;
  confirmIntervalMs?: number;
  newToken?: () => string;
  /** Durable cap on gifts created per window, counted in the database. */
  creationCap?: { max: number; windowMs: number };
  /** Absent: no escrow at all. Escrow gifts are then refused, never paid from the treasury. */
  escrow?: EscrowDeps;
  /** Senders pay from their own wallet; free creation is then refused. Needs `escrow`. */
  payments?: PaymentDeps;
}

interface RequestSchema<T> {
  safeParse(
    v: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

/** Request validation: a ZodError here is the client's fault (400); anywhere else it is ours (500). */
function parseRequest<T>(schema: RequestSchema<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (r.success) return r.data;
  const message = r.error.issues.map((i) => `${i.path.map(String).join(".") || "body"}: ${i.message}`).join("; ");
  throw new ApiError("validation_failed", message || "Invalid request");
}

/** Server-side log of a failure by name and message only (no objects that could carry config). */
function logError(what: string, err: unknown): void {
  const e = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  console.error(`[stoked] ${what} failed: ${e.slice(0, 500)}`);
}

/** `promise`, or a rejection once `ms` has passed. The work itself isn't cancelled. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), Math.max(0, ms));
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface SubmitResult {
  httpStatus: 200 | 202;
  body: SubmitGiftResponse;
}

export interface ClaimResult {
  httpStatus: 200 | 202;
  body: ClaimGiftResponse;
}

/** An exact ratio with a power-of-ten denominator as a decimal string: {1002, 1000} → "1.002". */
export function ratioToDecimal(r: Ratio): string {
  let den = r.den;
  let places = 0;
  while (den % 10n === 0n) {
    den /= 10n;
    places += 1;
  }
  if (den !== 1n) throw new Error("multiplier is not a terminating decimal");
  const s = formatUnits(r.num, places);
  return places === 0 ? s : s.replace(/\.?0+$/, "");
}

export function isValidWallet(wallet: unknown): wallet is string {
  if (!WalletAddress.safeParse(wallet).success) return false;
  try {
    const key = new PublicKey(wallet as string);
    // Must be a wallet (an ed25519 point), not a program-derived address.
    return PublicKey.isOnCurve(key.toBytes());
  } catch {
    return false;
  }
}

/** Why the cluster would refuse a payment, in words a sender can act on. */
function explainRejection(why: string): string {
  if (/BlockhashNotFound/i.test(why)) return "That took too long to approve. Try again; you weren't charged.";
  if (/insufficient (funds|lamports)|InsufficientFunds|"Custom":1\b/i.test(why)) {
    return "The wallet doesn't have enough to pay for this gift. You weren't charged.";
  }
  return "Solana refused the payment. You weren't charged.";
}

export function createGiftService(deps: ServiceDeps) {
  const { store, chain, rateLimiter } = deps;
  if (deps.payments && !deps.escrow) throw new Error("payments need the escrow");
  const now = deps.now ?? (() => new Date());
  const confirmPolls = deps.confirmPolls ?? 8;
  const confirmIntervalMs = deps.confirmIntervalMs ?? 500;
  const newToken = deps.newToken ?? newClaimToken;
  const creationCap = deps.creationCap ?? { max: 200, windowMs: 3_600_000 };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function price(ticker: Ticker) {
    const p = await store.getPrice(ticker);
    return p ?? { usdCents: DEMO_PRICES_CENTS[ticker], source: DEMO_PRICE_SOURCE, updatedAt: now().toISOString() };
  }

  const lastSchedule = new Map<Ticker, MultiplierSchedule>();
  const nowSeconds = () => Math.floor(now().getTime() / 1000);

  /** Multiplier in force now, read from the mint. Sizing (create, swap) must use a fresh read. */
  async function multiplier(ticker: Ticker): Promise<Ratio> {
    try {
      const schedule = await chain.multiplierSchedule(ticker);
      lastSchedule.set(ticker, schedule);
      return effectiveMultiplier(schedule, nowSeconds());
    } catch (err) {
      logError(`multiplier read for ${ticker}`, err);
      throw new ApiError("chain_unavailable", "Couldn't reach Solana; try again shortly");
    }
  }

  /**
   * For display only: falls back to the last schedule read (or 1.0 before any
   * read) so a state change that already happened is never reported as failed
   * because the RPC hiccuped while formatting the response.
   */
  async function displayMultiplier(ticker: Ticker): Promise<Ratio> {
    try {
      return await multiplier(ticker);
    } catch {
      return effectiveMultiplier(lastSchedule.get(ticker) ?? { multiplier: 1 }, nowSeconds());
    }
  }

  async function value(g: GiftRecord): Promise<GiftValue> {
    const [p, m] = await Promise.all([price(g.ticker), displayMultiplier(g.ticker)]);
    const raw = BigInt(g.tokenRaw);
    return {
      priceCents: p.usdCents,
      priceSource: p.source,
      priceUpdatedAt: p.updatedAt,
      multiplier: ratioToDecimal(m),
      shares: displayShares(raw, m),
      valueCents: rawToUsdCents(raw, p.usdCents, m),
    };
  }

  /** Public shape. A wrapped gift's ticker, amount and note are absent, not just hidden. */
  async function toPublic(g: GiftRecord): Promise<PublicGift> {
    const base = {
      id: g.id,
      senderName: g.senderName,
      recipientName: g.recipientName,
      opensAt: g.opensAt,
      createdAt: g.createdAt,
    };
    if (g.status === "wrapped") return PublicGift.parse({ ...base, status: "wrapped" });
    const contents = {
      ticker: g.ticker,
      usdCents: g.usdCents,
      note: g.note,
      tokenRaw: g.tokenRaw,
      openedAt: g.openedAt,
      value: await value(g),
    };
    if (g.status === "opened") {
      const locked = g.escrowAccount ? { swappable: false } : {};
      return PublicGift.parse({ ...base, ...contents, ...locked, status: "opened" });
    }
    if (g.status === "claiming") {
      return PublicGift.parse({
        ...base,
        ...contents,
        status: "claiming",
        recipientWallet: g.recipientWallet,
        claimSignature: g.claimSignature,
      });
    }
    return PublicGift.parse({
      ...base,
      ...contents,
      status: "claimed",
      recipientWallet: g.recipientWallet,
      claimSignature: g.claimSignature,
      claimedAt: g.claimedAt,
    });
  }

  async function load(id: string): Promise<GiftRecord> {
    // Ids are uuids; anything else can't exist (and would be a database type error).
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw notFound();
    const g = await store.get(id);
    if (!g) throw notFound();
    return g;
  }

  async function authed(id: string, token: string | null): Promise<GiftRecord> {
    const g = await load(id);
    if (!token) throw new ApiError("unauthorized", "Missing claim token (Authorization: Bearer <token>)");
    if (!tokenMatches(token, g.claimTokenHash)) throw new ApiError("forbidden", "That token doesn't open this gift");
    return g;
  }

  async function reload(id: string): Promise<GiftRecord> {
    const g = await store.get(id);
    if (!g) throw notFound();
    return g;
  }

  /** The response for whatever state the gift is in now. */
  async function respond(g: GiftRecord): Promise<ClaimResult> {
    return g.status === "claimed" ? claimed(g) : pending(g);
  }

  async function claimed(g: GiftRecord): Promise<ClaimResult> {
    const gift = await toPublic(g);
    return { httpStatus: 200, body: { status: "claimed", signature: g.claimSignature!, gift } };
  }

  async function pending(g: GiftRecord): Promise<ClaimResult> {
    const gift = await toPublic(g);
    return { httpStatus: 202, body: { status: "pending", signature: g.claimSignature, gift } };
  }

  /** Step 4 for a stored signature: mark claimed once confirmed. */
  async function settleConfirmed(g: GiftRecord): Promise<ClaimResult> {
    const done = await store.markClaimed(g.id, g.claimSignature!, now().toISOString());
    return respond(done ?? (await reload(g.id)));
  }

  /** Insert an escrow gift and lock its tokens; succeeds only once the lock is confirmed. */
  async function createLocked(escrow: EscrowDeps, gift: NewGift, claimToken: string, deadline: number): Promise<string> {
    const left = () => deadline - Date.now();
    const id = randomUUID();
    const openAt = gift.opensAt ? Math.ceil(Date.parse(gift.opensAt) / 1000) : 0;
    const unavailable = (what: string, err: unknown) => {
      logError(what, err);
      return new ApiError("chain_unavailable", "Couldn't lock the gift on Solana; try again shortly");
    };
    let lock: SignedClaim & { account: string };
    try {
      lock = await within(
        escrow.adapter.buildCreate({
          giftId: id,
          claimToken,
          ticker: gift.ticker,
          raw: BigInt(gift.tokenRaw),
          openAt,
          expiresAt: Math.max(nowSeconds(), openAt) + ESCROW_TTL_SECONDS,
        }),
        left(),
      );
    } catch (err) {
      throw unavailable("build escrow gift", err);
    }
    // The row is written first, so tokens never lock without a record of where.
    await store.insert({ ...gift, id, escrowAccount: lock.account });
    try {
      await within(chain.sendClaim(lock), left());
    } catch (err) {
      throw unavailable(`send escrow gift ${id}`, err);
    }
    let state: ClaimStatus["state"] = "pending";
    const polls = escrow.createConfirmPolls ?? Number.POSITIVE_INFINITY;
    for (let i = 0; i < polls && state === "pending" && left() > 0; i++) {
      if (i > 0) await sleep(Math.min(confirmIntervalMs, Math.max(0, left())));
      const sent = { signature: lock.signature, lastValidBlockHeight: lock.lastValidBlockHeight };
      state = await within(statusOf(sent), left()).then(
        (s) => s.state,
        () => "pending" as const,
      );
    }
    // Unconfirmed: the token is never returned. If the lock lands late, only a refund can move it.
    if (state !== "confirmed") throw unavailable(`confirm escrow gift ${id}`, new Error(`transaction ${state}`));
    return id;
  }

  function escrowAdapter(): EscrowAdapter {
    if (!deps.escrow) {
      logError("escrow claim", new Error("ESCROW_PROGRAM_ID is not set but an escrow gift exists"));
      throw new ApiError("internal", "Server is missing its escrow configuration");
    }
    return deps.escrow.adapter;
  }

  /**
   * Read an escrow gift on chain and refuse what the program would refuse.
   * Returns it when `wallet` can be paid, or already was.
   */
  async function escrowState(g: GiftRecord, wallet: string): Promise<EscrowGiftState> {
    const adapter = escrowAdapter();
    let read: Awaited<ReturnType<EscrowAdapter["read"]>>;
    try {
      read = await adapter.read(g.escrowAccount!);
    } catch (err) {
      logError(`read escrow gift ${g.id}`, err);
      throw new ApiError("chain_unavailable", "Couldn't reach Solana; try again shortly");
    }
    const { gift, clusterTime } = read;
    if (!gift) throw new ApiError("chain_unavailable", "This gift isn't visible on Solana yet; try again shortly");
    if (gift.status === "claimed") {
      if (gift.recipient !== wallet) throw invalidState("This gift was already claimed to a different wallet");
      return gift;
    }
    if (gift.status === "refunded" || clusterTime >= gift.expiresAt) {
      throw new ApiError("expired", "This gift has expired");
    }
    if (clusterTime < gift.openAt) {
      throw new ApiError("too_early", "This gift hasn't opened on Solana yet; try again in a moment");
    }
    return gift;
  }

  /** The program already paid the bound wallet by a transaction other than the stored one: record that one. */
  async function recordPaid(g: GiftRecord): Promise<ClaimResult> {
    let found: string | null;
    try {
      found = await escrowAdapter().findClaimSignature(g.escrowAccount!);
    } catch (err) {
      logError(`find claim for gift ${g.id}`, err);
      throw new ApiError("chain_unavailable", "Couldn't reach Solana; try again shortly");
    }
    if (!found) return pending(g);
    const stored = await store.setClaimTx(g.id, g.claimSignature, found, 0n);
    return stored ? settleConfirmed(stored) : respond(await reload(g.id));
  }

  /** Steps 2–4: build, store (CAS against `expected`), send, briefly wait for confirmation. */
  async function signStoreSend(g: GiftRecord, expected: string | null, claimToken: string): Promise<ClaimResult> {
    if (g.escrowAccount && (await escrowState(g, g.recipientWallet!)).status === "claimed") return recordPaid(g);
    let signed: SignedClaim;
    try {
      signed = g.escrowAccount
        ? await escrowAdapter().buildClaim({
            account: g.escrowAccount,
            giftId: g.id,
            claimToken,
            recipientWallet: g.recipientWallet!,
          })
        : await chain.buildClaim({ ticker: g.ticker, recipientWallet: g.recipientWallet!, raw: BigInt(g.tokenRaw) });
    } catch (err) {
      logError("build claim", err);
      throw new ApiError("chain_unavailable", "Couldn't reach Solana to prepare the transfer; try again shortly");
    }
    const stored = await store.setClaimTx(g.id, expected, signed.signature, signed.lastValidBlockHeight);
    if (!stored) {
      // Another request stored a transaction first; ours is discarded unsent.
      return respond(await reload(g.id));
    }
    try {
      await chain.sendClaim(signed);
    } catch (err) {
      // Stored and retryable: a later call sees it pending, then expired, and
      // replaces it. Logged, because a deterministic failure (e.g. an empty
      // treasury) otherwise looks like a claim that is pending forever.
      logError(`send claim for gift ${g.id}`, err);
      return pending(stored);
    }
    for (let i = 0; i < confirmPolls; i++) {
      const s = await statusOf(sentTx(stored));
      if (s.state === "confirmed") return settleConfirmed(stored);
      if (s.state !== "pending") break;
      await sleep(confirmIntervalMs);
    }
    return pending(stored);
  }

  const sentTx = (g: GiftRecord) => ({ signature: g.claimSignature!, lastValidBlockHeight: g.claimLastValidHeight! });

  async function statusOf(tx: Pick<SignedClaim, "signature" | "lastValidBlockHeight">): Promise<ClaimStatus> {
    try {
      return await chain.claimStatus(tx.signature, tx.lastValidBlockHeight);
    } catch (err) {
      // Unknown is never treated as expired: replacing a transaction that might still land could pay twice.
      logError("claim status", err);
      return { state: "pending" };
    }
  }

  /** Step 5. */
  async function progress(g: GiftRecord, claimToken: string): Promise<ClaimResult> {
    if (!g.claimSignature) return signStoreSend(g, null, claimToken);
    const s = await statusOf(sentTx(g));
    switch (s.state) {
      case "confirmed":
        return settleConfirmed(g);
      case "pending":
        return pending(g);
      case "expired":
      case "failed":
        // Finalized absence or failure: nothing moved, so replace it (CAS keeps it to one caller).
        return signStoreSend(g, g.claimSignature, claimToken);
    }
  }

  /** Refuse an opening time in the past, or too far ahead for locked tokens. */
  function checkOpensAt(opensAt: string | undefined, locked: boolean) {
    if (opensAt && Date.parse(opensAt) <= now().getTime()) {
      throw new ApiError("validation_failed", "opensAt must be in the future");
    }
    if (locked && opensAt && Date.parse(opensAt) > now().getTime() + MAX_OPENS_AHEAD_MS) {
      throw new ApiError("validation_failed", "opensAt can be at most 365 days ahead");
    }
  }

  /** Durable cap across instances and cold starts (the in-memory limiter is per instance). */
  async function checkCap() {
    const since = new Date(now().getTime() - creationCap.windowMs).toISOString();
    if ((await store.countCreatedSince(since)) >= creationCap.max) {
      throw new ApiError("rate_limited", "Gift limit reached for now; try again later");
    }
  }

  function payments(): PaymentDeps & { escrow: EscrowDeps } {
    if (!deps.payments) throw invalidState("Wallet payments aren't enabled here");
    return { ...deps.payments, escrow: deps.escrow! };
  }

  /** `promise`, with any failure reported as the chain being unavailable. */
  async function onChain<T>(what: string, promise: () => T | Promise<T>): Promise<T> {
    try {
      return await promise();
    } catch (err) {
      if (err instanceof PaymentRejectedError) {
        logError(what, err);
        throw new ApiError("payment_rejected", "That transaction doesn't match this gift. You weren't charged.");
      }
      logError(what, err);
      throw new ApiError("chain_unavailable", "Couldn't reach Solana; try again shortly");
    }
  }

  const paymentTerms = (adapter: PaymentAdapter, t: Omit<PaymentTicket, "recent">, claimToken: string): PaymentTerms => ({
    giftId: t.id,
    claimKey: adapter.claimKeyFor(claimToken, t.id),
    seed: t.seed,
    sender: t.sender,
    ticker: t.ticker,
    raw: BigInt(t.tokenRaw),
    amount: BigInt(t.amount),
    openAt: t.openAt,
    expiresAt: t.expiresAt,
  });

  /** Send an accepted payment (while `send`) and report whether the gift is locked on chain. */
  async function settlePayment(
    pay: PaymentDeps & { escrow: EscrowDeps },
    id: string,
    tx: SignedClaim & { account: string },
    send: boolean,
  ): Promise<SubmitResult> {
    const confirmed = (signature: string | null): SubmitResult => ({
      httpStatus: 200,
      body: { status: "confirmed", id, signature },
    });
    const pending: SubmitResult = { httpStatus: 202, body: { status: "pending", id, signature: tx.signature } };
    /** Null when the chain can't be read, which proves nothing either way. */
    const locked = () =>
      pay.escrow.adapter.read(tx.account).then(
        (r) => r.gift !== null,
        (err: unknown) => {
          logError(`read paid gift ${id}`, err);
          return null;
        },
      );
    if (await locked()) {
      return confirmed((await statusOf(tx)).state === "confirmed" ? tx.signature : null);
    }
    if (send) {
      try {
        await chain.sendClaim(tx);
      } catch (err) {
        // It may be on its way from an earlier call; the status checks decide.
        logError(`send payment for gift ${id}`, err);
      }
    }
    const polls = pay.confirmPolls ?? 20;
    for (let i = 0; i < polls; i++) {
      const { state } = await statusOf(tx);
      if (state === "confirmed") return confirmed(tx.signature);
      if (state !== "pending") {
        // An earlier transaction for this gift may be the one that landed.
        const exists = await locked();
        if (exists) return confirmed(null);
        if (exists === null) return pending;
        throw new ApiError("payment_rejected", `The payment didn't go through, so no ${pay.symbol} left the wallet. Try again.`);
      }
      await sleep(confirmIntervalMs);
    }
    return pending;
  }

  return {
    /** Step 1 of a wallet-paid gift: price it and build the transaction for the sender's wallet. */
    async prepare(body: unknown, clientKey: string): Promise<PrepareGiftResponse> {
      const pay = payments();
      const { gift: req, senderWallet } = parseRequest(PrepareGiftRequest, body);
      if (!isValidWallet(senderWallet)) throw new ApiError("invalid_wallet", "That isn't a Solana wallet address");
      checkOpensAt(req.opensAt, true);
      if (!rateLimiter.take(clientKey)) throw new ApiError("rate_limited", "Too many gifts; try again in a minute");
      await checkCap();
      const p = await price(req.ticker);
      const raw = usdToRaw(req.usdCents, p.usdCents, await multiplier(req.ticker));
      const decimals = await onChain("read payment mint", () => pay.adapter.decimals());
      const amount = BigInt(req.usdCents) * 10n ** BigInt(decimals - 2);
      const funds = await onChain("read sender funds", () => pay.adapter.funds(senderWallet));
      if (funds.payment < amount) {
        throw new ApiError("insufficient_funds", `This wallet needs ${req.usdCents / 100} ${pay.symbol} on devnet.`);
      }
      if (funds.lamports < MIN_SENDER_LAMPORTS) {
        throw new ApiError("insufficient_funds", "This wallet needs at least 0.01 devnet SOL for fees and storage.");
      }
      const id = randomUUID();
      const token = newToken();
      const openAt = req.opensAt ? Math.ceil(Date.parse(req.opensAt) / 1000) : 0;
      const terms: Omit<PaymentTicket, "recent"> = {
        id,
        seed: randomBytes(16).toString("hex"),
        sender: senderWallet,
        ticker: req.ticker,
        usdCents: req.usdCents,
        priceCents: p.usdCents,
        tokenRaw: raw.toString(),
        amount: amount.toString(),
        senderName: req.senderName,
        recipientName: req.recipientName,
        note: req.note ?? null,
        opensAt: req.opensAt ? new Date(req.opensAt).toISOString() : null,
        openAt,
        expiresAt: Math.max(nowSeconds(), openAt) + ESCROW_TTL_SECONDS,
        tokenHash: hashToken(token),
        issuedAt: now().toISOString(),
      };
      const built = await onChain("build paid gift", () => pay.adapter.build(paymentTerms(pay.adapter, terms, token)));
      const ticket = signTicket(pay.ticketKey, { ...terms, recent: built.recent });
      return { id, claimToken: token, transaction: bs58.encode(built.transaction), ticket };
    },

    /** Step 2: verify the wallet-signed transaction, co-sign, record and send it. Safe to repeat. */
    async submit(token: string | null, body: unknown): Promise<SubmitResult> {
      const pay = payments();
      const req = parseRequest(SubmitGiftRequest, body);
      const ticket = readTicket(pay.ticketKey, req.ticket);
      if (!ticket) throw new ApiError("validation_failed", "That payment request isn't valid");
      if (!token) throw new ApiError("unauthorized", "Missing claim token (Authorization: Bearer <token>)");
      if (!tokenMatches(token, ticket.tokenHash)) throw new ApiError("forbidden", "That token doesn't belong to this gift");
      const tx = await onChain(`accept payment for gift ${ticket.id}`, () =>
        pay.adapter.accept(paymentTerms(pay.adapter, ticket, token), bs58.decode(req.transaction), ticket.recent),
      );
      let row = await store.get(ticket.id);
      // The price was fixed at prepare, so a late transaction is never sent.
      const fresh = now().getTime() - Date.parse(ticket.issuedAt) <= PAYMENT_TICKET_TTL_MS;
      if (!row) {
        if (!fresh) {
          throw new ApiError("payment_rejected", "That payment request is too old. Start again; you weren't charged.");
        }
        await checkCap();
        const why = await onChain("simulate payment", () => pay.adapter.simulate(tx.transaction));
        if (why) {
          logError(`simulate payment for gift ${ticket.id}`, new Error(why));
          throw new ApiError("payment_rejected", explainRejection(why));
        }
        // The row is written first, so money never moves without a record of the gift.
        try {
          await store.insert({
            id: ticket.id,
            escrowAccount: tx.account,
            senderName: ticket.senderName,
            recipientName: ticket.recipientName,
            ticker: ticket.ticker,
            usdCents: ticket.usdCents,
            priceCents: ticket.priceCents,
            tokenRaw: ticket.tokenRaw,
            note: ticket.note,
            opensAt: ticket.opensAt,
            claimTokenHash: ticket.tokenHash,
            createdAt: now().toISOString(),
          });
        } catch (err) {
          // A concurrent submit may have written it.
          row = await store.get(ticket.id);
          if (!row) {
            logError(`save paid gift ${ticket.id}`, err);
            throw new ApiError("payment_rejected", "Couldn't save the gift, so nothing was sent. Try again in a minute.");
          }
        }
      }
      if (row && (row.escrowAccount !== tx.account || row.claimTokenHash !== ticket.tokenHash)) {
        throw invalidState("A different gift already has that id");
      }
      return settlePayment(pay, ticket.id, tx, fresh);
    },

    async create(body: unknown, clientKey: string): Promise<CreateGiftResponse> {
      if (deps.payments) throw new ApiError("forbidden", "Gifts here are paid from a connected wallet");
      const started = Date.now();
      const req = parseRequest(CreateGiftRequest, body);
      const locks = deps.escrow?.createGifts ? deps.escrow : undefined;
      checkOpensAt(req.opensAt, locks !== undefined);
      if (!rateLimiter.take(clientKey)) throw new ApiError("rate_limited", "Too many gifts; try again in a minute");
      await checkCap();
      const p = await price(req.ticker);
      const m = await multiplier(req.ticker);
      const raw = usdToRaw(req.usdCents, p.usdCents, m);
      const token = newToken();
      const gift: NewGift = {
        senderName: req.senderName,
        recipientName: req.recipientName,
        ticker: req.ticker,
        usdCents: req.usdCents,
        priceCents: p.usdCents,
        tokenRaw: raw.toString(),
        note: req.note ?? null,
        opensAt: req.opensAt ? new Date(req.opensAt).toISOString() : null,
        claimTokenHash: hashToken(token),
        createdAt: now().toISOString(),
      };
      const id = locks
        ? await createLocked(locks, gift, token, started + (locks.createTimeoutMs ?? ESCROW_CREATE_TIMEOUT_MS))
        : (await store.insert(gift)).id;
      return { id, claimToken: token };
    },

    async get(id: string): Promise<PublicGift> {
      return toPublic(await load(id));
    },

    async open(id: string, token: string | null, body: unknown = {}): Promise<PublicGift> {
      parseRequest(OpenGiftRequest, body);
      const g = await authed(id, token);
      if (g.status !== "wrapped") throw invalidState(`Can't open a gift that is ${g.status}`);
      if (g.opensAt && Date.parse(g.opensAt) > now().getTime()) {
        throw new ApiError("too_early", `This gift opens at ${g.opensAt}`);
      }
      const opened = await store.open(id, now().toISOString());
      if (!opened) throw invalidState("The gift was opened by another request");
      return toPublic(opened);
    },

    async swap(id: string, token: string | null, body: unknown): Promise<PublicGift> {
      const { ticker } = parseRequest(SwapGiftRequest, body);
      const g = await authed(id, token);
      if (g.status !== "opened") throw invalidState(`Can't swap a gift that is ${g.status}`);
      if (g.escrowAccount) throw invalidState("This gift's tokens are locked in escrow, so it can't be swapped");
      const p = await price(ticker);
      const m = await multiplier(ticker);
      const raw = usdToRaw(g.usdCents, p.usdCents, m); // same USD value
      const swapped = await store.swap(id, { ticker, priceCents: p.usdCents, tokenRaw: raw.toString() });
      if (!swapped) throw invalidState("The gift changed state; reload it");
      return toPublic(swapped);
    },

    async claim(id: string, token: string | null, body: unknown): Promise<ClaimResult> {
      // Strict shape first ({wallet} and nothing else), then the wallet value itself.
      const onlyWallet =
        body !== null && typeof body === "object" && !Array.isArray(body) && Object.keys(body).join() === "wallet";
      if (!onlyWallet) throw new ApiError("validation_failed", "Body must be {wallet}");
      const parsed = ClaimGiftRequest.safeParse(body);
      const wallet = parsed.success ? parsed.data.wallet : undefined;
      if (!isValidWallet(wallet)) throw new ApiError("invalid_wallet", "That isn't a Solana wallet address");
      let g = await authed(id, token);
      if (g.status === "wrapped") throw invalidState("Open the gift before claiming it");
      if (g.status === "opened") {
        // Don't bind a wallet to an escrow gift the program would refuse.
        if (g.escrowAccount) await escrowState(g, wallet);
        // Step 1.
        g = (await store.beginClaim(id, wallet)) ?? (await reload(id));
      }
      if (g.recipientWallet !== wallet) {
        // The first claim fixed the wallet; a different one never redirects the funds.
        throw invalidState("This gift is already being claimed to a different wallet");
      }
      if (g.status === "claimed") return claimed(g);
      return progress(g, token!);
    },
  };
}

export type GiftService = ReturnType<typeof createGiftService>;
