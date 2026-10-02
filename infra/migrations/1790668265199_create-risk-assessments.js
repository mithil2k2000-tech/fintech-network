/* eslint-disable camelcase */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Phase 12 (the real risk engine).
 *
 * risk_assessments: why a payment was rated the way it was. The payment
 *   row already carries the level and the reasons shown to the payer;
 *   this is the working underneath — the score, which named rules fired,
 *   and the signals they judged, as they were at the time.
 *
 * That last part matters. A payer's history changes constantly, so
 * re-running the rules a week later would not reproduce the decision.
 * Storing the signals with the assessment is what makes a decision
 * auditable rather than merely repeatable, which is the whole point of
 * insisting the engine be deterministic: same signals in, same answer
 * out, and the signals are on file.
 *
 * Assessments are immutable, like receipts and ledger entries. A record
 * of a decision that can be edited afterwards is not a record.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable("risk_assessments", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    payment_id: {
      type: "uuid",
      notNull: true,
      unique: true,
      references: "payments",
      onDelete: "RESTRICT",
    },
    level: { type: "text", notNull: true },
    /** 0–100. Kept for audit; never shown to the payer. */
    score: { type: "integer", notNull: true },
    /** Which named rules fired, with the weight each contributed. */
    fired_rules: { type: "jsonb", notNull: true, default: "[]" },
    /** What the payer was told. */
    reasons: { type: "jsonb", notNull: true, default: "[]" },
    /** The signals as they stood when the decision was made. */
    signals: { type: "jsonb", notNull: true, default: "{}" },
    /** Which engine and rule set decided. */
    evaluator: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("risk_assessments", "risk_assessments_level_check", {
    check: "level in ('LOW', 'MEDIUM', 'HIGH')",
  });
  pgm.addConstraint("risk_assessments", "risk_assessments_score_range", {
    check: "score >= 0 and score <= 100",
  });

  pgm.createIndex("risk_assessments", ["level", "created_at"]);

  /**
   * Which engine judged each payment. The assessment row has the full
   * working, but only the real engine writes one — so without this the
   * payment row can't say whether it was rated by the rules engine, a
   * later version of it, or a stub in a test. "Who decided?" is an
   * audit question, and it belongs on the payment.
   */
  pgm.addColumn("payments", {
    risk_evaluator: { type: "text", notNull: false },
  });

  pgm.sql(`
    create trigger risk_assessments_immutable
    before update or delete on risk_assessments
    for each row execute function forbid_mutation()
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumn("payments", "risk_evaluator");
  pgm.sql(`drop trigger if exists risk_assessments_immutable on risk_assessments`);
  pgm.dropTable("risk_assessments");
};
