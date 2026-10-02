import type { FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { verifyToken, type AuthTokenPayload } from "./index.js";
import { isOriginAllowed, readPresentedToken } from "./session.js";
import { recordAuditEvent } from "../audit/index.js";
import { DEV_ORIGINS, type AppConfig } from "../../config.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthTokenPayload;
  }
  interface FastifyInstance {
    /** Set once by buildApp, so no route has to be handed it. */
    appConfig: AppConfig;
  }
}

function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string
) {
  return reply.status(status).send({
    code,
    message,
    requestId: reply.request.id,
  });
}

/**
 * Establishes who is calling and attaches them to request.user. Every
 * protected route lists this as an `onRequest` hook — there is no
 * implicit/global auth (explicit > implicit, so it's obvious from a
 * route's definition whether it's protected).
 *
 * `onRequest`, not `preHandler`, so authentication runs BEFORE the body is
 * parsed and validated: an anonymous caller gets a plain 401 rather than a
 * validation error describing the fields we expect.
 *
 * Since Phase 14 a session can arrive two ways: the httpOnly cookie the
 * apps use, or an Authorization: Bearer header for API clients and
 * tests. The difference matters for one thing only — a cookie is sent by
 * the browser whether or not the page meant to send it, so a cookie is
 * honoured only when the request came from one of this deployment's own
 * apps. A forged cross-site request carries no bearer token, and its
 * cookie is refused here even if SameSite somehow let it through.
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const presented = readPresentedToken(request);
  if (!presented) {
    return sendError(reply, 401, "UNAUTHENTICATED", "Not signed in");
  }
  if (presented.source === "cookie") {
    const allowed = request.server.appConfig?.allowedOrigins ?? [...DEV_ORIGINS];
    if (!isOriginAllowed(request, allowed)) {
      return sendError(reply, 403, "CROSS_ORIGIN_REQUEST", "This request came from somewhere else");
    }
  }
  try {
    request.user = verifyToken(presented.token);
  } catch {
    return sendError(reply, 401, "UNAUTHENTICATED", "Your session has ended");
  }
}

/**
 * Returns a preHandler that requires request.user.role to be one of
 * `roles`. Must run after `authenticate`. A denied attempt is audited so
 * it shows up in the future admin/security dashboard (spec §42.18,
 * Success Scenario 8: unauthorized admin-endpoint access is logged).
 */
export function requireRole(pool: Pool, ...roles: AuthTokenPayload["role"][]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      return sendError(reply, 401, "UNAUTHENTICATED", "Not signed in");
    }
    if (!roles.includes(request.user.role)) {
      await recordAuditEvent(pool, {
        eventType: "UNAUTHORIZED_ACCESS_ATTEMPT",
        actorUserId: request.user.sub,
        metadata: { path: request.url, requiredRoles: roles },
      });
      return sendError(reply, 403, "FORBIDDEN", "Insufficient role");
    }
  };
}
