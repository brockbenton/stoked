import { describe, expect, it } from "vitest";
import {
  displayShares,
  effectiveMultiplier,
  formatShares,
  formatUnits,
  formatUsd,
  parseMultiplier,
  rawToShownUnits,
  rawToUsdCents,
  usdToRaw,
} from "../src/money";

describe("reference case: $10.00 at $229.52", () => {
  it("shows 0.0436 shares at multiplier 1", () => {
    const raw = usdToRaw(1000, 22952, "1");
    expect(raw).toBe(4356918n);
    expect(formatUnits(rawToShownUnits(raw, "1"))).toBe("0.04356918");
    expect(displayShares(raw, "1")).toBe("0.0436");
  });

  it("still shows 0.0436 when wrapped under multiplier 1.002 (raw shrinks to compensate)", () => {
    const raw = usdToRaw(1000, 22952, "1.002");
    // 10^11 / (22952 × 1.002) = 4348222.34… → floor
    expect(raw).toBe(4348222n);
    // 4348222 × 1.002 = 4356918.44… → floor
    expect(rawToShownUnits(raw, "1.002")).toBe(4356918n);
    expect(displayShares(raw, "1.002")).toBe("0.0436");
  });

  it("the same raw balance shows more after the multiplier rises to 1.002 (a dividend)", () => {
    const raw = usdToRaw(1000, 22952, "1");
    // 4356918 × 1.002 = 4365631.836 → floor
    expect(rawToShownUnits(raw, "1.002")).toBe(4365631n);
    expect(displayShares(raw, "1.002")).toBe("0.0437");
    expect(rawToUsdCents(raw, 22952, "1")).toBe(1000);
    expect(rawToUsdCents(raw, 22952, "1.002")).toBe(1002);
  });
});

describe("rounding down", () => {
  it("floors raw units instead of rounding to nearest", () => {
    // exact quotient 4356918.787… would round to …919
    expect(usdToRaw(1000, 22952)).toBe(4356918n);
    // $1.00 at $3.00 = 0.333… shares → 33333333 raw, never 33333334
    expect(usdToRaw(100, 300)).toBe(33333333n);
    // $2.00 at $3.00 = 0.666… → floor, not 66666667
    expect(usdToRaw(200, 300)).toBe(66666666n);
  });

  it("floors the shown amount", () => {
    expect(rawToShownUnits(66666666n, "1.5")).toBe(99999999n);
    expect(rawToShownUnits(3n, "0.5")).toBe(1n);
  });

  it("floors the current value in cents", () => {
    expect(rawToUsdCents(33333333n, 300)).toBe(100);
  });

  it("exact divisions are unchanged", () => {
    expect(usdToRaw(1000, 1000)).toBe(100_000_000n);
    expect(displayShares(100_000_000n)).toBe("1.0000");
  });
});

describe("scheduled multiplier", () => {
  const schedule = { multiplier: "1", newMultiplier: "1.002", newMultiplierEffectiveTimestamp: 1_764_000_000 };

  it("uses the current multiplier before the effective timestamp", () => {
    expect(effectiveMultiplier(schedule, 1_763_999_999)).toEqual({ num: 1n, den: 1n });
  });

  it("uses the new multiplier at and after the effective timestamp", () => {
    expect(effectiveMultiplier(schedule, 1_764_000_000)).toEqual({ num: 1002n, den: 1000n });
    expect(effectiveMultiplier(schedule, 1_764_000_001n)).toEqual({ num: 1002n, den: 1000n });
  });

  it("changes the shown balance across the timestamp while raw is unchanged", () => {
    const raw = 4356918n;
    expect(displayShares(raw, effectiveMultiplier(schedule, 1_763_999_999))).toBe("0.0436");
    expect(displayShares(raw, effectiveMultiplier(schedule, 1_764_000_000))).toBe("0.0437");
  });

  it("ignores a missing schedule", () => {
    expect(effectiveMultiplier({ multiplier: 1, newMultiplier: null, newMultiplierEffectiveTimestamp: null }, 0)).toEqual({ num: 1n, den: 1n });
  });
});

describe("parsing and formatting", () => {
  it("parses decimal strings and f64 numbers exactly", () => {
    expect(parseMultiplier("1.002")).toEqual({ num: 1002n, den: 1000n });
    expect(parseMultiplier(1.002)).toEqual({ num: 1002n, den: 1000n });
    expect(parseMultiplier(1)).toEqual({ num: 1n, den: 1n });
    expect(parseMultiplier(1e-7)).toEqual({ num: 1n, den: 10_000_000n });
  });

  it("rejects bad multipliers", () => {
    for (const bad of ["0", "-1", "1e3", "abc", "", 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => parseMultiplier(bad)).toThrow(RangeError);
    }
  });

  it("rejects non-integer money", () => {
    expect(() => usdToRaw(10.5, 22952)).toThrow(RangeError);
    expect(() => usdToRaw(1000, 0)).toThrow(RangeError);
    expect(() => formatUsd(1.5)).toThrow(RangeError);
  });

  it("formats shares and dollars", () => {
    expect(formatShares(4349999n)).toBe("0.0435");
    expect(formatShares(4350000n)).toBe("0.0435");
    expect(formatShares(4355000n)).toBe("0.0436");
    expect(formatShares(123_456_789n, 2)).toBe("1.23");
    expect(formatUsd(1000)).toBe("$10.00");
    expect(formatUsd(5)).toBe("$0.05");
    expect(formatUsd(1234567)).toBe("$12,345.67");
  });
});
