// Domain module: risk.
//
// The real engine behind the `RiskEvaluator` port that the payments
// module has defined since Phase 4. It does two things: gather the
// signals, and file the decision. Deciding is `rules.ts`, which is
// pure — so the judgement can be reasoned about without a database,
// and reproduced from what was stored.
//
// The one thing that must never happen here: a language model deciding
// whether money moves. This module is the reason that seam exists.
import type { Pool } from "pg";
import type { Queryable } from "../../db.js";
import type { RiskLevel } from "@fintech-network/shared-types";
import { recordAuditEvent } from "../audit/index.js";
import { findUserById } from "../users/index.js";
import { getBalanceMinorUnits, getOrCreateAccountForOwner } from "../ledger/index.js";
import { getPayerHistory } from "../payments/index.js";
import type { RiskDecision, RiskEvaluator, RiskInput } from "../payments/risk.js";
import { RULES_VERSION, assessRisk, type RiskSignals } from "./rules.js";

export const MODULE_NAME = "risk" as const;

export {
  BANDS,
  RULES,
  RULES_VERSION,
  THRESHOLDS,
  assessRisk,
  levelForScore,
} from "./rules.js";
export type { FiredRule, RiskAssessment, RiskSignals } from "./rules.js";

/**
 * The deterministic rules engine. Reads the payer's own history, runs
 * the rules over it, and writes down what it saw and what it decided.
 */
export class RulesRiskEvaluator implements RiskEvaluator {
  constructor(private readonly pool: Pool) {}

  async evaluate(input: RiskInput): Promise<RiskDecision> {
    const signals = await this.gather(input);
    const assessment = assessRisk(signals);

    if (input.paymentId) {
      await this.record(this.pool, input.paymentId, assessment, signals);
    }

    // The payer is told the level and the reasons. The score and the
    // rule names stay internal: publishing them would teach anyone
    // paying attention exactly how to stay under a threshold.
    return {
      level: assessment.level,
      reasons: assessment.reasons,
      evaluator: assessment.evaluator,
    };
  }

  private async gather(input: RiskInput): Promise<RiskSignals> {
    const payee = { ownerType: input.payeeOwnerType, ownerId: input.payeeOwnerId };
    const [history, account, payer] = await Promise.all([
      getPayerHistory(this.pool, input.payerUserId, payee),
      getOrCreateAccountForOwner(this.pool, "user", input.payerUserId),
      findUserById(this.pool, input.payerUserId),
    ]);
    const balanceMinorUnits = await getBalanceMinorUnits(this.pool, account.id);

    const accountAgeHours = payer
      ? Math.max(0, (Date.now() - Date.parse(payer.createdAt)) / 3_600_000)
      : 0;

    return {
      amountMinorUnits: input.amountMinorUnits,
      payeeOwnerType: input.payeeOwnerType,
      balanceMinorUnits,
      ...history,
      accountAgeHours,
    };
  }

  /**
   * Files the decision with the signals it was made from. A later
   * re-run would see a different history, so the signals are what make
   * the decision auditable rather than merely repeatable.
   *
   * Writing this must never be the reason a payment fails: if the row
   * can't be written the decision still stands, and the failure is
   * audited. The decision itself is also on the payment row.
   */
  private async record(
    q: Queryable,
    paymentId: string,
    assessment: ReturnType<typeof assessRisk>,
    signals: RiskSignals
  ): Promise<void> {
    try {
      await q.query(
        `insert into risk_assessments
           (payment_id, level, score, fired_rules, reasons, signals, evaluator)
         values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7)
         on conflict (payment_id) do nothing`,
        [
          paymentId,
          assessment.level,
          assessment.score,
          JSON.stringify(assessment.firedRules),
          JSON.stringify(assessment.reasons),
          JSON.stringify(signals),
          assessment.evaluator,
        ]
      );
    } catch (err) {
      await recordAuditEvent(this.pool, {
        eventType: "RISK_ASSESSMENT_NOT_RECORDED",
        metadata: {
          paymentId,
          level: assessment.level,
          reason: err instanceof Error ? err.message : "unknown",
        },
      }).catch(() => undefined);
    }
  }
}

export interface StoredAssessment {
  paymentId: string;
  level: string;
  score: number;
  firedRules: { id: string; weight: number; reason: string }[];
  reasons: string[];
  signals: RiskSignals;
  evaluator: string;
  assessedAt: string;
}

/**
 * The full working for one payment. For audit and later admin tooling —
 * not for the payer, who sees the level and the reasons on the payment
 * itself.
 */
export async function getAssessmentForPayment(
  q: Queryable,
  paymentId: string
): Promise<StoredAssessment | null> {
  const result = await q.query<{
    payment_id: string;
    level: string;
    score: number;
    fired_rules: { id: string; weight: number; reason: string }[];
    reasons: string[];
    signals: RiskSignals;
    evaluator: string;
    created_at: Date;
  }>(`select * from risk_assessments where payment_id = $1`, [paymentId]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    paymentId: row.payment_id,
    level: row.level,
    score: row.score,
    firedRules: row.fired_rules,
    reasons: row.reasons,
    signals: row.signals,
    evaluator: row.evaluator,
    assessedAt: row.created_at.toISOString(),
  };
}

export { RULES_VERSION as CURRENT_RULES_VERSION };

/**
 * What the engine has been deciding lately (Phase 15). Until now
 * nothing reported this, which meant nobody could tell whether the
 * thresholds were sensible — the documented gap at the end of Phase 12.
 * It still isn't calibration (there are no outcomes to learn from), but
 * it is at least the distribution, and a rule that never fires or fires
 * on everything now shows up.
 */
export async function countAssessmentsByLevelSince(
  q: Queryable,
  hours: number
): Promise<{ level: RiskLevel; count: number }[]> {
  const result = await q.query<{ level: RiskLevel; count: string }>(
    `select level, count(*)::text as count
     from risk_assessments
     where created_at > now() - make_interval(hours => $1::int)
     group by level`,
    [hours]
  );
  return result.rows.map((row) => ({ level: row.level, count: Number(row.count) }));
}

/** Which rules actually fire, so a dead rule is visible. */
export async function countFiredRulesSince(
  q: Queryable,
  hours: number
): Promise<{ rule: string; count: number }[]> {
  const result = await q.query<{ rule: string; count: string }>(
    `select rule->>'id' as rule, count(*)::text as count
     from risk_assessments, jsonb_array_elements(fired_rules) as rule
     where created_at > now() - make_interval(hours => $1::int)
     group by rule->>'id'
     order by count(*) desc`,
    [hours]
  );
  return result.rows.map((row) => ({ rule: row.rule, count: Number(row.count) }));
}
