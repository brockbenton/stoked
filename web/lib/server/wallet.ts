/** Read-only balances for the wallet page. Public chain data: no auth, but rate-limited (it costs RPC calls). */
import {
  TICKERS,
  WalletResponse,
  displayShares,
  effectiveMultiplier,
  formatUnits,
  rawToShownUnits,
  type MultiplierSchedule,
  type Ticker,
  type TokenHolding,
} from "@stoked/shared";
import { ApiError } from "./errors";
import type { RateLimiter } from "./rate-limit";
import { isValidWallet, ratioToDecimal } from "./service";

export interface WalletDeps {
  rawHoldings(wallet: string): Promise<Partial<Record<Ticker, bigint>>>;
  multiplierSchedule(ticker: Ticker): Promise<MultiplierSchedule>;
  rateLimiter: RateLimiter;
  now?: () => Date;
}

export function createWalletService(deps: WalletDeps) {
  const now = deps.now ?? (() => new Date());
  return {
    async holdings(wallet: string, clientKey: string): Promise<WalletResponse> {
      if (!isValidWallet(wallet)) throw new ApiError("invalid_wallet", "That isn't a Solana wallet address");
      if (!deps.rateLimiter.take(clientKey)) throw new ApiError("rate_limited", "Too many requests; try again in a minute");
      try {
        const raw = await deps.rawHoldings(wallet);
        const seconds = Math.floor(now().getTime() / 1000);
        const holdings = await Promise.all(
          TICKERS.filter((t) => raw[t] !== undefined).map(async (ticker): Promise<TokenHolding> => {
            const m = effectiveMultiplier(await deps.multiplierSchedule(ticker), seconds);
            const amount = raw[ticker]!;
            return {
              ticker,
              tokenRaw: amount.toString(),
              multiplier: ratioToDecimal(m),
              shares: displayShares(amount, m),
              sharesExact: formatUnits(rawToShownUnits(amount, m)),
            };
          }),
        );
        return WalletResponse.parse({ wallet, holdings });
      } catch (err) {
        const e = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        console.error(`[stoked] wallet read failed: ${e.slice(0, 500)}`);
        throw new ApiError("chain_unavailable", "Couldn't reach Solana; try again shortly");
      }
    },
  };
}

export type WalletService = ReturnType<typeof createWalletService>;
