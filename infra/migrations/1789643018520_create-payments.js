/* eslint-disable camelcase */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Phase 4 (Simulated payments).
 *
 * payments: one row per payment attempt, carrying its current state
 *   (spec §9 state machine). The money movement itself lives in the
 *   ledger — `transaction_id` links a COMPLETED payment to the ledger
 *   transaction that recorded it. No FK on payee_owner_id for the same
 *   reason as ledger_accounts: payee_owner_type decides which table it
 *   points into, and merchants don't have a table until Phase 9.
 *
 * Risk results are stored on the payment for now. A dedicated
 * risk_events table arrives with the real risk engine (Phase 12).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable("payments", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    payer_user_id: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    payee_owner_type: { type: "text", notNull: true },
    payee_owner_id: { type: "uuid", notNull: true },
    amount_minor_units: { type: "bigint", notNull: true },
    currency: { type: "text", notNull: true, default: "GBP" },
    purpose: { type: "text", notNull: false },
    status: { type: "text", notNull: true },
    risk_level: { type: "text", notNull: false },
    risk_reasons: { type: "jsonb", notNull: true, default: "[]" },
    provider_name: { type: "text", notNull: false },
    provider_reference: { type: "text", notNull: false },
    transaction_id: {
      type: "uuid",
      notNull: false,
      references: "transactions",
      onDelete: "RESTRICT",
    },
    failure_reason: { type: "text", notNull: false },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.addConstraint("payments", "payments_payee_owner_type_check", {
    check: "payee_owner_type in ('user', 'merchant')",
  });
  pgm.addConstraint("payments", "payments_amount_positive", {
    check: "amount_minor_units > 0",
  });
  pgm.addConstraint("payments", "payments_status_check", {
    check:
      "status in ('CREATED', 'PENDING_RISK', 'APPROVED', 'PROCESSING', 'COMPLETED', 'FAILED', 'REFUNDED', 'DISPUTED')",
  });
  pgm.addConstraint("payments", "payments_risk_level_check", {
    check: "risk_level is null or risk_level in ('LOW', 'MEDIUM', 'HIGH')",
  });
  // A payment is COMPLETED if and only if it's linked to a ledger
  // transaction — the DB refuses any other combination.
  pgm.addConstraint("payments", "payments_completed_has_transaction", {
    check:
      "(status in ('COMPLETED', 'REFUNDED', 'DISPUTED')) = (transaction_id is not null)",
  });

  pgm.createIndex("payments", ["payer_user_id", "created_at"]);
  pgm.createIndex("payments", ["payee_owner_type", "payee_owner_id", "created_at"]);
  pgm.createIndex("payments", "transaction_id", { unique: true, where: "transaction_id is not null" });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable("payments");
};
