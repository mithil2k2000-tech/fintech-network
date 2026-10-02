import { describe, it, expect } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  ConfigError,
  DEV_JWT_SECRET,
  DEV_ORIGINS,
  loadConfig,
} from "../src/config.js";
import {
  cookieNameFor,
  isOriginAllowed,
  readPresentedToken,
  scopeFromRequest,
} from "../src/modules/identity/session.js";

// Phase 14. The startup guard and the cookie rules are pure functions
// over an environment and a request, so the dangerous cases can be
// tested exhaustively without a deployment or a browser.

const PROD = {
  NODE_ENV: "production",
  JWT_SECRET: "a-real-secret-of-more-than-thirty-two-characters",
  ALLOWED_ORIGINS: "https://app.example.com,https://till.example.com",
};

describe("refusing to start a production deployment that isn't configured", () => {
  it("accepts a production environment that says what it needs to", () => {
    const config = loadConfig(PROD);
    expect(config.production).toBe(true);
    expect(config.allowedOrigins).toEqual([
      "https://app.example.com",
      "https://till.example.com",
    ]);
    expect(config.secureCookies).toBe(true);
  });

  const refusals: [string, NodeJS.ProcessEnv, RegExp][] = [
    ["no secret at all", { ...PROD, JWT_SECRET: undefined }, /JWT_SECRET is not set/],
    [
      "the sample secret from .env.example",
      { ...PROD, JWT_SECRET: DEV_JWT_SECRET },
      /still the sample value/,
    ],
    ["a short secret", { ...PROD, JWT_SECRET: "too-short" }, /at least 32 characters/],
    ["no origins", { ...PROD, ALLOWED_ORIGINS: "" }, /ALLOWED_ORIGINS must list/],
    [
      "a plain-http origin",
      { ...PROD, ALLOWED_ORIGINS: "http://app.example.com" },
      /plain-http origin/,
    ],
    ["a wildcard origin", { ...PROD, ALLOWED_ORIGINS: "*" }, /wildcard/],
  ];

  it.each(refusals)("refuses %s", (_label, env, message) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(message);
  });

  it("says everything that's wrong at once, not one thing per restart", () => {
    try {
      loadConfig({ NODE_ENV: "production" });
      throw new Error("should have refused");
    } catch (err) {
      expect((err as Error).message).toMatch(/JWT_SECRET is not set/);
      expect((err as Error).message).toMatch(/ALLOWED_ORIGINS must list/);
    }
  });

  it("leaves development alone, with the local apps allowed and plain-http cookies", () => {
    const config = loadConfig({ JWT_SECRET: DEV_JWT_SECRET });
    expect(config.production).toBe(false);
    expect(config.allowedOrigins).toEqual([...DEV_ORIGINS]);
    expect(config.secureCookies).toBe(false);
  });

  it("lets a non-production https deployment ask for secure cookies, and never the reverse", () => {
    expect(loadConfig({ SECURE_COOKIES: "true" }).secureCookies).toBe(true);
    // Production can't opt out: the flag only ever adds.
    expect(loadConfig({ ...PROD, SECURE_COOKIES: "false" }).secureCookies).toBe(true);
  });

  it("reads the limits and timeouts, with defaults that hold", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      rateLimitPerMinute: 100,
      authRateLimitPerMinute: 10,
      writeRateLimitPerMinute: 30,
      approvalTtlMinutes: 15,
      loginFailureLimit: 10,
      loginFailureWindowMinutes: 15,
      recipientLookupFailureLimit: 10,
    });
    expect(loadConfig({ PAYMENT_APPROVAL_TTL_MINUTES: "5" }).approvalTtlMinutes).toBe(5);
    // Nonsense falls back rather than disabling the protection.
    expect(loadConfig({ LOGIN_FAILURE_LIMIT: "0" }).loginFailureLimit).toBe(10);
    expect(loadConfig({ LOGIN_FAILURE_LIMIT: "not-a-number" }).loginFailureLimit).toBe(10);
  });
});

function request(headers: Record<string, string>, cookies: Record<string, string> = {}) {
  return { headers, cookies } as unknown as FastifyRequest;
}

describe("which session a request is carrying", () => {
  it("names a cookie per app, so two apps on one machine don't share a session", () => {
    expect(cookieNameFor("consumer")).toBe("fn_session_consumer");
    expect(cookieNameFor("merchant")).toBe("fn_session_merchant");
    expect(cookieNameFor("consumer")).not.toBe(cookieNameFor("merchant"));
  });

  it("only accepts a scope from the list, and defaults to the consumer app", () => {
    expect(scopeFromRequest(request({ "x-session-scope": "merchant" }))).toBe("merchant");
    expect(scopeFromRequest(request({}))).toBe("consumer");
    // A client can't invent a cookie name.
    expect(scopeFromRequest(request({ "x-session-scope": "../../etc" }))).toBe("consumer");
    expect(scopeFromRequest(request({ "x-session-scope": "admin; drop" }))).toBe("consumer");
  });

  it("reads the cookie for the app that asked", () => {
    const presented = readPresentedToken(
      request({ "x-session-scope": "merchant" }, {
        fn_session_consumer: "consumer-token",
        fn_session_merchant: "merchant-token",
      })
    );
    expect(presented).toEqual({ token: "merchant-token", source: "cookie" });
  });

  it("prefers an explicit bearer token over an ambient cookie", () => {
    const presented = readPresentedToken(
      request({ authorization: "Bearer explicit" }, { fn_session_consumer: "ambient" })
    );
    expect(presented).toEqual({ token: "explicit", source: "bearer" });
  });

  it("treats an empty or malformed credential as none at all", () => {
    expect(readPresentedToken(request({}))).toBeNull();
    expect(readPresentedToken(request({ authorization: "Bearer " }))).toBeNull();
    expect(readPresentedToken(request({ authorization: "Basic abc" }))).toBeNull();
    expect(readPresentedToken(request({}, { fn_session_consumer: "" }))).toBeNull();
  });
});

describe("where a cookie is honoured from", () => {
  const allowed = ["https://app.example.com"];

  it("accepts this deployment's own app", () => {
    expect(isOriginAllowed(request({ origin: "https://app.example.com" }), allowed)).toBe(true);
    expect(
      isOriginAllowed(request({ referer: "https://app.example.com/pay" }), allowed)
    ).toBe(true);
  });

  it("refuses anywhere else — which is what a forged request looks like", () => {
    for (const origin of [
      "https://evil.example.com",
      "http://app.example.com",
      "https://app.example.com.evil.com",
      "null",
    ]) {
      expect(isOriginAllowed(request({ origin }), allowed), origin).toBe(false);
    }
    expect(isOriginAllowed(request({ referer: "https://evil.example.com/x" }), allowed)).toBe(
      false
    );
    expect(isOriginAllowed(request({ referer: "not a url" }), allowed)).toBe(false);
  });

  it("allows a request that isn't from a browser at all", () => {
    // No Origin, no Referer: curl, a server, a test. There's no ambient
    // cookie for a third party to ride, so there's nothing to forge.
    expect(isOriginAllowed(request({}), allowed)).toBe(true);
  });
});
