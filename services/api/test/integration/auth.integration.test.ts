import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/index.js";
import { getPool } from "../../src/db.js";

// Requires a real Postgres reachable at DATABASE_URL with migrations
// already applied (see README: `pnpm --filter @fintech-network/api migrate up`).
// This is the integration layer of the payment-adjacent flow the spec
// calls for (§26 Testing Strategy) — here, the auth/RBAC slice of it.

describe("auth + RBAC (integration)", () => {
  let app: FastifyInstance;
  const email = `alice.${Date.now()}@example.com`;
  const password = "correct-horse-battery-staple";

  beforeAll(() => {
    app = buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("rejects a malformed registration payload", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: "not-an-email", password: "short" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("registers a new consumer and returns a token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.user.email).toBe(email.toLowerCase());
    expect(body.user.role).toBe("consumer");
    expect(body.user.passwordHash).toBeUndefined();
    expect(typeof body.token).toBe("string");
  });

  it("rejects a duplicate registration", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password },
    });
    expect(res.statusCode).toBe(409);
  });

  it("rejects login with the wrong password", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password: "wrong-password" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects login for an email that was never registered", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "nobody@example.com", password },
    });
    expect(res.statusCode).toBe(401);
  });

  it("logs in with correct credentials and can read its own profile", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password },
    });
    expect(loginRes.statusCode).toBe(200);
    const { token, user } = loginRes.json();

    const meRes = await app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(meRes.statusCode).toBe(200);
    expect(meRes.json().user.id).toBe(user.id);
  });

  it("rejects /users/me with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/users/me" });
    expect(res.statusCode).toBe(401);
  });

  it("rejects /users/me with a garbage token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("denies a consumer hitting the admin-only route (403) and audits it", async () => {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email, password },
    });
    const { token, user } = loginRes.json();

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/ping",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);

    const pool = getPool();
    const audit = await pool.query(
      `select * from audit_events where event_type = 'UNAUTHORIZED_ACCESS_ATTEMPT' and actor_user_id = $1`,
      [user.id]
    );
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it("rejects the admin-only route with no token at all (401)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/admin/ping" });
    expect(res.statusCode).toBe(401);
  });

  it("recorded a USER_REGISTERED and a LOGIN audit event for this user", async () => {
    const pool = getPool();
    const registered = await pool.query(
      `select * from audit_events where event_type = 'USER_REGISTERED' and metadata->>'email' = $1`,
      [email.toLowerCase()]
    );
    expect(registered.rowCount).toBeGreaterThan(0);

    const loggedIn = await pool.query(
      `select ae.* from audit_events ae
       join users u on u.id = ae.actor_user_id
       where ae.event_type = 'LOGIN' and u.email = $1`,
      [email.toLowerCase()]
    );
    expect(loggedIn.rowCount).toBeGreaterThan(0);
  });
});
