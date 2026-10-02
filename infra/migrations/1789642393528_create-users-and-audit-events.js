/* eslint-disable camelcase */

/** @type {import('node-pg-migrate').ColumnDefinitions | undefined} */
exports.shorthands = undefined;

/**
 * Phase 2 (Auth + users): first real schema.
 * - users: one row per account (consumer/merchant/admin), password hashed, never plaintext.
 * - audit_events: append-only record of security/lifecycle events (spec §16 Audit System).
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.up = (pgm) => {
  pgm.createTable("users", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    email: { type: "text", notNull: true, unique: true },
    password_hash: { type: "text", notNull: true },
    role: {
      type: "text",
      notNull: true,
      default: "consumer",
    },
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

  pgm.addConstraint("users", "users_role_check", {
    check: "role in ('consumer', 'merchant', 'admin')",
  });

  pgm.createTable("audit_events", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    event_type: { type: "text", notNull: true },
    actor_user_id: {
      type: "uuid",
      notNull: false,
      references: "users",
      onDelete: "SET NULL",
    },
    metadata: { type: "jsonb", notNull: true, default: "{}" },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("now()"),
    },
  });

  pgm.createIndex("audit_events", "event_type");
  pgm.createIndex("audit_events", "actor_user_id");
};

/**
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
exports.down = (pgm) => {
  pgm.dropTable("audit_events");
  pgm.dropTable("users");
};
