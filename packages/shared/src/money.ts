/**
 * Money and Scaled UI Amount math. All arithmetic is integer (bigint): no floats.
 *
 *   shares = usdCents / priceCents
 *   raw    = floor(shares / multiplier × 10^8)       stored and transferred
 *   shown  = floor(raw × effective multiplier)        in 10^-8 share units
 *
 * Every amount rounds down, so we never transfer or show more than was paid
 * for. Only the final display string (formatShares) rounds to the nearest
 * 4th decimal, and the UI prefixes it with "≈".
 */

export const TOKEN_DECIMALS = 8;
const SCALE = 10n ** BigInt(TOKEN_DECIMALS);

/** Exact rational number num / den, with den > 0. */
export interface Ratio {
  num: bigint;
  den: bigint;
}

export type MultiplierInput = Ratio | string | number;

const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parse a positive decimal multiplier ("1", "1.002", or a number such as the
 * f64 Token-2022 stores) into an exact ratio.
 */
export function parseMultiplier(value: string | number): Ratio {
  let text: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new RangeError(`invalid multiplier: ${value}`);
    text = value.toString();
    if (text.includes("e")) text = value.toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
  } else {
    text = value.trim();
  }
  const m = DECIMAL_RE.exec(text);
  if (!m) throw new RangeError(`invalid multiplier: ${String(value)}`);
  const frac = m[2] ?? "";
  const num = BigInt((m[1] ?? "") + frac);
  const den = 10n ** BigInt(frac.length);
  if (num <= 0n) throw new RangeError(`multiplier must be positive: ${String(value)}`);
  return { num, den };
}

function toRatio(m: MultiplierInput): Ratio {
  return typeof m === "object" ? m : parseMultiplier(m);
}

/** Token-2022 Scaled UI Amount config as read from a mint. Timestamps are unix seconds. */
export interface MultiplierSchedule {
  multiplier: string | number;
  newMultiplier?: string | number | null;
  newMultiplierEffectiveTimestamp?: number | bigint | null;
}

/**
 * The multiplier in force at `nowSeconds`. A scheduled multiplier applies only
 * from its effective timestamp (inclusive), as in the Token-2022 extension.
 */
export function effectiveMultiplier(schedule: MultiplierSchedule, nowSeconds: number | bigint): Ratio {
  const { newMultiplier, newMultiplierEffectiveTimestamp: ts } = schedule;
  if (newMultiplier != null && ts != null && BigInt(nowSeconds) >= BigInt(ts)) {
    return parseMultiplier(newMultiplier);
  }
  return parseMultiplier(schedule.multiplier);
}

function assertPositiveInt(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
}

/** Raw token units to transfer for `usdCents` at `priceCents` under `multiplier`. Rounds down. */
export function usdToRaw(usdCents: number, priceCents: number, multiplier: MultiplierInput = "1"): bigint {
  assertPositiveInt("usdCents", usdCents);
  assertPositiveInt("priceCents", priceCents);
  const m = toRatio(multiplier);
  return (BigInt(usdCents) * SCALE * m.den) / (BigInt(priceCents) * m.num);
}

/** Shown amount in 10^-8 share units: floor(raw × multiplier). */
export function rawToShownUnits(raw: bigint, multiplier: MultiplierInput = "1"): bigint {
  if (raw < 0n) throw new RangeError("raw must be non-negative");
  const m = toRatio(multiplier);
  return (raw * m.num) / m.den;
}

/** Units as an exact decimal string, e.g. 4356918n → "0.04356918". */
export function formatUnits(units: bigint, decimals = TOKEN_DECIMALS): string {
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  if (decimals === 0) return whole.toString();
  const frac = (units % scale).toString().padStart(decimals, "0");
  return `${whole}.${frac}`;
}

/** Display string for shown units, rounded half-up to `places` decimals (default 4): "0.0436". */
export function formatShares(shownUnits: bigint, places = 4): string {
  if (!Number.isInteger(places) || places < 0 || places > TOKEN_DECIMALS) throw new RangeError("invalid places");
  const step = 10n ** BigInt(TOKEN_DECIMALS - places);
  const rounded = (shownUnits + step / 2n) / step;
  return formatUnits(rounded, places);
}

/** Raw → display shares under a multiplier. */
export function displayShares(raw: bigint, multiplier: MultiplierInput = "1", places = 4): string {
  return formatShares(rawToShownUnits(raw, multiplier), places);
}

/** Current value in cents of a raw balance: floor(shown × price). */
export function rawToUsdCents(raw: bigint, priceCents: number, multiplier: MultiplierInput = "1"): number {
  assertPositiveInt("priceCents", priceCents);
  return Number((rawToShownUnits(raw, multiplier) * BigInt(priceCents)) / SCALE);
}

/** 1000 → "$10.00". Integer cents only. */
export function formatUsd(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`cents must be an integer, got ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100).toLocaleString("en-US");
  return `${sign}$${dollars}.${String(abs % 100).padStart(2, "0")}`;
}
