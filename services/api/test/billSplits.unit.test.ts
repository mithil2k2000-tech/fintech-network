import { describe, it, expect } from "vitest";
import {
  MAX_SPLIT_PARTS,
  SplitMathError,
  checkCustomShares,
  shareOut,
  splitEvenly,
} from "../src/modules/billSplits/shares.js";
import { effectiveSplitStatus } from "../src/modules/billSplits/index.js";

// The arithmetic of a split is the one place a rounding habit could
// quietly lose or invent money, so it gets checked hard.

describe("splitEvenly", () => {
  it("splits a clean total into equal shares", () => {
    expect(splitEvenly(6_000, 4)).toEqual([1_500, 1_500, 1_500, 1_500]);
  });

  it("gives the odd pennies to the earliest shares, and loses none", () => {
    expect(splitEvenly(1_000, 3)).toEqual([334, 333, 333]);
    expect(splitEvenly(1_001, 3)).toEqual([334, 334, 333]);
    expect(splitEvenly(10, 4)).toEqual([3, 3, 2, 2]);
  });

  it("always adds back up to the total, for every total and party size", () => {
    for (let people = 2; people <= MAX_SPLIT_PARTS; people += 1) {
      for (const total of [people, 1, 7, 99, 100, 101, 1_234, 99_999, 1_000_000]) {
        if (total < people) continue;
        const shares = splitEvenly(total, people);
        expect(shares).toHaveLength(people);
        expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
        for (const share of shares) {
          expect(Number.isSafeInteger(share)).toBe(true);
          expect(share).toBeGreaterThan(0);
        }
        // Nobody is more than a penny worse off than anybody else.
        expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
      }
    }
  });

  it("is the same every time it's asked", () => {
    expect(splitEvenly(4_999, 7)).toEqual(splitEvenly(4_999, 7));
  });

  it.each([
    ["a fractional total", 10.5, 2, "INVALID_AMOUNT"],
    ["a zero total", 0, 2, "INVALID_AMOUNT"],
    ["a negative total", -100, 2, "INVALID_AMOUNT"],
    ["one person", 100, 1, "TOO_FEW_PARTS"],
    ["more people than allowed", 10_000, MAX_SPLIT_PARTS + 1, "TOO_MANY_PARTS"],
    ["a total too small to share", 2, 3, "TOTAL_TOO_SMALL"],
  ])("refuses %s", (_label, total, people, code) => {
    try {
      splitEvenly(total, people);
      throw new Error("expected it to be refused");
    } catch (err) {
      expect(err).toBeInstanceOf(SplitMathError);
      expect((err as SplitMathError).code).toBe(code);
    }
  });
});

describe("checkCustomShares", () => {
  it("accepts amounts that add up exactly", () => {
    expect(checkCustomShares(5_000, [2_000, 1_500, 1_500])).toEqual([2_000, 1_500, 1_500]);
  });

  it("refuses amounts that are a penny out, either way", () => {
    expect(() => checkCustomShares(5_000, [2_000, 1_500, 1_499])).toThrow(/add up/);
    expect(() => checkCustomShares(5_000, [2_000, 1_500, 1_501])).toThrow(/add up/);
  });

  it("refuses a share of zero, a negative share or a fractional one", () => {
    expect(() => checkCustomShares(3_000, [3_000, 0])).toThrow(/above zero/);
    expect(() => checkCustomShares(3_000, [4_000, -1_000])).toThrow(/above zero/);
    expect(() => checkCustomShares(3_000, [1_500.5, 1_499.5])).toThrow(/whole number/);
  });
});

describe("shareOut", () => {
  it("splits evenly when no amounts are given", () => {
    expect(shareOut(900, 3)).toEqual([300, 300, 300]);
  });

  it("uses the amounts given when they're there", () => {
    expect(shareOut(900, 3, [500, 300, 100])).toEqual([500, 300, 100]);
  });

  it("refuses a list that doesn't cover everyone", () => {
    expect(() => shareOut(900, 3, [500, 400])).toThrow(/everyone in the split/);
  });
});

describe("effectiveSplitStatus", () => {
  const open = { status: "OPEN" } as const;
  const cancelled = { status: "CANCELLED" } as const;

  it("is settled once nobody still owes anything", () => {
    expect(effectiveSplitStatus(open, [{ status: "PAID" }, { status: "PAID" }])).toBe("SETTLED");
    // Declined and expired are answers too — the split is finished with.
    expect(effectiveSplitStatus(open, [{ status: "PAID" }, { status: "DECLINED" }])).toBe("SETTLED");
    expect(effectiveSplitStatus(open, [{ status: "EXPIRED" }])).toBe("SETTLED");
  });

  it("stays open while anyone hasn't answered", () => {
    expect(effectiveSplitStatus(open, [{ status: "PAID" }, { status: "OPEN" }])).toBe("OPEN");
  });

  it("stays cancelled whatever the shares say", () => {
    expect(effectiveSplitStatus(cancelled, [{ status: "PAID" }])).toBe("CANCELLED");
  });
});
