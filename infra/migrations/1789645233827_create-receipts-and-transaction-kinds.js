/* eslint-disable camelcase */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Phase 5 (Transaction history + digital receipts).
 *
 * 1. transactions.kind — what a ledger transaction represents ("seed",
 *    "payment", later "refund", "cashback", ...), so the activity feed
 *    never has to guess from description text. Deliberately no CHECK
 *    constraint: new kinds arrive with new phases and shouldn't need a
 *    schema change. The TypeScript type in the ledger module is the list.
 *    Existing rows are backfilled.
 * 2. receipts — one immutable receipt per completed payment (spec §14).
 *    Names and amounts are snapshotted at issue time so a receipt never
 *    changes after the fact. The payment's *current* status (e.g. a
 *    later refund) is read live from payments, not stored here.
 *    Receipts for payments completed before this migration are
 *    backfilled.
 * 3. Immutability triggers — ledger_entries, transactions and receipts
 *    refuse UPDATE and DELETE at the database level, as a second line of
 *    defence behind the application code (spec §10: entries are
 *    immutable; corrections are new entries).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  // --- 1. transaction kinds -------------------------------------------
  pgm.addColumn("transactions", {
    kind: { type: "text", notNull: true, default: "adjustment" },
  });
  pgm.sql(`
    update transactions set kind = 'payment'
    where id in (select transaction_id from payments where transaction_id is not null)
  `);
  pgm.sql(`
    update transactions set kind = 'seed'
    where kind = 'adjustment' and description = 'Prototype starting balance'
  `);

  // --- 2. receipts -----------------------------------------------------
  pgm.createTable("receipts", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    receipt_number: { type: "text", notNull: true, unique: true },
    payment_id: {
      type: "uuid",
      notNull: true,
      unique: true,
      references: "payments",
      onDelete: "RESTRICT",
    },
    transaction_id: {
      type: "uuid",
      notNull: true,
      references: "transactions",
      onDelete: "RESTRICT",
    },
    payer_user_id: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    payee_owner_type: { type: "text", notNull: true },
    payee_owner_id: { type: "uuid", notNull: true },
    payer_display_name: { type: "text", notNull: true },
    payee_display_name: { type: "text", notNull: true },
    amount_minor_units: { type: "bigint", notNull: true },
    currency: { type: "text", notNull: true, default: "GBP" },
    purpose: { type: "text", notNull: false },
    // Reference the Payment Passport feature will verify against. It's
    // random and unguessable on purpose — it will be the thing a user
    // shares to prove this one payment, so it must not be enumerable.
    passport_reference: { type: "text", notNull: true, unique: true },
    issued_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });
  pgm.addConstraint("receipts", "receipts_amount_positive", {
    check: "amount_minor_units > 0",
  });
  pgm.createIndex("receipts", "payer_user_id");
  pgm.createIndex("receipts", ["payee_owner_type", "payee_owner_id"]);

  pgm.sql(`
    insert into receipts (
      receipt_number, payment_id, transaction_id, payer_user_id,
      payee_owner_type, payee_owner_id, payer_display_name, payee_display_name,
      amount_minor_units, currency, purpose, passport_reference, issued_at
    )
    select
      -- Same unambiguous alphabet as the app: hex with 0/1 swapped for Q/R.
      'RCP-' || translate(upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)), '01', 'QR'),
      p.id, p.transaction_id, p.payer_user_id,
      p.payee_owner_type, p.payee_owner_id,
      pu.email, coalesce(ru.email, 'Unknown recipient'),
      p.amount_minor_units, p.currency, p.purpose,
      'PP-' || replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      p.updated_at
    from payments p
    join users pu on pu.id = p.payer_user_id
    left join users ru on p.payee_owner_type = 'user' and ru.id = p.payee_owner_id
    where p.status in ('COMPLETED', 'REFUNDED', 'DISPUTED')
      and p.transaction_id is not null
  `);

  // --- 3. immutability (after the backfills above) ----------------------
  pgm.sql(`
    create function forbid_mutation() returns trigger
    language plpgsql as $$
    begin
      raise exception '% rows are immutable (attempted %)', tg_table_name, tg_op
        using errcode = 'restrict_violation';
    end;
    $$
  `);
  for (const table of ["ledger_entries", "transactions", "receipts"]) {
    pgm.sql(`
      create trigger ${table}_immutable
      before update or delete on ${table}
      for each row execute function forbid_mutation()
    `);
  }
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  for (const table of ["ledger_entries", "transactions", "receipts"]) {
    pgm.sql(`drop trigger if exists ${table}_immutable on ${table}`);
  }
  pgm.sql(`drop function if exists forbid_mutation()`);
  pgm.dropTable("receipts");
  pgm.dropColumn("transactions", "kind");
};
