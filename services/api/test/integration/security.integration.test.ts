import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/index.js";
import { getPool } from "../../src/db.js";
import { cookieNameFor } from "../../src/modules/identity/session.js";

// Phase 14, against a real Postgres. What's being checked here is the
// session itself: how it arrives, where it's honoured, and what happens
// when someone leans on it.

const PASSWORD = "correct-horse-battery-staple";
const run = Date.now();
const APP_ORIGIN = "http://localhost:5180";
const CONSUMER_COOKIE = cookieNameFor("consumer");

interface TestUser {
  id: string;
  email: string;
  token: string;
}

describe("sessions and hardening (integration)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    // The per-client rate limits are raised here so the thing under
    // test is the per-account throttle rather than the blanket one —
    // otherwise the tenth wrong password is refused by the wrong
    // defence and proves nothing.
    app = buildApp({
      logger: false,
      rateLimitPerMinute: 1_000,
      authRateLimitPerMinute: 1_000,
      writeRateLimitPerMinute: 1_000,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const register = async (name: string): Promise<TestUser> => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: `${name}.${run}@example.com`, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    return { id: body.user.id, email: body.user.email, token: body.token };
  };

  it("sets a session cookie a script can't read, scoped to the app that asked", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: `cookie.${run}@example.com`, password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);

    const cookie = res.cookies.find((c) => c.name === CONSUMER_COOKIE);
    expect(cookie, "a session cookie is set on registering").toBeDefined();
    expect(cookie!.httpOnly).toBe(true);
    expect(cookie!.sameSite?.toLowerCase()).toBe("strict");
    expect(cookie!.path).toBe("/api");
    // Matches the token's own lifetime, so neither outlives the other.
    expect(cookie!.maxAge).toBe(3600);
    // Development is plain http, so the Secure flag would stop the
    // cookie working at all. Production can't choose this — see the
    // config unit tests.
    expect(cookie!.secure).toBeFalsy();

    // The till app gets a cookie of its own, so signing into one app
    // doesn't sign you out of the other on a machine where both run.
    const merchant = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "x-session-scope": "merchant" },
      payload: { email: `cookie.${run}@example.com`, password: PASSWORD },
    });
    expect(merchant.cookies.map((c) => c.name)).toEqual([cookieNameFor("merchant")]);
  });

  it("signs a request in by cookie alone, with no token in sight", async () => {
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: `cookieonly.${run}@example.com`, password: PASSWORD },
    });
    const value = registered.cookies.find((c) => c.name === CONSUMER_COOKIE)!.value;

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: { origin: APP_ORIGIN },
      cookies: { [CONSUMER_COOKIE]: value },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe(`cookieonly.${run}@example.com`);
  });

  it("refuses that same cookie when the request came from another site", async () => {
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: `csrf.${run}@example.com`, password: PASSWORD },
    });
    const value = registered.cookies.find((c) => c.name === CONSUMER_COOKIE)!.value;

    // A forged request: the browser would attach the cookie, and the
    // page it came from is not ours. SameSite=Strict should already have
    // stopped it; this is the second lock.
    const forged = await app.inject({
      method: "POST",
      url: "/api/v1/payments",
      headers: { origin: "https://evil.example.com" },
      cookies: { [CONSUMER_COOKIE]: value },
      payload: { recipientEmail: `nobody.${run}@example.com`, amountMinorUnits: 100 },
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().code).toBe("CROSS_ORIGIN_REQUEST");

    // The same request from the app itself is fine (it fails later, on
    // the recipient, which is how we know it got past the door).
    const ours = await app.inject({
      method: "POST",
      url: "/api/v1/payments",
      headers: { origin: APP_ORIGIN },
      cookies: { [CONSUMER_COOKIE]: value },
      payload: { recipientEmail: `nobody.${run}@example.com`, amountMinorUnits: 100 },
    });
    expect(ours.statusCode).toBe(404);
    expect(ours.json().code).toBe("RECIPIENT_NOT_FOUND");
  });

  it("still takes a bearer token, from anywhere, because it isn't ambient", async () => {
    const user = await register("bearer");
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: { authorization: `Bearer ${user.token}`, origin: "https://evil.example.com" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("ends the session on sign-out, even when the session has already gone", async () => {
    const registered = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: `logout.${run}@example.com`, password: PASSWORD },
    });
    const value = registered.cookies.find((c) => c.name === CONSUMER_COOKIE)!.value;

    const out = await app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers: { origin: APP_ORIGIN },
      cookies: { [CONSUMER_COOKIE]: value },
    });
    expect(out.statusCode).toBe(204);
    const cleared = out.cookies.find((c) => c.name === CONSUMER_COOKIE);
    expect(cleared!.value).toBe("");

    // Signing out is always allowed: refusing an unauthenticated
    // sign-out would leave the cookie sitting in the browser.
    const again = await app.inject({ method: "POST", url: "/api/v1/auth/logout" });
    expect(again.statusCode).toBe(204);
  });

  it("turns away a nonsense cookie without ending anything else", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: { origin: APP_ORIGIN },
      cookies: { [CONSUMER_COOKIE]: "not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHENTICATED");
  });

  it("holds an account off after too many failed sign-ins, whoever is trying", async () => {
    const user = await register("throttled");
    const attempt = (password: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: user.email, password },
      });

    for (let i = 0; i < 10; i += 1) {
      const res = await attempt("wrong-password-entirely");
      expect(res.statusCode, `attempt ${i + 1}`).toBe(401);
    }

    // The eleventh is refused before the password is even considered —
    // and so is the right password, which is the cost of this defence
    // and the reason the window is short.
    const held = await attempt(PASSWORD);
    expect(held.statusCode).toBe(429);
    expect(held.json().code).toBe("TOO_MANY_ATTEMPTS");
    expect(held.cookies).toHaveLength(0);

    const pool = getPool();
    const audited = await pool.query(
      `select count(*)::int as n from audit_events
       where event_type = 'LOGIN_THROTTLED' and metadata->>'email' = $1`,
      [user.email]
    );
    expect(audited.rows[0].n).toBeGreaterThan(0);
  });

  it("counts failures against an address that was never registered too", async () => {
    // Otherwise the throttle itself would answer "does this account
    // exist?" — refusing quickly for real accounts and not for others.
    const unknown = `ghost.${run}@example.com`;
    for (let i = 0; i < 10; i += 1) {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { email: unknown, password: "guessing" },
      });
      expect(res.statusCode).toBe(401);
    }
    const held = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: unknown, password: "guessing" },
    });
    expect(held.statusCode).toBe(429);
  });

  it("stops answering a payer who keeps naming addresses that don't exist", async () => {
    const payer = await register("enumerator");
    const pay = (email: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/payments",
        headers: { authorization: `Bearer ${payer.token}` },
        payload: { recipientEmail: email, amountMinorUnits: 100 },
      });

    for (let i = 0; i < 10; i += 1) {
      const res = await pay(`probe${i}.${run}@example.com`);
      expect(res.statusCode, `probe ${i}`).toBe(404);
    }

    const held = await pay(`probe10.${run}@example.com`);
    expect(held.statusCode).toBe(429);
    expect(held.json().code).toBe("TOO_MANY_LOOKUPS");

    // Someone who mistypes once isn't affected by any of this.
    const innocent = await register("mistyper");
    const typo = await app.inject({
      method: "POST",
      url: "/api/v1/payments",
      headers: { authorization: `Bearer ${innocent.token}` },
      payload: { recipientEmail: `typo.${run}@example.com`, amountMinorUnits: 100 },
    });
    expect(typo.statusCode).toBe(404);
    expect(typo.json().code).toBe("RECIPIENT_NOT_FOUND");
  });

  it("won't confirm a payment that sat on the review screen too long", async () => {
    const payer = await register("staler");
    const payee = await register("stalee");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/payments",
      headers: { authorization: `Bearer ${payer.token}` },
      payload: { recipientEmail: payee.email, amountMinorUnits: 1_000 },
    });
    expect(created.statusCode).toBe(201);
    const payment = created.json().payment;

    // Age it: the risk decision on this payment was made against a
    // balance and a history that have moved on since.
    const pool = getPool();
    await pool.query(`update payments set created_at = now() - interval '2 hours' where id = $1`, [
      payment.id,
    ]);

    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/payments/${payment.id}/confirm`,
      headers: { authorization: `Bearer ${payer.token}` },
      payload: {},
    });
    expect(confirmed.statusCode).toBe(409);
    expect(confirmed.json().code).toBe("PAYMENT_EXPIRED");

    // Nothing moved, the payment is on file as failed with the reason,
    // and it can't be confirmed later either.
    const balance = await app.inject({
      method: "GET",
      url: "/api/v1/accounts/me",
      headers: { authorization: `Bearer ${payer.token}` },
    });
    expect(balance.json().account.balanceMinorUnits).toBe(50_000);

    const row = await pool.query<{ status: string; failure_reason: string }>(
      `select status, failure_reason from payments where id = $1`,
      [payment.id]
    );
    expect(row.rows[0]).toMatchObject({ status: "FAILED", failure_reason: "APPROVAL_EXPIRED" });

    const retry = await app.inject({
      method: "POST",
      url: `/api/v1/payments/${payment.id}/confirm`,
      headers: { authorization: `Bearer ${payer.token}` },
      payload: {},
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json().code).toBe("INVALID_PAYMENT_STATE");
  });

  it("confirms a payment started a moment ago, as always", async () => {
    const payer = await register("prompt-payer");
    const payee = await register("prompt-payee");
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/payments",
      headers: { authorization: `Bearer ${payer.token}` },
      payload: { recipientEmail: payee.email, amountMinorUnits: 1_000 },
    });
    const payment = created.json().payment;
    const confirmed = await app.inject({
      method: "POST",
      url: `/api/v1/payments/${payment.id}/confirm`,
      headers: { authorization: `Bearer ${payer.token}` },
      payload: payment.risk.level === "HIGH" ? { acknowledgeRisk: true } : {},
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().payment.status).toBe("COMPLETED");
  });
});
