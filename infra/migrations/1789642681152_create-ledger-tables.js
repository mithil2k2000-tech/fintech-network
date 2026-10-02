/* eslint-disable camelcase */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Phase 3 (Accounts + double-entry ledger).
 *
 * ledger_accounts: one row per owner (a user, a merchant — later — or a
 *   system account like "seed_funding"). No FK on owner_id: owner_type
 *   decides which table owner_id points into, and merchants don't have
 *   their own table yet (Phase 9), so a single FK target isn't possible
 *   yet. Application code (the ledger module) is the only thing allowed
 *   to create rows here, and only with owner ids it has itself verified.
 * transactions: one row per business event.
 * ledger_entries: immutable debit/credit rows. The zero-sum-per-
 *   transaction invariant is enforced in the ledger module's
 *   `postTransaction`, not by a DB constraint, because Postgres check
 *   constraints can't see sibling rows — never insert into this table
 *   from anywhere else.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable("ledger_accounts", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    owner_type: { type: "text", notNull: true },
    owner_id: { type: "uuid", notNull: false },
    name: { type: "text", notNull: false },
    currency: { type: "text", notNull: true, default: "GBP" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.addConstraint("ledger_accounts", "ledger_accounts_owner_type_check", {
    check: "owner_type in ('user', 'merchant', 'system')",
  });
  pgm.addConstraint(
    "ledger_accounts",
    "ledger_accounts_owner_id_required_unless_system",
    {
      check: "(owner_type = 'system' and owner_id is null) or (owner_type != 'system' and owner_id is not null)",
    }
  );

  // One account per (owner_type, owner_id) — partial unique index because
  // system accounts have owner_id null and shouldn't collide there.
  pgm.sql(`
    create unique index ledger_accounts_owner_unique
      on ledger_accounts (owner_type, owner_id)
      where owner_id is not null
  `);
  pgm.sql(`
    create unique index ledger_accounts_system_name_unique
      on ledger_accounts (name)
      where owner_type = 'system'
  `);

  pgm.createTable("transactions", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    description: { type: "text", notNull: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.createTable("ledger_entries", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    transaction_id: {
      type: "uuid",
      notNull: true,
      references: "transactions",
      onDelete: "RESTRICT",
    },
    account_id: {
      type: "uuid",
      notNull: true,
      references: "ledger_accounts",
      onDelete: "RESTRICT",
    },
    direction: { type: "text", notNull: true },
    amount_minor_units: { type: "bigint", notNull: true },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.addConstraint("ledger_entries", "ledger_entries_direction_check", {
    check: "direction in ('debit', 'credit')",
  });
  pgm.addConstraint("ledger_entries", "ledger_entries_amount_positive", {
    check: "amount_minor_units > 0",
  });

  pgm.createIndex("ledger_entries", "transaction_id");
  pgm.createIndex("ledger_entries", "account_id");
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable("ledger_entries");
  pgm.dropTable("transactions");
  pgm.dropTable("ledger_accounts");
};
