import type { MinorUnits, RiskLevel } from "@fintech-network/shared-types";

// The seam the real risk engine (Phase 12, spec §12) plugs into. The
// payments service only knows this interface, so swapping the placeholder
// below for the deterministic rule engine won't change the payment flow.
// An LLM must never sit behind this interface: risk decisions stay
// deterministic and auditable.

export interface RiskInput {
  payerUserId: string;
  payeeOwnerType: "user" | "merchant";
  payeeOwnerId: string;
  amountMinorUnits: MinorUnits;
  /**
   * The payment being judged. Optional so a stub evaluator in a test
   * needn't invent one; the real engine files its assessment against
   * it when it's there.
   */
  paymentId?: string;
}

export interface RiskDecision {
  level: RiskLevel;
  /** Human-readable reasons, shown to the payer on the review screen. */
  reasons: string[];
  /** Which evaluator produced this, for the audit trail. */
  evaluator: string;
}

export interface RiskEvaluator {
  evaluate(input: RiskInput): Promise<RiskDecision>;
}

/**
 * Rates every payment LOW and says so in its reason. This was the
 * placeholder until Phase 12; the real engine is
 * `modules/risk/RulesRiskEvaluator`, and `buildApp` uses it by default.
 * This is kept only for tests that need risk held still while they
 * exercise something else — never wire it into a running app.
 */
export class PlaceholderRiskEvaluator implements RiskEvaluator {
  async evaluate(_input: RiskInput): Promise<RiskDecision> {
    return {
      level: "LOW",
      reasons: ["Risk engine not yet enabled in this prototype build"],
      evaluator: "placeholder-v0",
    };
  }
}
