/* eslint-disable camelcase */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Phase 9 (the merchant platform).
 *
 * merchants: a shop that can be paid. The ledger has taken
 *   (owner_type, owner_id) since Phase 3 and payment_requests since
 *   Phase 6, so a merchant needs no change to either — this is the
 *   table those ids have been pointing at all along.
 *
 * merchant_members: who may act for a shop. An owner can add staff and
 *   other owners; staff can take money but not change who's involved.
 *   Membership is the only thing that authorises acting as a merchant.
 *
 * NOT here, deliberately: any claim that a shop is who it says it is.
 * There is no KYB, no company-number check, no document upload and no
 * sanctions screening in this prototype, so `verification` only ever
 * says 'unverified' and the app must say so to customers. Real
 * onboarding checks are a regulated process and are out of scope —
 * see the spec's compliance section.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable("merchants", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    /** The registered name; what would go on a contract. */
    legal_name: { type: "text", notNull: true },
    /** What customers see on a QR code and a receipt. */
    trading_name: { type: "text", notNull: true },
    contact_email: { type: "text", notNull: true },
    status: { type: "text", notNull: true, default: "active" },
    /** Always 'unverified' in this prototype. See the note above. */
    verification: { type: "text", notNull: true, default: "unverified" },
    created_by_user_id: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("merchants", "merchants_status_check", {
    check: "status in ('active', 'suspended')",
  });
  pgm.addConstraint("merchants", "merchants_verification_check", {
    check: "verification in ('unverified', 'verified')",
  });
  pgm.addConstraint("merchants", "merchants_names_not_blank", {
    check: "length(btrim(legal_name)) > 0 and length(btrim(trading_name)) > 0",
  });
  // Two shops can't trade under the same name: a customer reading a QR
  // has only that name to go on.
  pgm.createIndex("merchants", "lower(btrim(trading_name))", {
    name: "merchants_trading_name_unique",
    unique: true,
  });

  pgm.createTable("merchant_members", {
    merchant_id: {
      type: "uuid",
      notNull: true,
      references: "merchants",
      onDelete: "RESTRICT",
    },
    user_id: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    role: { type: "text", notNull: true, default: "staff" },
    added_by_user_id: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
  });

  pgm.addConstraint("merchant_members", "merchant_members_pkey", {
    primaryKey: ["merchant_id", "user_id"],
  });
  pgm.addConstraint("merchant_members", "merchant_members_role_check", {
    check: "role in ('owner', 'staff')",
  });
  // "Which shops am I part of?" — the merchant app's first question.
  pgm.createIndex("merchant_members", ["user_id", "created_at"]);
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable("merchant_members");
  pgm.dropTable("merchants");
};
