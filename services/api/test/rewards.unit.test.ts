import { describe, it, expect } from "vitest";
import { CASHBACK_V1, cashbackFor, type CashbackRule } from "../src/modules/rewards/rules.js";

// Cashback is money, so the rule gets the same treatment as the split
// maths: exact pence, no floats, and a sweep proving it never invents a
// penny or promises more than the cap.

const shopPayment = (amountMinorUnits: number) =>
  ({ amountMinorUnits, payeeOwnerType: "merchant" }) as const;

describe("cashbackFor", () => {
  it("gives 1% back on paying a shop", () => {
    expect(cashbackFor(shopPayment(1_000))?.amountMinorUnits).toBe(10);
    expect(cashbackFor(shopPayment(4_50))?.amountMinorUnits).toBe(4);
    expect(cashbackFor(shopPayment(12_345))?.amountMinorUnits).toBe(123);
  });

  it("rounds down, never up — the reserve owes only what the rule promised", () => {
    // 1% of 199p is 1.99p. That's 1p, not 2p.
    expect(cashbackFor(shopPayment(199))?.amountMinorUnits).toBe(1);
    expect(cashbackFor(shopPayment(299))?.amountMinorUnits).toBe(2);
    expect(cashbackFor(shopPayment(100))?.amountMinorUnits).toBe(1);
  });

  it("pays nothing below the minimum spend, rather than nothing-shaped cashback", () => {
    expect(cashbackFor(shopPayment(99))).toBeNull();
    expect(cashbackFor(shopPayment(1))).toBeNull();
    expect(cashbackFor(shopPayment(100))).not.toBeNull();
  });

  it("stops at the cap however big the payment", () => {
    expect(cashbackFor(shopPayment(50_000))?.amountMinorUnits).toBe(500);
    expect(cashbackFor(shopPayment(1_000_000))?.amountMinorUnits).toBe(500);
  });

  it("earns nothing on paying a person", () => {
    expect(cashbackFor({ amountMinorUnits: 10_000, payeeOwnerType: "user" })).toBeNull();
  });

  it.each([
    ["a fractional amount", 10.5],
    ["zero", 0],
    ["a negative amount", -5_000],
  ])("refuses %s", (_label, amount) => {
    expect(cashbackFor(shopPayment(amount))).toBeNull();
  });

  it("never pays more than the spend, or more than the cap, at any amount", () => {
    for (let amount = 1; amount <= 100_000; amount += 97) {
      const award = cashbackFor(shopPayment(amount));
      if (!award) continue;
      expect(Number.isSafeInteger(award.amountMinorUnits)).toBe(true);
      expect(award.amountMinorUnits).toBeGreaterThan(0);
      expect(award.amountMinorUnits).toBeLessThanOrEqual(amount);
      expect(award.amountMinorUnits).toBeLessThanOrEqual(CASHBACK_V1.maximumAwardMinorUnits);
    }
  });

  it("records which rule decided, so a later rate can't rewrite the past", () => {
    const award = cashbackFor(shopPayment(1_000));
    expect(award).toMatchObject({ rule: "cashback-v1", rateBasisPoints: 100 });

    const generous: CashbackRule = {
      version: "cashback-test-5pc",
      rateBasisPoints: 500,
      minimumSpendMinorUnits: 100,
      maximumAwardMinorUnits: 10_000,
    };
    expect(cashbackFor(shopPayment(1_000), generous)).toMatchObject({
      amountMinorUnits: 50,
      rule: "cashback-test-5pc",
      rateBasisPoints: 500,
    });
  });

  it("is the same answer every time it's asked", () => {
    expect(cashbackFor(shopPayment(7_777))).toEqual(cashbackFor(shopPayment(7_777)));
  });
});
