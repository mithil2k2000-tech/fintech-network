import { describe, it, expect } from "vitest";
import {
  BANDS,
  RULES,
  RULES_VERSION,
  THRESHOLDS,
  assessRisk,
  levelForScore,
  type RiskSignals,
} from "../src/modules/risk/rules.js";

// The engine decides whether someone's money moves, so the rules are
// tested as rules: each one on its own, the bands, and the promise that
// the same signals always give the same answer.

const quiet: RiskSignals = {
  amountMinorUnits: 1_000,
  payeeOwnerType: "user",
  balanceMinorUnits: 50_000,
  previousPaymentsToPayee: 4,
  largestPreviousPaymentMinorUnits: 2_000,
  paymentsInLastHour: 0,
  spentInLastHourMinorUnits: 0,
  accountAgeHours: 500,
};

const signals = (overrides: Partial<RiskSignals> = {}): RiskSignals => ({
  ...quiet,
  ...overrides,
});

const fired = (s: RiskSignals) => assessRisk(s).firedRules.map((r) => r.id);

describe("assessRisk", () => {
  it("says nothing is unusual when nothing is", () => {
    const assessment = assessRisk(quiet);
    expect(assessment).toMatchObject({ level: "LOW", score: 0, evaluator: RULES_VERSION });
    expect(assessment.firedRules).toEqual([]);
    expect(assessment.reasons).toEqual(["Nothing unusual about this payment"]);
  });

  it("notices a payee you've never paid, but doesn't make a drama of it", () => {
    const assessment = assessRisk(signals({ previousPaymentsToPayee: 0 }));
    expect(assessment.firedRules.map((r) => r.id)).toEqual(["NEW_PAYEE"]);
    // One unfamiliar payee on its own is not a scam.
    expect(assessment.level).toBe("LOW");
  });

  it("treats a large payment to someone new as the pattern it is", () => {
    // Large for the network, but ordinary for this payer, so only the
    // new-payee rules fire: worth a warning, not an alarm.
    const assessment = assessRisk(
      signals({
        previousPaymentsToPayee: 0,
        amountMinorUnits: THRESHOLDS.largeAmount,
        largestPreviousPaymentMinorUnits: THRESHOLDS.largeAmount,
      })
    );
    expect(assessment.firedRules.map((r) => r.id)).toEqual(["NEW_PAYEE", "NEW_PAYEE_LARGE"]);
    expect(assessment.level).toBe("MEDIUM");

    // Large for the network *and* far beyond anything this payer has
    // sent before is a different picture, and rates HIGH.
    expect(
      assessRisk(
        signals({
          previousPaymentsToPayee: 0,
          amountMinorUnits: THRESHOLDS.largeAmount,
          largestPreviousPaymentMinorUnits: 2_000,
        })
      ).level
    ).toBe("HIGH");
  });

  it("flags emptying the account, which is what someone is told to do", () => {
    expect(fired(signals({ amountMinorUnits: 47_500, balanceMinorUnits: 50_000 })))
      .toContain("EMPTIES_BALANCE");
    // Half the balance is just a payment.
    expect(fired(signals({ amountMinorUnits: 25_000, balanceMinorUnits: 50_000 })))
      .not.toContain("EMPTIES_BALANCE");
  });

  it("flags a payment far bigger than the payer's usual", () => {
    expect(
      fired(signals({ amountMinorUnits: 9_000, largestPreviousPaymentMinorUnits: 2_000 }))
    ).toContain("UNUSUALLY_LARGE");
    // Nothing to compare against yet isn't evidence of anything.
    expect(
      fired(signals({ amountMinorUnits: 9_000, largestPreviousPaymentMinorUnits: 0 }))
    ).not.toContain("UNUSUALLY_LARGE");
    // Small payments don't count as unusual however the maths falls.
    expect(
      fired(signals({ amountMinorUnits: 400, largestPreviousPaymentMinorUnits: 100 }))
    ).not.toContain("UNUSUALLY_LARGE");
  });

  it("notices a burst of payments, and a burst of money", () => {
    expect(fired(signals({ paymentsInLastHour: THRESHOLDS.busyHourPayments })))
      .toContain("BUSY_HOUR");
    expect(fired(signals({ paymentsInLastHour: 1 }))).not.toContain("BUSY_HOUR");
    expect(fired(signals({ spentInLastHourMinorUnits: THRESHOLDS.busyHourSpend })))
      .toContain("SPEND_BURST");
  });

  it("leaves shops alone for the rules that are about knowing a person", () => {
    const shop = signals({
      payeeOwnerType: "merchant",
      previousPaymentsToPayee: 0,
      amountMinorUnits: THRESHOLDS.largeAmount,
    });
    expect(fired(shop)).not.toContain("NEW_PAYEE");
    expect(fired(shop)).not.toContain("NEW_PAYEE_LARGE");
    // But rules about the payer still apply wherever they're paying.
    expect(fired(signals({ payeeOwnerType: "merchant", paymentsInLastHour: 5 })))
      .toContain("BUSY_HOUR");
  });

  it("only rates HIGH when more than one thing looks wrong", () => {
    // The whole picture: a big payment to a stranger that empties a
    // new account.
    const worst = signals({
      previousPaymentsToPayee: 0,
      amountMinorUnits: 48_000,
      balanceMinorUnits: 50_000,
      largestPreviousPaymentMinorUnits: 1_000,
      accountAgeHours: 2,
    });
    const assessment = assessRisk(worst);
    expect(assessment.level).toBe("HIGH");
    expect(assessment.score).toBeGreaterThanOrEqual(BANDS.high);
    expect(assessment.reasons.length).toBeGreaterThan(2);
  });

  it("keeps the score inside its band, whatever fires", () => {
    const everything = signals({
      previousPaymentsToPayee: 0,
      amountMinorUnits: 100_000,
      balanceMinorUnits: 100_000,
      largestPreviousPaymentMinorUnits: 100,
      paymentsInLastHour: 20,
      spentInLastHourMinorUnits: 500_000,
      accountAgeHours: 0,
    });
    const assessment = assessRisk(everything);
    expect(assessment.score).toBeLessThanOrEqual(100);
    expect(assessment.level).toBe("HIGH");
  });

  it("puts a score in the right band, on both sides of every edge", () => {
    expect(levelForScore(BANDS.high)).toBe("HIGH");
    expect(levelForScore(BANDS.high - 1)).toBe("MEDIUM");
    expect(levelForScore(BANDS.medium)).toBe("MEDIUM");
    expect(levelForScore(BANDS.medium - 1)).toBe("LOW");
    expect(levelForScore(0)).toBe("LOW");
  });

  it("gives the same answer every time, with no clock or randomness in it", () => {
    const s = signals({ previousPaymentsToPayee: 0, amountMinorUnits: 20_000 });
    const first = assessRisk(s);
    for (let i = 0; i < 50; i += 1) expect(assessRisk(s)).toEqual(first);
  });

  it("explains itself: every rule has an id, a weight and words for a person", () => {
    const ids = new Set<string>();
    for (const rule of RULES) {
      expect(rule.id).toMatch(/^[A-Z_]+$/);
      expect(ids.has(rule.id)).toBe(false);
      ids.add(rule.id);
      expect(rule.weight).toBeGreaterThan(0);
      // The reason is shown to the payer, so it must read as English
      // and say what was noticed, not name a rule.
      expect(rule.reason).toMatch(/^[A-Z]/);
      expect(rule.reason).not.toMatch(/_/);
      expect(rule.reason.length).toBeGreaterThan(15);
    }
  });
});
