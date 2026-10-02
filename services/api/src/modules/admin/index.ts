// Domain module: admin — the operations view (Phase 15, spec §24).
//
// It owns no tables. Every number here is read through the exported
// function of whichever module owns the data, which is the module
// boundary rule (§17) doing real work: this file can be written without
// knowing a single column name, and a schema change in payments doesn't
// reach it.
//
// What it is for: the questions nobody could answer until now.
//
//   * What is the cashback reserve costing? It has been paying out
//     since Phase 10 with nothing topping it up and nothing reporting
//     it — a documented gap, and the kind that gets expensive quietly.
//   * What is the risk engine actually deciding? A rule that never
//     fires, or one that fires on everything, has been invisible.
//   * Do the books still balance? Checked live against the database,
//     not reported from a cached number.
//
// Everything is read-only. There is no endpoint in this module that
// changes anything, and nothing it imports writes.
import type { Pool } from "pg";
import {
  checkLedgerIntegrity,
  getBalanceMinorUnits,
  getOrCreateSystemAccount,
} from "../ledger/index.js";
import {
  countFailuresByReasonSince,
  countPaymentsByStatusSince,
} from "../payments/index.js";
import { countAssessmentsByLevelSince, countFiredRulesSince } from "../risk/index.js";
import { countEventsSince } from "../audit/index.js";
import { CASHBACK_RESERVE_ACCOUNT, getCashbackPaidOut } from "../rewards/index.js";
import type { MinorUnits, PaymentStatus, RiskLevel } from "@fintech-network/shared-types";

export const MODULE_NAME = "admin" as const;

export const DEFAULT_WINDOW_HOURS = 24;
export const MAX_WINDOW_HOURS = 24 * 90;

export interface OperationsOverview {
  windowHours: number;
  generatedAt: string;
  payments: {
    byStatus: { status: PaymentStatus; count: number; totalMinorUnits: MinorUnits }[];
    failuresByReason: { reason: string; count: number }[];
  };
  risk: {
    byLevel: { level: RiskLevel; count: number }[];
    firedRules: { rule: string; count: number }[];
  };
  rewards: {
    /** What the reserve has paid out, ever. */
    paidOutMinorUnits: MinorUnits;
    /**
     * The reserve's own balance. It is funded by nothing, so this is
     * negative and grows more negative — which is the honest picture of
     * an offer with no funding behind it.
     */
    reserveBalanceMinorUnits: MinorUnits;
  };
  ledger: {
    entries: number;
    unbalancedTransactions: number;
    negativeOwnerAccounts: number;
    /** True only when both counts above are zero. */
    balanced: boolean;
  };
  security: { eventType: string; count: number }[];
}

const SECURITY_EVENTS = [
  "LOGIN_FAILED",
  "LOGIN_THROTTLED",
  "UNAUTHORIZED_ACCESS_ATTEMPT",
  "RECIPIENT_LOOKUP_THROTTLED",
  "PAYMENT_APPROVAL_EXPIRED",
  "ASSISTANT_DRAFT_REJECTED",
  "CASHBACK_FAILED",
  "RISK_ASSESSMENT_NOT_RECORDED",
] as const;

export function clampWindowHours(raw: number | undefined): number {
  if (raw === undefined || !Number.isSafeInteger(raw) || raw < 1) return DEFAULT_WINDOW_HOURS;
  return Math.min(raw, MAX_WINDOW_HOURS);
}

export async function getOperationsOverview(
  pool: Pool,
  windowHours = DEFAULT_WINDOW_HOURS
): Promise<OperationsOverview> {
  const reserve = await getOrCreateSystemAccount(pool, CASHBACK_RESERVE_ACCOUNT);
  const [
    byStatus,
    failuresByReason,
    byLevel,
    firedRules,
    paidOutMinorUnits,
    reserveBalanceMinorUnits,
    ledger,
    security,
  ] = await Promise.all([
    countPaymentsByStatusSince(pool, windowHours),
    countFailuresByReasonSince(pool, windowHours),
    countAssessmentsByLevelSince(pool, windowHours),
    countFiredRulesSince(pool, windowHours),
    getCashbackPaidOut(pool),
    getBalanceMinorUnits(pool, reserve.id),
    checkLedgerIntegrity(pool),
    countEventsSince(pool, windowHours, [...SECURITY_EVENTS]),
  ]);

  return {
    windowHours,
    generatedAt: new Date().toISOString(),
    payments: { byStatus, failuresByReason },
    risk: { byLevel, firedRules },
    rewards: { paidOutMinorUnits, reserveBalanceMinorUnits },
    ledger: {
      ...ledger,
      balanced: ledger.unbalancedTransactions === 0 && ledger.negativeOwnerAccounts === 0,
    },
    security,
  };
}
