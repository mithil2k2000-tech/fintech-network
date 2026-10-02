// The risk rules. Pure functions over a set of signals: same signals
// in, same answer out, every time.
//
// Three commitments this file exists to keep (spec §12):
//
//  1. **Deterministic.** No randomness, no clock, no network, no model.
//     A decision can be reproduced from the signals stored with it.
//  2. **Auditable.** Every rule has a name and a weight, and what fired
//     is recorded. "The system said so" is not an explanation.
//  3. **Never an LLM.** Nothing behind this interface may be a language
//     model. A model cannot be held to a rule, cannot be reproduced,
//     and cannot be explained to someone whose payment it stopped.
//
// The rules encode how authorised-push-payment scams actually look:
// someone is talked into sending a large sum to a person they have
// never paid, often quickly, often emptying the account. None of that
// is proof of a scam — which is why a HIGH rating warns and asks for
// confirmation rather than blocking. Stopping a person from moving
// their own money is also a harm.
import type { MinorUnits, RiskLevel } from "@fintech-network/shared-types";

export const RULES_VERSION = "rules-v1";

/** What the engine judges. Gathered from the payer's own history. */
export interface RiskSignals {
  amountMinorUnits: MinorUnits;
  payeeOwnerType: "user" | "merchant";
  /** The payer's balance before this payment. */
  balanceMinorUnits: MinorUnits;
  /** Completed payments this payer has already made to this payee. */
  previousPaymentsToPayee: number;
  /** The largest the payer has ever sent, 0 if they never have. */
  largestPreviousPaymentMinorUnits: MinorUnits;
  /** Payments started in the hour before this one. */
  paymentsInLastHour: number;
  /** Total already sent in that hour. */
  spentInLastHourMinorUnits: MinorUnits;
  /** How long the payer has had an account. */
  accountAgeHours: number;
}

export interface FiredRule {
  id: string;
  weight: number;
  reason: string;
}

export interface RiskAssessment {
  level: RiskLevel;
  score: number;
  firedRules: FiredRule[];
  /** What the payer is told, in plain words. */
  reasons: string[];
  evaluator: string;
}

interface Rule {
  id: string;
  weight: number;
  /** Shown to the payer, so it says what was noticed, not what to do. */
  reason: string;
  applies: (s: RiskSignals) => boolean;
}

const POUND = 100;

/**
 * Thresholds in one place. They are blunt on purpose: a prototype has
 * no population to calibrate against, and a rule someone can read and
 * argue with beats a number nobody can account for.
 */
export const THRESHOLDS = {
  /** Below this, an unusual-looking payment isn't worth a warning. */
  notableAmount: 50 * POUND,
  largeAmount: 100 * POUND,
  /** "Much larger than usual" means this many times their biggest so far. */
  unusualMultiple: 3,
  /** Using this share of the balance counts as emptying the account. */
  balanceShareNumerator: 9,
  balanceShareDenominator: 10,
  busyHourPayments: 3,
  busyHourSpend: 250 * POUND,
  newAccountHours: 24,
} as const;

/**
 * Rules that only make sense for paying a person: a shop is a
 * registered payee that can be found again, and paying one for the
 * first time is what shopping is.
 */
const isPerson = (s: RiskSignals) => s.payeeOwnerType === "user";
const isNewPayee = (s: RiskSignals) => isPerson(s) && s.previousPaymentsToPayee === 0;

export const RULES: readonly Rule[] = [
  {
    id: "NEW_PAYEE",
    weight: 15,
    reason: "You haven't paid this person before",
    applies: isNewPayee,
  },
  {
    id: "NEW_PAYEE_LARGE",
    weight: 30,
    reason: "This is a large payment to someone you haven't paid before",
    applies: (s) => isNewPayee(s) && s.amountMinorUnits >= THRESHOLDS.largeAmount,
  },
  {
    id: "UNUSUALLY_LARGE",
    weight: 20,
    reason: "This is much larger than payments you usually make",
    applies: (s) =>
      s.amountMinorUnits >= THRESHOLDS.notableAmount &&
      s.largestPreviousPaymentMinorUnits > 0 &&
      s.amountMinorUnits >= s.largestPreviousPaymentMinorUnits * THRESHOLDS.unusualMultiple,
  },
  {
    id: "EMPTIES_BALANCE",
    weight: 25,
    // A classic pressure tactic: "send everything you have".
    reason: "This would use almost everything in your account",
    applies: (s) =>
      s.amountMinorUnits >= THRESHOLDS.notableAmount &&
      s.balanceMinorUnits > 0 &&
      s.amountMinorUnits * THRESHOLDS.balanceShareDenominator >=
        s.balanceMinorUnits * THRESHOLDS.balanceShareNumerator,
  },
  {
    id: "BUSY_HOUR",
    weight: 20,
    reason: "You've made several payments in the last hour",
    applies: (s) => s.paymentsInLastHour >= THRESHOLDS.busyHourPayments,
  },
  {
    id: "SPEND_BURST",
    weight: 15,
    reason: "You've sent an unusual amount in the last hour",
    applies: (s) => s.spentInLastHourMinorUnits >= THRESHOLDS.busyHourSpend,
  },
  {
    id: "NEW_ACCOUNT_LARGE",
    weight: 15,
    reason: "This account is new and this is a large payment",
    applies: (s) =>
      s.accountAgeHours < THRESHOLDS.newAccountHours &&
      s.amountMinorUnits >= THRESHOLDS.largeAmount,
  },
] as const;

/** Where the bands sit. HIGH needs more than one thing to look wrong. */
export const BANDS = { high: 60, medium: 25 } as const;

export function levelForScore(score: number): RiskLevel {
  if (score >= BANDS.high) return "HIGH";
  if (score >= BANDS.medium) return "MEDIUM";
  return "LOW";
}

/**
 * Runs every rule and adds up what fired. Integer arithmetic, capped at
 * 100 so the score stays a readable number rather than growing without
 * limit as rules are added.
 */
export function assessRisk(signals: RiskSignals): RiskAssessment {
  const firedRules: FiredRule[] = RULES.filter((rule) => rule.applies(signals)).map(
    ({ id, weight, reason }) => ({ id, weight, reason })
  );
  const score = Math.min(
    100,
    firedRules.reduce((total, rule) => total + rule.weight, 0)
  );
  const level = levelForScore(score);

  return {
    level,
    score,
    firedRules,
    // Nothing fired: say so plainly rather than inventing reassurance.
    reasons:
      firedRules.length > 0
        ? firedRules.map((rule) => rule.reason)
        : ["Nothing unusual about this payment"],
    evaluator: RULES_VERSION,
  };
}
