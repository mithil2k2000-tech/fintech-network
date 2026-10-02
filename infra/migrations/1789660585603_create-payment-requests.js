/* eslint-disable camelcase */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Phase 6 (QR payments).
 *
 * payment_requests: "please pay me £X for Y". Phase 6 uses them behind a
 *   QR code (channel 'qr'); Phase 7 sends them to a named person, Phase 9
 *   lets merchants create them. Payee is (owner_type, owner_id) like the
 *   ledger, so merchants fit without a schema change.
 *   - code: short, human-typeable reference (REQ-XXXXXXXX), for when a
 *     camera isn't available.
 *   - token: long random value the QR carries. Anyone holding it can see
 *     the request and start paying it, which is the point of a QR. It
 *     can't move money by itself: the payer still signs in and confirms.
 *   - status: OPEN, PAID or CANCELLED. "Expired" is worked out from
 *     expires_at when read, so no background job is needed.
 *   - A PAID request always points at the payment that paid it.
 *
 * payments.payment_request_id links a payment back to the request it was
 * made from. Many payments may try; only one can complete (the paying
 * transaction flips the request OPEN -> PAID with a conditional update).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable("payment_requests", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    code: { type: "text", notNull: true, unique: true },
    token: { type: "text", notNull: true, unique: true },
    channel: { type: "text", notNull: true, default: "qr" },
    created_by_user_id: {
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
    status: { type: "text", notNull: true, default: "OPEN" },
    expires_at: { type: "timestamptz", notNull: true },
    paid_payment_id: {
      type: "uuid",
      notNull: false,
      references: "payments",
      onDelete: "RESTRICT",
    },
    paid_by_user_id: {
      type: "uuid",
      notNull: false,
      references: "users",
      onDelete: "RESTRICT",
    },
    paid_at: { type: "timestamptz", notNull: false },
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

  pgm.addConstraint("payment_requests", "payment_requests_amount_positive", {
    check: "amount_minor_units > 0",
  });
  pgm.addConstraint("payment_requests", "payment_requests_payee_type_check", {
    check: "payee_owner_type in ('user', 'merchant')",
  });
  pgm.addConstraint("payment_requests", "payment_requests_status_check", {
    check: "status in ('OPEN', 'PAID', 'CANCELLED')",
  });
  pgm.addConstraint("payment_requests", "payment_requests_paid_consistent", {
    check:
      "(status = 'PAID') = (paid_payment_id is not null and paid_by_user_id is not null and paid_at is not null)",
  });
  pgm.addConstraint("payment_requests", "payment_requests_cancelled_consistent", {
    check: "(status = 'CANCELLED') = (cancelled_at is not null)",
  });
  pgm.addConstraint("payment_requests", "payment_requests_expiry_after_creation", {
    check: "expires_at > created_at",
  });

  pgm.createIndex("payment_requests", ["created_by_user_id", "created_at"]);
  pgm.createIndex("payment_requests", ["payee_owner_type", "payee_owner_id", "created_at"]);
  pgm.createIndex("payment_requests", "paid_payment_id", {
    unique: true,
    where: "paid_payment_id is not null",
  });

  pgm.addColumn("payments", {
    payment_request_id: {
      type: "uuid",
      notNull: false,
      references: "payment_requests",
      onDelete: "RESTRICT",
    },
  });
  pgm.createIndex("payments", "payment_request_id", {
    where: "payment_request_id is not null",
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropColumn("payments", "payment_request_id");
  pgm.dropTable("payment_requests");
};
