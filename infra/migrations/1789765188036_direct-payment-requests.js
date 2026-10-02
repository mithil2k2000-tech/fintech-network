/* eslint-disable camelcase */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Phase 7 (asking a named person to pay).
 *
 * The same payment_requests table as Phase 6 — a request is a request
 * however it reaches the payer. What changes is who may pay it:
 *   - channel 'qr'     : anyone holding the token or code may pay.
 *   - channel 'direct' : only target_user_id may pay, and they may
 *                        decline instead.
 *
 * target_user_id is null for every existing row, so this is additive:
 * Phase 6 QR requests keep working unchanged.
 *
 * DECLINED is a new terminal status alongside PAID and CANCELLED.
 * CANCELLED means the requester withdrew it; DECLINED means the person
 * asked said no. Keeping them apart matters for the audit trail — and
 * later for not nagging someone who has already said no.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.addColumn("payment_requests", {
    target_user_id: {
      type: "uuid",
      notNull: false,
      references: "users",
      onDelete: "RESTRICT",
    },
    declined_at: { type: "timestamptz", notNull: false },
  });

  // Widening an existing check: drop and re-add with the new status.
  pgm.dropConstraint("payment_requests", "payment_requests_status_check");
  pgm.addConstraint("payment_requests", "payment_requests_status_check", {
    check: "status in ('OPEN', 'PAID', 'CANCELLED', 'DECLINED')",
  });

  pgm.addConstraint("payment_requests", "payment_requests_declined_consistent", {
    check: "(status = 'DECLINED') = (declined_at is not null)",
  });

  // A direct request always names someone; a QR request never does.
  pgm.addConstraint("payment_requests", "payment_requests_channel_check", {
    check: "channel in ('qr', 'direct')",
  });
  pgm.addConstraint("payment_requests", "payment_requests_target_matches_channel", {
    check: "(channel = 'direct') = (target_user_id is not null)",
  });
  // Asking yourself to pay you is not a thing.
  pgm.addConstraint("payment_requests", "payment_requests_target_not_self", {
    check: "target_user_id is null or target_user_id <> created_by_user_id",
  });
  // Only the person asked may pay a direct request. Enforced in the
  // module too; this is the backstop if anything ever writes around it.
  pgm.addConstraint("payment_requests", "payment_requests_direct_payer_is_target", {
    check: "target_user_id is null or paid_by_user_id is null or paid_by_user_id = target_user_id",
  });

  // The inbox query: "requests waiting for me", newest first.
  pgm.createIndex("payment_requests", ["target_user_id", "created_at"], {
    where: "target_user_id is not null",
  });
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropIndex("payment_requests", ["target_user_id", "created_at"], {
    where: "target_user_id is not null",
  });
  pgm.dropConstraint("payment_requests", "payment_requests_direct_payer_is_target");
  pgm.dropConstraint("payment_requests", "payment_requests_target_not_self");
  pgm.dropConstraint("payment_requests", "payment_requests_target_matches_channel");
  pgm.dropConstraint("payment_requests", "payment_requests_channel_check");
  pgm.dropConstraint("payment_requests", "payment_requests_declined_consistent");
  pgm.dropConstraint("payment_requests", "payment_requests_status_check");
  pgm.addConstraint("payment_requests", "payment_requests_status_check", {
    check: "status in ('OPEN', 'PAID', 'CANCELLED')",
  });
  pgm.dropColumn("payment_requests", ["target_user_id", "declined_at"]);
};
