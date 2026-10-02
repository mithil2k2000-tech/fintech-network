/* eslint-disable camelcase */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Phase 10 (cashback).
 *
 * cashback_grants: one row per payment that earned something, saying
 *   how much and — just as important — which rule worked it out. A rate
 *   that changes later must not silently rewrite what someone was
 *   given, so the rate and the rule's version are stored with the
 *   grant rather than looked up when it's read.
 *
 * The money itself is ordinary ledger movement: a transaction of kind
 * 'cashback' from the `cashback_reserve` system account to the person.
 * `transaction_id` points at it, so a grant can always be traced to
 * entries that balance. `payment_id` is unique, which is what makes
 * cashback payable once per payment no matter how often the hook runs.
 *
 * No new transaction kind constraint is needed: `transactions.kind` was
 * left free text in Phase 5 precisely so new kinds of money movement
 * arrive without a migration.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable("cashback_grants", {
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
    user_id: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    transaction_id: {
      type: "uuid",
      notNull: true,
      references: "transactions",
      onDelete: "RESTRICT",
    },
    amount_minor_units: { type: "bigint", notNull: true },
    /** The spend this was worked out from, kept so a grant explains itself. */
    spend_minor_units: { type: "bigint", notNull: true },
    /** 100 = 1%. Basis points, so the rate is a whole number too. */
    rate_basis_points: { type: "integer", notNull: true },
    /** Which version of the rule decided this. */
    rule: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("cashback_grants", "cashback_grants_amount_positive", {
    check: "amount_minor_units > 0",
  });
  pgm.addConstraint("cashback_grants", "cashback_grants_spend_positive", {
    check: "spend_minor_units > 0",
  });
  pgm.addConstraint("cashback_grants", "cashback_grants_rate_sane", {
    // A rate above 100% would mean paying someone to spend.
    check: "rate_basis_points > 0 and rate_basis_points <= 10000",
  });
  pgm.addConstraint("cashback_grants", "cashback_grants_not_more_than_spend", {
    check: "amount_minor_units <= spend_minor_units",
  });

  pgm.createIndex("cashback_grants", ["user_id", "created_at"]);

  // Grants are a record of money already moved, so they never change —
  // same guard as ledger entries, transactions and receipts (Phase 5).
  pgm.sql(`
    create trigger cashback_grants_immutable
    before update or delete on cashback_grants
    for each row execute function forbid_mutation()
  `);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.sql(`drop trigger if exists cashback_grants_immutable on cashback_grants`);
  pgm.dropTable("cashback_grants");
};
