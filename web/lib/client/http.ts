/** GiftClient over the real /api routes (docs/build-plan.md § API). */
import { ApiError, ClaimGiftResponse, CreateGiftResponse, PublicGift, WalletResponse } from "@stoked/shared";
import { GiftClientError, type GiftClient } from "./types";

const TIMEOUT_MS = 20_000;

export interface HttpClientOptions {
  fetch?: typeof fetch;
  isOffline?: () => boolean;
}

interface Schema<T> {
  parse(v: unknown): T;
}

export function createHttpClient(opts: HttpClientOptions = {}): GiftClient {
  const isOffline = opts.isOffline ?? (() => typeof navigator !== "undefined" && navigator.onLine === false);

  async function request<T>(path: string, schema: Schema<T>, init: { token?: string; body?: unknown; post?: boolean } = {}) {
    const headers: Record<string, string> = {};
    // The claim token only ever travels in this header: never in a URL or body.
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    let json: unknown;
    try {
      res = await (opts.fetch ?? fetch)(path, {
        method: init.post ? "POST" : "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      json = await res.json();
    } catch {
      throw isOffline()
        ? new GiftClientError("offline", "You're offline")
        : new GiftClientError("internal", "Couldn't reach Stoked");
    }
    if (!res.ok) {
      const error = ApiError.safeParse(json);
      throw error.success
        ? new GiftClientError(error.data.error.code, error.data.error.message)
        : new GiftClientError("internal", `Request failed (${res.status})`);
    }
    try {
      return schema.parse(json);
    } catch {
      throw new GiftClientError("internal", "Unexpected response from Stoked");
    }
  }

  const giftPath = (id: string, action = "") => `/api/gifts/${encodeURIComponent(id)}${action}`;

  return {
    createGift: (req) => request("/api/gifts", CreateGiftResponse, { post: true, body: req }),
    getGift: (id) => request(giftPath(id), PublicGift),
    openGift: (id, token) => request(giftPath(id, "/open"), PublicGift, { post: true, token }),
    swapGift: (id, token, ticker) => request(giftPath(id, "/swap"), PublicGift, { post: true, token, body: { ticker } }),
    claimGift: (id, token, wallet) =>
      request(giftPath(id, "/claim"), ClaimGiftResponse, { post: true, token, body: { wallet } }),
    getWallet: (address) => request(`/api/wallets/${encodeURIComponent(address)}`, WalletResponse),
  };
}
