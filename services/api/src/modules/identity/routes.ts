import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { hashPassword, verifyPassword, signToken, TOKEN_TTL_SECONDS } from "./index.js";
import {
  clearSessionCookie,
  scopeFromRequest,
  setSessionCookie,
} from "./session.js";
import { countRecentLoginFailures } from "./attempts.js";
import { recordAuditEvent } from "../audit/index.js";
import {
  createUser,
  findUserByEmailWithPasswordHash,
} from "../users/index.js";
import { seedDemoBalance } from "../ledger/index.js";

const credentialsSchema = {
  type: "object",
  required: ["email", "password"],
  additionalProperties: false,
  properties: {
    // Basic shape check via pattern (no ajv-formats dependency needed).
    email: {
      type: "string",
      pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
      maxLength: 255,
    },
    // Only a length bound here — no complexity theatre. Real strength
    // rules can be added later without changing the API shape.
    password: { type: "string", minLength: 8, maxLength: 256 },
  },
} as const;

export interface IdentityRoutesOptions {
  pool: Pool;
  authRateLimitPerMinute?: number;
  secureCookies?: boolean;
  /** Failed sign-ins for one account, within the window, before it's held off. */
  loginFailureLimit?: number;
  loginFailureWindowMinutes?: number;
}

export async function identityRoutes(app: FastifyInstance, opts: IdentityRoutesOptions) {
  const { pool } = opts;
  const authLimit = {
    rateLimit: { max: opts.authRateLimitPerMinute ?? 10, timeWindow: "1 minute" },
  };
  const cookieOptions = {
    secure: opts.secureCookies ?? false,
    maxAgeSeconds: TOKEN_TTL_SECONDS,
  };
  const loginFailureLimit = opts.loginFailureLimit ?? 10;
  const loginFailureWindowMinutes = opts.loginFailureWindowMinutes ?? 15;

  app.post(
    "/api/v1/auth/register",
    {
      schema: { body: credentialsSchema },
      config: authLimit,
    },
    async (request, reply) => {
      const { email, password } = request.body as {
        email: string;
        password: string;
      };

      const existing = await findUserByEmailWithPasswordHash(pool, email);
      if (existing) {
        // Same shape as a validation error — don't reveal *why* via status.
        return reply.status(409).send({
          code: "EMAIL_IN_USE",
          message: "An account with this email already exists",
          requestId: reply.request.id,
        });
      }

      // Public registration always creates a consumer account. Merchant
      // and admin accounts are provisioned out-of-band in the prototype
      // (no public escalation path) — see spec §17/§42.15.
      const passwordHash = await hashPassword(password);
      const user = await createUser(pool, {
        email,
        passwordHash,
        role: "consumer",
      });

      await recordAuditEvent(pool, {
        eventType: "USER_REGISTERED",
        actorUserId: user.id,
        metadata: { email: user.email },
      });

      // Every new consumer gets a simulated starting balance (spec §42.2).
      // identity doesn't know the amount or the ledger mechanics — it just
      // calls the ledger module's one function for this.
      await seedDemoBalance(pool, user.id);

      const token = signToken({ sub: user.id, role: user.role });
      setSessionCookie(reply, token, scopeFromRequest(request), cookieOptions);
      // The token is still in the body for API clients and tests. The
      // apps ignore it and use the cookie, which their JavaScript can't
      // read — see modules/identity/session.ts.
      return reply.status(201).send({ user, token });
    }
  );

  app.post(
    "/api/v1/auth/login",
    {
      schema: { body: credentialsSchema },
      config: authLimit,
    },
    async (request, reply) => {
      const { email, password } = request.body as {
        email: string;
        password: string;
      };

      // The per-client rate limit above doesn't help an account being
      // guessed at from many addresses, so failures are also counted
      // per account. The count comes from the audit trail we already
      // write — no new table, and the evidence and the defence can't
      // disagree with each other.
      const failures = await countRecentLoginFailures(pool, email, loginFailureWindowMinutes);
      if (failures >= loginFailureLimit) {
        await recordAuditEvent(pool, {
          eventType: "LOGIN_THROTTLED",
          actorUserId: null,
          metadata: { email, failures, windowMinutes: loginFailureWindowMinutes },
        });
        return reply.status(429).send({
          code: "TOO_MANY_ATTEMPTS",
          message: "Too many sign-in attempts. Please try again later.",
          requestId: reply.request.id,
        });
      }

      const existing = await findUserByEmailWithPasswordHash(pool, email);
      const ok = await verifyPassword(
        password,
        existing?.passwordHash ?? null
      );

      if (!existing || !ok) {
        await recordAuditEvent(pool, {
          eventType: "LOGIN_FAILED",
          actorUserId: existing?.id ?? null,
          metadata: { email },
        });
        return reply.status(401).send({
          code: "INVALID_CREDENTIALS",
          message: "Invalid email or password",
          requestId: reply.request.id,
        });
      }

      await recordAuditEvent(pool, {
        eventType: "LOGIN",
        actorUserId: existing.id,
        metadata: {},
      });

      const token = signToken({ sub: existing.id, role: existing.role });
      setSessionCookie(reply, token, scopeFromRequest(request), cookieOptions);
      const { passwordHash: _drop, ...user } = existing;
      return reply.send({ user, token });
    }
  );

  /**
   * Signing out. Worth having as a real endpoint now: with the token in
   * an httpOnly cookie, the app can't throw it away itself — only the
   * server can tell the browser to drop it.
   *
   * No authentication required. Someone asking to be signed out is
   * always allowed to be, including when their token has already
   * expired, and refusing would leave the cookie sitting there.
   */
  app.post("/api/v1/auth/logout", async (request, reply) => {
    clearSessionCookie(reply, scopeFromRequest(request), cookieOptions.secure);
    return reply.status(204).send();
  });
}
