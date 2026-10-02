// Domain module: identity
// Owns authentication: password hashing, JWT issuance/verification,
// and the Fastify request decorators (`authenticate`, `requireRole`)
// other modules' routes use to protect themselves.
// Never reaches into the `users` table directly — goes through the
// users module's exported functions (spec §17 module boundary rule).
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

export const MODULE_NAME = "identity" as const;

const SALT_ROUNDS = 12;
// A fixed dummy hash so a login against an unknown email still pays the
// bcrypt cost — keeps failed-login timing similar whether the email
// exists or not, so the endpoint doesn't leak which emails are registered.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", SALT_ROUNDS);

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(
  plain: string,
  hash: string | null
): Promise<boolean> {
  return bcrypt.compare(plain, hash ?? DUMMY_HASH);
}

/**
 * How long a signed-in session lasts. The cookie is given the same
 * lifetime, so the cookie and the token it carries expire together —
 * a cookie that outlived its token would just produce confusing 401s.
 */
export const TOKEN_TTL_SECONDS = 60 * 60;

export interface AuthTokenPayload {
  sub: string; // user id
  role: "consumer" | "merchant" | "admin";
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }
  return secret;
}

export function signToken(payload: AuthTokenPayload): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: TOKEN_TTL_SECONDS });
}

export function verifyToken(token: string): AuthTokenPayload {
  return jwt.verify(token, getJwtSecret()) as AuthTokenPayload;
}
