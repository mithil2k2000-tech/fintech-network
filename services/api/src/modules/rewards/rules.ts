// What cashback someone earns, and why. Pure functions, whole pence, no
// database and no floating point — so the answer can be read, argued
// with and tested on its own.
//
// Deterministic on purpose (spec §26): the same payment always earns the
// same amount, and nothing about the reward is decided by a model. A
// rule has a version, and a grant records the version that made it, so
// changing the rate later can never quietly rewrite what someone was
// already given.
import type { MinorUnits } from "@fintech-network/shared-types";

export interface CashbackRule {
  /** Written into every grant made under it. */
  version: string;
  /** 100 = 1%. Basis points, so the rate is a whole number too. */
  rateBasisPoints: number;
  /** Nothing below this earns anything, so a 1p payment isn't gamed. */
  minimumSpendMinorUnits: MinorUnits;
  /** The most one payment can earn, whatever it was worth. */
  maximumAwardMinorUnits: MinorUnits;
}

/**
 * The only rule in this prototype: 1% back when you pay a shop, £1
 * minimum spend, £5 cap. Paying a person earns nothing — cashback is a
 * merchant-network idea, and pretending otherwise would make the
 * reserve fund people paying themselves in circles.
 */
export const CASHBACK_V1: CashbackRule = {
  version: "cashback-v1",
  rateBasisPoints: 100,
  minimumSpendMinorUnits: 100,
  maximumAwardMinorUnits: 500,
};

export interface CashbackInput {
  amountMinorUnits: MinorUnits;
  /** Cashback is earned on paying a shop, not a person. */
  payeeOwnerType: "user" | "merchant";
}

export interface CashbackAward {
  amountMinorUnits: MinorUnits;
  rateBasisPoints: number;
  rule: string;
}

/**
 * Works out what a payment earns. Rounds DOWN, so the reserve is never
 * asked for a penny the rule didn't promise, and returns null rather
 * than a zero award when nothing is earned — "no cashback" and
 * "cashback of nothing" are different things to record.
 */
export function cashbackFor(
  input: CashbackInput,
  rule: CashbackRule = CASHBACK_V1
): CashbackAward | null {
  if (input.payeeOwnerType !== "merchant") return null;
  if (!Number.isSafeInteger(input.amountMinorUnits) || input.amountMinorUnits <= 0) return null;
  if (input.amountMinorUnits < rule.minimumSpendMinorUnits) return null;

  // Integer arithmetic throughout: (pence × basis points) / 10000,
  // floored. Never `amount * 0.01`.
  const raw = Math.floor((input.amountMinorUnits * rule.rateBasisPoints) / 10_000);
  const amountMinorUnits = Math.min(raw, rule.maximumAwardMinorUnits);
  if (amountMinorUnits <= 0) return null;

  return {
    amountMinorUnits,
    rateBasisPoints: rule.rateBasisPoints,
    rule: rule.version,
  };
}
