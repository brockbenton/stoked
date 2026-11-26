/**
 * In-memory GiftClient over @stoked/shared fixtures. Nothing touches a
 * server or chain. `sim` flags let tests and screenshots reach states the
 * happy path doesn't: a failed claim, being offline, slow loading.
 */
import {
  FIXTURE_SIGNATURE,
  FIXTURE_WALLET,
  displayShares,
  fixtureValue,
  fixtures,
  formatUnits,
  rawToShownUnits,
  usdToRaw,
  type ClaimGiftResponse,
  type CreateGiftRequest,
  type PublicGift,
  type Ticker,
  DEMO_PRICES_CENTS,
} from "@stoked/shared";
import { GiftClientError, type GiftClient, type WalletSource } from "./types";

/**
 * claim-fail: claim is rejected and nothing changes. claim-moved: the claim
 * request errors *after* the server moved the gift to claiming (e.g. a
 * timeout). swap-fail: swap errors. claim-stuck: a pending claim never lands.
 */
export type Sim = "claim-fail" | "claim-moved" | "swap-fail" | "offline" | "slow" | "claim-stuck";
const ALL_SIMS: Sim[] = ["claim-fail", "claim-moved", "swap-fail", "offline", "slow", "claim-stuck"];

export interface FixtureClientOptions {
  sim?: ReadonlySet<Sim>;
  /** Simulated network latency in ms. */
  latencyMs?: number;
  now?: () => number;
}

interface Secret {
  ticker: Ticker;
  usdCents: number;
  note: string | null;
}

interface Entry {
  gift: PublicGift;
  /** What's inside, kept server-side until opened. */
  secret: Secret;
  claimPolls: number;
}

const DEFAULT_SECRET: Secret = {
  ticker: fixtures.opened.status === "opened" ? fixtures.opened.ticker : "tNVDA",
  usdCents: 1000,
  note: fixtures.opened.status === "opened" ? fixtures.opened.note : null,
};

function clone<T>(v: T): T {
  return structuredClone(v);
}

function secretOf(g: PublicGift): Secret {
  return g.status === "wrapped" ? DEFAULT_SECRET : { ticker: g.ticker, usdCents: g.usdCents, note: g.note };
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createFixtureClient(opts: FixtureClientOptions = {}): GiftClient {
  const sim = opts.sim ?? new Set<Sim>();
  const latency = sim.has("slow") ? 60_000 : (opts.latencyMs ?? 250);
  const now = opts.now ?? Date.now;
  const store = new Map<string, Entry>(
    Object.values(fixtures).map((g) => [g.id, { gift: clone(g), secret: secretOf(g), claimPolls: 0 }]),
  );

  async function respond<T>(fn: () => T): Promise<T> {
    await new Promise((r) => setTimeout(r, latency));
    if (sim.has("offline")) throw new GiftClientError("offline", "You're offline");
    return clone(fn());
  }

  function entry(id: string): Entry {
    const e = store.get(id);
    if (!e) throw new GiftClientError("not_found", "No gift with that id");
    return e;
  }

  function auth(token: string) {
    if (!token) throw new GiftClientError("unauthorized", "Missing claim token");
  }

  /** A pending claim lands after a couple of polls (unless stuck). */
  function advanceClaim(e: Entry) {
    if (e.gift.status !== "claiming" || sim.has("claim-stuck")) return;
    e.claimPolls += 1;
    if (e.claimPolls >= 2) {
      e.gift = {
        ...e.gift,
        status: "claimed",
        claimSignature: FIXTURE_SIGNATURE,
        claimedAt: new Date(now()).toISOString(),
      };
    }
  }

  return {
    createGift: (req: CreateGiftRequest) =>
      respond(() => {
        const id = crypto.randomUUID();
        const gift: PublicGift = {
          id,
          status: "wrapped",
          senderName: req.senderName,
          recipientName: req.recipientName,
          opensAt: req.opensAt ?? null,
          createdAt: new Date(now()).toISOString(),
        };
        store.set(id, {
          gift,
          secret: { ticker: req.ticker, usdCents: req.usdCents, note: req.note ?? null },
          claimPolls: 0,
        });
        return { id, claimToken: randomToken() };
      }),

    getGift: (id) =>
      respond(() => {
        const e = entry(id);
        advanceClaim(e);
        return e.gift;
      }),

    openGift: (id, token) =>
      respond(() => {
        auth(token);
        const e = entry(id);
        const g = e.gift;
        if (g.status !== "wrapped") throw new GiftClientError("invalid_state", "Already opened");
        if (g.opensAt && Date.parse(g.opensAt) > now()) throw new GiftClientError("too_early", "Not yet");
        const { tokenRaw, value } = fixtureValue(e.secret.ticker, e.secret.usdCents);
        e.gift = {
          ...g,
          status: "opened",
          ticker: e.secret.ticker,
          usdCents: e.secret.usdCents,
          note: e.secret.note,
          tokenRaw,
          openedAt: new Date(now()).toISOString(),
          value,
        };
        return e.gift;
      }),

    swapGift: (id, token, ticker) =>
      respond(() => {
        auth(token);
        const e = entry(id);
        const g = e.gift;
        if (g.status !== "opened") throw new GiftClientError("invalid_state", "Only an opened gift can be swapped");
        if (sim.has("swap-fail")) throw new GiftClientError("internal", "Swap failed");
        const { tokenRaw, value } = fixtureValue(ticker, g.usdCents);
        e.secret = { ...e.secret, ticker };
        e.gift = { ...g, ticker, tokenRaw, value };
        return e.gift;
      }),

    claimGift: (id, token, wallet) =>
      respond((): ClaimGiftResponse => {
        auth(token);
        const e = entry(id);
        const g = e.gift;
        if (sim.has("claim-fail")) {
          throw new GiftClientError("chain_unavailable", "Devnet didn't accept the transfer");
        }
        if (g.status === "opened") {
          e.gift = { ...g, status: "claiming", recipientWallet: wallet, claimSignature: FIXTURE_SIGNATURE };
          if (sim.has("claim-moved")) throw new GiftClientError("internal", "Timed out after starting the claim");
          return { status: "pending", signature: FIXTURE_SIGNATURE, gift: e.gift };
        }
        if (g.status === "claiming") {
          advanceClaim(e);
          const cur = e.gift;
          return cur.status === "claimed"
            ? { status: "claimed", signature: cur.claimSignature, gift: cur }
            : { status: "pending", signature: g.claimSignature, gift: cur };
        }
        if (g.status === "claimed") return { status: "claimed", signature: g.claimSignature, gift: g };
        throw new GiftClientError("invalid_state", "Open the gift first");
      }),

    getWallet: (address) =>
      respond(() => {
        const one = { num: 1n, den: 1n };
        const raw = usdToRaw(1000, DEMO_PRICES_CENTS.tNVDA, one);
        return {
          wallet: address,
          holdings: [
            {
              ticker: "tNVDA" as const,
              tokenRaw: raw.toString(),
              multiplier: "1",
              shares: displayShares(raw, one),
              sharesExact: formatUnits(rawToShownUnits(raw, one)),
            },
          ],
        };
      }),
  };
}

/** Fixed placeholder wallet for UI tests. */
export const fixtureWallet: WalletSource = {
  getAddress: async () => FIXTURE_WALLET,
  peekAddress: async () => FIXTURE_WALLET,
};

export function parseSim(search: string): Set<Sim> {
  const values = new URLSearchParams(search).getAll("sim").flatMap((v) => v.split(","));
  return new Set(ALL_SIMS.filter((s) => values.includes(s)));
}
