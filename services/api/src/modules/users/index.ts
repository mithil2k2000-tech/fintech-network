// Domain module: users
// Owns the `users` table. Other modules (identity, and later payments,
// merchants, etc.) go through the functions exported here rather than
// querying `users` directly (spec §17 module boundary rule).
import type { Queryable } from "../../db.js";
import type { UserRole } from "@fintech-network/shared-types";

export const MODULE_NAME = "users" as const;

export type { UserRole };

export interface User {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  role: UserRole;
  created_at: Date;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    createdAt: row.created_at.toISOString(),
  };
}

export async function createUser(
  pool: Queryable,
  input: { email: string; passwordHash: string; role?: UserRole }
): Promise<User> {
  const result = await pool.query<UserRow>(
    `insert into users (email, password_hash, role)
     values ($1, $2, coalesce($3, 'consumer'))
     returning id, email, password_hash, role, created_at`,
    [input.email.toLowerCase(), input.passwordHash, input.role ?? null]
  );
  return toUser(result.rows[0]);
}

export async function findUserByEmailWithPasswordHash(
  pool: Queryable,
  email: string
): Promise<(User & { passwordHash: string }) | null> {
  const result = await pool.query<UserRow>(
    `select id, email, password_hash, role, created_at
     from users where email = $1`,
    [email.toLowerCase()]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...toUser(row), passwordHash: row.password_hash };
}

export async function findUserByEmail(
  pool: Queryable,
  email: string
): Promise<User | null> {
  const found = await findUserByEmailWithPasswordHash(pool, email);
  if (!found) return null;
  const { passwordHash: _drop, ...user } = found;
  return user;
}

export async function findUserById(
  pool: Queryable,
  id: string
): Promise<User | null> {
  const result = await pool.query<UserRow>(
    `select id, email, password_hash, role, created_at
     from users where id = $1`,
    [id]
  );
  const row = result.rows[0];
  return row ? toUser(row) : null;
}
