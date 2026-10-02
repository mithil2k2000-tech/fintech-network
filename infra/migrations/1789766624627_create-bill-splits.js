/* eslint-disable camelcase */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Phase 8 (splitting a bill).
 *
 * bill_splits: "this cost £X, here's everyone's share". The organiser
 *   keeps their own share (organiser_share_minor_units) and everyone
 *   else gets a direct payment request, so a share is paid, declined
 *   and receipted by exactly the machinery Phase 7 already built. No
 *   new way for money to move.
 *
 * payment_requests.bill_split_id ties those requests back to the split.
 * Nothing about a request changes because it belongs to one: the column
 * is null for every request made so far.
 *
 * The maths lives in code (billSplits/shares.ts), in whole pence, and
 * the DB checks what it can: every share is positive, the organiser's
 * share is never negative, and a split's shares must add up to its
 * total — checked in the module's transaction and asserted by tests,
 * since a cross-row sum is not something a CHECK can see.
 *
 * "Settled" is worked out from the requests when read, like expiry in
 * Phase 6, so nothing has to run on a schedule.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable("bill_splits", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    created_by_user_id: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    total_minor_units: { type: "bigint", notNull: true },
    organiser_share_minor_units: { type: "bigint", notNull: true },
    currency: { type: "text", notNull: true, default: "GBP" },
    purpose: { type: "text", notNull: false },
    /** How the shares were worked out, for the audit trail. */
    method: { type: "text", notNull: true, default: "even" },
    status: { type: "text", notNull: true, default: "OPEN" },
    cancelled_at: { type: "timestamptz", notNull: false },
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

  pgm.addConstraint("bill_splits", "bill_splits_total_positive", {
    check: "total_minor_units > 0",
  });
  pgm.addConstraint("bill_splits", "bill_splits_organiser_share_not_negative", {
    check:
      "organiser_share_minor_units >= 0 and organiser_share_minor_units <= total_minor_units",
  });
  pgm.addConstraint("bill_splits", "bill_splits_method_check", {
    check: "method in ('even', 'custom')",
  });
  pgm.addConstraint("bill_splits", "bill_splits_status_check", {
    check: "status in ('OPEN', 'CANCELLED')",
  });
  pgm.addConstraint("bill_splits", "bill_splits_cancelled_consistent", {
    check: "(status = 'CANCELLED') = (cancelled_at is not null)",
  });

  pgm.createIndex("bill_splits", ["created_by_user_id", "created_at"]);

  pgm.addColumn("payment_requests", {
    bill_split_id: {
      type: "uuid",
      notNull: false,
      references: "bill_splits",
      onDelete: "RESTRICT",
    },
    /**
     * Where this share sits in the split, counting the organiser as 0.
     * Every share of a split is written in one transaction, so they all
     * share a created_at and could otherwise come back in any order —
     * this keeps "who owes what" in the order the organiser typed.
     */
    split_share_index: { type: "smallint", notNull: false },
  });
  pgm.createIndex("payment_requests", "bill_split_id", {
    where: "bill_split_id is not null",
  });
  pgm.createIndex("payment_requests", ["bill_split_id", "split_share_index"], {
    unique: true,
    where: "bill_split_id is not null",
  });
  // A share is always a request addressed to someone, and always placed.
  pgm.addConstraint("payment_requests", "payment_requests_split_is_direct", {
    check: "bill_split_id is null or target_user_id is not null",
  });
  pgm.addConstraint("payment_requests", "payment_requests_split_index_present", {
    check: "(bill_split_id is null) = (split_share_index is null)",
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropConstraint("payment_requests", "payment_requests_split_index_present");
  pgm.dropConstraint("payment_requests", "payment_requests_split_is_direct");
  pgm.dropColumn("payment_requests", ["bill_split_id", "split_share_index"]);
  pgm.dropTable("bill_splits");
};
