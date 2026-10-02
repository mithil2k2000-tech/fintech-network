import type { FastifyReply, FastifyRequest } from "fastify";

// How a browser holds a session (spec §14, Phase 14).
//
// Until now the token lived in sessionStorage, where any script on the
// page could read it: one XSS bug and someone's session walks out the
// door. It now travels in an httpOnly cookie, which JavaScript cannot
// read at all.
//
// That trade has a cost, and it's the reason for the rest of this file.
// A cookie is *ambient*: the browser attaches it to requests the page
// didn't mean to make, which is what cross-site request forgery
// exploits. Two things answer that:
//
//   * SameSite=Strict — the browser won't send this cookie on any
//     request that started from another site.
//   * An origin check at the door (`isOriginAllowed`) — a cookie is
//     only honoured when the request says it came from one of this
//     deployment's own apps, or says nothing at all (a non-browser
//     client, which has no ambient cookie to steal).
//
// The bearer token still works for API clients and tests. It carries no
// ambient authority, so it isn't subject to either rule.

/**
 * Which app a session belongs to. Cookies ignore port numbers, so on a
 * developer's machine the consumer app (:5180) and the merchant app
 * (:5181) share one cookie jar — without a name per app, signing into
 * one would sign you out of the other. In production these are separate
 * hostnames and it wouldn't matter; the scoping costs nothing there and
 * makes both apps usable side by side here.
 *
 * This is a namespace, not a permission: a session cookie is the same
 * session whichever name it sits under. The allow-list exists so a
 * client can't make up a cookie name.
 */
export const SESSION_SCOPES = ["consumer", "merchant", "admin"] as const;
export type SessionScope = (typeof SESSION_SCOPES)[number];

export const SESSION_SCOPE_HEADER = "x-session-scope";
const COOKIE_PREFIX = "fn_session";

export function cookieNameFor(scope: SessionScope): string {
  return `${COOKIE_PREFIX}_${scope}`;
}

/** The scope a request declares, defaulting to the consumer app. */
export function scopeFromRequest(request: FastifyRequest): SessionScope {
  const raw = request.headers[SESSION_SCOPE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (SESSION_SCOPES as readonly string[]).includes(value ?? "")
    ? (value as SessionScope)
    : "consumer";
}

export interface SessionCookieOptions {
  secure: boolean;
  /** Matches the token's own lifetime, so neither outlives the other. */
  maxAgeSeconds: number;
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  scope: SessionScope,
  options: SessionCookieOptions
): void {
  reply.setCookie(cookieNameFor(scope), token, {
    httpOnly: true,
    sameSite: "strict",
    secure: options.secure,
    path: "/api",
    maxAge: options.maxAgeSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply, scope: SessionScope, secure: boolean): void {
  reply.clearCookie(cookieNameFor(scope), {
    httpOnly: true,
    sameSite: "strict",
    secure,
    path: "/api",
  });
}

/**
 * True when a browser request came from one of this deployment's apps.
 * A request with no Origin and no Referer isn't a browser navigation or
 * fetch — it's curl, a server, or a test — so there's no ambient cookie
 * to forge and nothing to check.
 */
export function isOriginAllowed(request: FastifyRequest, allowedOrigins: string[]): boolean {
  const origin = request.headers.origin;
  if (typeof origin === "string" && origin.length > 0) {
    return allowedOrigins.includes(origin);
  }
  const referer = request.headers.referer;
  if (typeof referer === "string" && referer.length > 0) {
    try {
      return allowedOrigins.includes(new URL(referer).origin);
    } catch {
      return false;
    }
  }
  return true;
}

export interface PresentedToken {
  token: string;
  /** How it arrived. A cookie is ambient; a bearer token is not. */
  source: "cookie" | "bearer";
}

/**
 * The token on a request, if there is one. The bearer header wins when
 * both are present: an explicit credential beats an ambient one.
 */
export function readPresentedToken(request: FastifyRequest): PresentedToken | null {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token.length > 0) return { token, source: "bearer" };
  }
  const cookies = (request as FastifyRequest & { cookies?: Record<string, string | undefined> })
    .cookies;
  const fromCookie = cookies?.[cookieNameFor(scopeFromRequest(request))];
  if (fromCookie && fromCookie.length > 0) return { token: fromCookie, source: "cookie" };
  return null;
}
