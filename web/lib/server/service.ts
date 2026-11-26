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
 */
import type { ChainAdapter, ClaimStatus, SignedClaim } from "@stoked/chain";
import {
  ClaimGiftRequest,
  CreateGiftRequest,
  DEMO_PRICES_CENTS,
  DEMO_PRICE_SOURCE,
  PublicGift,
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
  type Ratio,
  type Ticker,
} from "@stoked/shared";
import { PublicKey } from "@solana/web3.js";
import { ApiError, invalidState, notFound } from "./errors";
import type { RateLimiter } from "./rate-limit";
import type { GiftRecord, GiftStore } from "./store";
import { hashToken, newClaimToken, tokenMatches } from "./tokens";

export interface ServiceDeps {
  store: GiftStore;
  chain: ChainAdapter;
  rateLimiter: RateLimiter;
  now?: () => Date;
  /** After sending, how many status checks to wait for confirmation before answering 202. */
  confirmPolls?: number;
  confirmIntervalMs?: number;
  newToken?: () => string;
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

export function createGiftService(deps: ServiceDeps) {
  const { store, chain, rateLimiter } = deps;
  const now = deps.now ?? (() => new Date());
  const confirmPolls = deps.confirmPolls ?? 8;
  const confirmIntervalMs = deps.confirmIntervalMs ?? 500;
  const newToken = deps.newToken ?? newClaimToken;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function price(ticker: Ticker) {
    const p = await store.getPrice(ticker);
    return p ?? { usdCents: DEMO_PRICES_CENTS[ticker], source: DEMO_PRICE_SOURCE, updatedAt: now().toISOString() };
  }

  /** Multiplier in force now, read from the mint. */
  async function multiplier(ticker: Ticker): Promise<Ratio> {
    try {
      const schedule = await chain.multiplierSchedule(ticker);
      return effectiveMultiplier(schedule, Math.floor(now().getTime() / 1000));
    } catch (err) {
      throw new ApiError("chain_unavailable", `Couldn't read the ${ticker} mint: ${(err as Error).message}`);
    }
  }

  async function value(g: GiftRecord): Promise<GiftValue> {
    const [p, m] = await Promise.all([price(g.ticker), multiplier(g.ticker)]);
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
    if (g.status === "opened") return PublicGift.parse({ ...base, ...contents, status: "opened" });
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
    const cur = done ?? (await reload(g.id));
    return cur.status === "claimed" ? claimed(cur) : pending(cur);
  }

  /** Steps 2–4: build, store (CAS against `expected`), send, briefly wait for confirmation. */
  async function signStoreSend(g: GiftRecord, expected: string | null): Promise<ClaimResult> {
    let signed: SignedClaim;
    try {
      signed = await chain.buildClaim({ ticker: g.ticker, recipientWallet: g.recipientWallet!, raw: BigInt(g.tokenRaw) });
    } catch (err) {
      throw new ApiError("chain_unavailable", `Couldn't prepare the transfer: ${(err as Error).message}`);
    }
    const stored = await store.setClaimTx(g.id, expected, signed.signature, signed.lastValidBlockHeight);
    if (!stored) {
      // Another request stored a transaction first; ours is discarded unsent.
      return pending(await reload(g.id));
    }
    try {
      await chain.sendClaim(signed);
    } catch {
      // Stored and retryable: a later call sees it pending, then expired, and replaces it.
      return pending(stored);
    }
    for (let i = 0; i < confirmPolls; i++) {
      const s = await statusOf(stored);
      if (s.state === "confirmed") return settleConfirmed(stored);
      if (s.state !== "pending") break;
      await sleep(confirmIntervalMs);
    }
    return pending(stored);
  }

  async function statusOf(g: GiftRecord): Promise<ClaimStatus> {
    try {
      return await chain.claimStatus(g.claimSignature!, g.claimLastValidHeight!);
    } catch {
      return { state: "pending" };
    }
  }

  /** Step 5. */
  async function progress(g: GiftRecord): Promise<ClaimResult> {
    if (!g.claimSignature) return signStoreSend(g, null);
    const s = await statusOf(g);
    switch (s.state) {
      case "confirmed":
        return settleConfirmed(g);
      case "pending":
        return pending(g);
      case "expired":
      case "failed":
        // Finalized absence or failure: nothing moved, so replace it (CAS keeps it to one caller).
        return signStoreSend(g, g.claimSignature);
    }
  }

  return {
    async create(body: unknown, clientKey: string): Promise<CreateGiftResponse> {
      const req = CreateGiftRequest.parse(body);
      if (req.opensAt && Date.parse(req.opensAt) <= now().getTime()) {
        throw new ApiError("validation_failed", "opensAt must be in the future");
      }
      if (!rateLimiter.take(clientKey)) throw new ApiError("rate_limited", "Too many gifts; try again in a minute");
      const p = await price(req.ticker);
      const m = await multiplier(req.ticker);
      const raw = usdToRaw(req.usdCents, p.usdCents, m);
      const token = newToken();
      const g = await store.insert({
        senderName: req.senderName,
        recipientName: req.recipientName,
        ticker: req.ticker,
        usdCents: req.usdCents,
        priceCents: p.usdCents,
        tokenRaw: raw.toString(),
        note: req.note ?? null,
        opensAt: req.opensAt ? new Date(req.opensAt).toISOString() : null,
        claimTokenHash: hashToken(token),
      });
      return { id: g.id, claimToken: token };
    },

    async get(id: string): Promise<PublicGift> {
      return toPublic(await load(id));
    },

    async open(id: string, token: string | null): Promise<PublicGift> {
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
      const { ticker } = SwapGiftRequest.parse(body);
      const g = await authed(id, token);
      if (g.status !== "opened") throw invalidState(`Can't swap a gift that is ${g.status}`);
      const p = await price(ticker);
      const m = await multiplier(ticker);
      const raw = usdToRaw(g.usdCents, p.usdCents, m); // same USD value
      const swapped = await store.swap(id, { ticker, priceCents: p.usdCents, tokenRaw: raw.toString() });
      if (!swapped) throw invalidState("The gift changed state; reload it");
      return toPublic(swapped);
    },

    async claim(id: string, token: string | null, body: unknown): Promise<ClaimResult> {
      const parsed = ClaimGiftRequest.safeParse(body);
      const wallet = parsed.success ? parsed.data.wallet : (body as { wallet?: unknown } | null)?.wallet;
      if (!isValidWallet(wallet)) {
        if (!parsed.success && (body == null || typeof body !== "object" || !("wallet" in body))) {
          throw new ApiError("validation_failed", "Body must be {wallet}");
        }
        throw new ApiError("invalid_wallet", "That isn't a Solana wallet address");
      }
      let g = await authed(id, token);
      if (g.status === "wrapped") throw invalidState("Open the gift before claiming it");
      if (g.status === "opened") {
        // Step 1.
        g = (await store.beginClaim(id, wallet)) ?? (await reload(id));
      }
      if (g.recipientWallet !== wallet) {
        // The first claim fixed the wallet; a different one never redirects the funds.
        throw invalidState("This gift is already being claimed to a different wallet");
      }
      if (g.status === "claimed") return claimed(g);
      return progress(g);
    },
  };
}

export type GiftService = ReturnType<typeof createGiftService>;
