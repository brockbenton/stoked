/**
 * Fixed-window rate limiter for gift creation (each gift draws down the
 * treasury). In-memory: per server instance, which is enough for a devnet
 * demo; a shared store would be needed to enforce it across instances.
 */
export interface RateLimiter {
  /** True if allowed (and counted). */
  take(key: string): boolean;
}

export interface RateLimitOptions {
  perKey: number;
  global: number;
  windowMs: number;
  now?: () => number;
}

export function createRateLimiter({ perKey, global, windowMs, now = Date.now }: RateLimitOptions): RateLimiter {
  let windowStart = now();
  let total = 0;
  const counts = new Map<string, number>();
  return {
    take(key) {
      const t = now();
      if (t - windowStart >= windowMs) {
        windowStart = t;
        total = 0;
        counts.clear();
      }
      const n = counts.get(key) ?? 0;
      if (n >= perKey || total >= global) return false;
      counts.set(key, n + 1);
      total += 1;
      return true;
    },
  };
}
