import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/index.js";
import { getPool } from "../../src/db.js";
import { MetricsRegistry } from "../../src/observability/metrics.js";
import { getReadiness } from "../../src/health.js";

// Phase 15, against a real Postgres. The operations view is only worth
// anything if its numbers agree with the tables they came from, so
// that's what most of this checks.

const PASSWORD = "correct-horse-battery-staple";
const run = Date.now();

describe("observability (integration)", () => {
  let app: FastifyInstance;
  let metrics: MetricsRegistry;
  let admin: { id: string; email: string; token: string };
  let consumer: { id: string; email: string; token: string };

  const register = async (name: string) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email: `${name}.${run}@example.com`, password: PASSWORD },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json();
    return { id: body.user.id, email: body.user.email, token: body.token };
  };

  beforeAll(async () => {
    metrics = new MetricsRegistry();
    app = buildApp({ logger: false, metrics, rateLimitPerMinute: 1_000 });
    consumer = await register("obs-consumer");
    admin = await register("obs-admin");
    // There is no public path to an admin account, which is the point —
    // so a test makes one the same way an operator would, in the
    // database. The token is re-issued by signing in again so it
    // carries the new role.
    await getPool().query(`update users set role = 'admin' where id = $1`, [admin.id]);
    const signedIn = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: admin.email, password: PASSWORD },
    });
    admin.token = signedIn.json().token;
    expect(signedIn.json().user.role).toBe("admin");
  });

  afterAll(async () => {
    await app.close();
  });

  describe("health", () => {
    it("answers liveness without touching the database", async () => {
      const res = await app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "ok", service: "api" });
    });

    it("answers readiness by actually asking the database", async () => {
      const res = await app.inject({ method: "GET", url: "/health/ready" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ready");
      expect(body.checks.database.ok).toBe(true);
      expect(body.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("reports not ready, rather than throwing, when the database can't be reached", async () => {
      // Asked directly, because the point is what happens when the
      // query fails — and a route that throws here would take the
      // instance down instead of reporting it unhealthy.
      const readiness = await getReadiness({
        async query() {
          throw new Error("connect ECONNREFUSED 127.0.0.1:5432");
        },
      });
      expect(readiness.status).toBe("not_ready");
      expect(readiness.checks.database.ok).toBe(false);
      expect(readiness.checks.database.error).toMatch(/ECONNREFUSED/);
    });
  });

  describe("metrics", () => {
    it("counts requests by route pattern, never by path", async () => {
      await app.inject({ method: "GET", url: "/health" });
      await app.inject({ method: "GET", url: "/health" });
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toContain("text/plain");

      expect(metrics.requests.get({ method: "GET", route: "/health", status: "200" })).toBeGreaterThanOrEqual(2);
      expect(res.body).toContain('http_requests_total{method="GET",route="/health",status="200"}');
      expect(metrics.duration.snapshot({ method: "GET", route: "/health" }).count).toBeGreaterThanOrEqual(2);
    });

    it("keeps identifiers out of the labels", async () => {
      const made = await app.inject({
        method: "POST",
        url: "/api/v1/payments",
        headers: { authorization: `Bearer ${consumer.token}` },
        payload: { recipientEmail: admin.email, amountMinorUnits: 500 },
      });
      const paymentId = made.json().payment.id;
      await app.inject({
        method: "GET",
        url: `/api/v1/payments/${paymentId}`,
        headers: { authorization: `Bearer ${consumer.token}` },
      });

      const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
      expect(body).toContain('route="/api/v1/payments/:id"');
      expect(body).not.toContain(paymentId);
      expect(body).not.toContain(consumer.email);
    });

    it("collapses a path that matched nothing instead of echoing it back", async () => {
      await app.inject({ method: "GET", url: "/api/v1/definitely-not-a-route-8f3a" });
      const body = (await app.inject({ method: "GET", url: "/metrics" })).body;
      expect(body).toContain('route="unmatched_api"');
      expect(body).not.toContain("definitely-not-a-route");
    });
  });

  describe("the operations view", () => {
    it("is admin-only, at every step", async () => {
      const anonymous = await app.inject({ method: "GET", url: "/api/v1/admin/overview" });
      expect(anonymous.statusCode).toBe(401);

      const asConsumer = await app.inject({
        method: "GET",
        url: "/api/v1/admin/overview",
        headers: { authorization: `Bearer ${consumer.token}` },
      });
      expect(asConsumer.statusCode).toBe(403);

      // And the refusal is on file, as it has been since Phase 2.
      const audited = await getPool().query(
        `select count(*)::int as n from audit_events
         where event_type = 'UNAUTHORIZED_ACCESS_ATTEMPT' and actor_user_id = $1`,
        [consumer.id]
      );
      expect(audited.rows[0].n).toBeGreaterThan(0);
    });

    it("agrees with the tables it counted", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/overview?windowHours=720",
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(res.statusCode, res.body).toBe(200);
      const { overview } = res.json();
      const pool = getPool();

      // The books balance, checked live rather than reported from a
      // stored number.
      expect(overview.ledger.balanced).toBe(true);
      expect(overview.ledger.unbalancedTransactions).toBe(0);
      expect(overview.ledger.negativeOwnerAccounts).toBe(0);
      const entries = await pool.query<{ n: string }>(
        `select count(*)::text as n from ledger_entries`
      );
      expect(overview.ledger.entries).toBe(Number(entries.rows[0].n));

      // What cashback has cost: the reserve's balance is exactly what it
      // has paid out, negated. That equality is the whole reason the
      // reward goes through the ledger instead of being a number
      // somewhere.
      const granted = await pool.query<{ total: string }>(
        `select coalesce(sum(amount_minor_units), 0)::text as total from cashback_grants`
      );
      expect(overview.rewards.paidOutMinorUnits).toBe(Number(granted.rows[0].total));
      expect(overview.rewards.reserveBalanceMinorUnits).toBe(
        -overview.rewards.paidOutMinorUnits
      );

      // Payments and risk are counted from their own tables.
      const completed = await pool.query<{ n: string }>(
        `select count(*)::text as n from payments
         where status = 'COMPLETED' and created_at > now() - interval '720 hours'`
      );
      const reported = overview.payments.byStatus.find(
        (row: { status: string }) => row.status === "COMPLETED"
      );
      expect(reported?.count).toBe(Number(completed.rows[0].n));

      const high = await pool.query<{ n: string }>(
        `select count(*)::text as n from risk_assessments
         where level = 'HIGH' and created_at > now() - interval '720 hours'`
      );
      const reportedHigh = overview.risk.byLevel.find(
        (row: { level: string }) => row.level === "HIGH"
      );
      expect(reportedHigh?.count ?? 0).toBe(Number(high.rows[0].n));
    });

    it("shows which risk rules actually fire, so a dead rule is visible", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/overview?windowHours=720",
        headers: { authorization: `Bearer ${admin.token}` },
      });
      const rules = res.json().overview.risk.firedRules as { rule: string; count: number }[];
      expect(rules.length).toBeGreaterThan(0);
      expect(rules.map((r) => r.rule)).toContain("NEW_PAYEE");
      // Ordered by how often, which is what makes the shape readable.
      const counts = rules.map((r) => r.count);
      expect([...counts]).toEqual([...counts].sort((a, b) => b - a));
    });

    it("clamps a silly window instead of scanning the whole history", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/overview?windowHours=99999",
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().overview.windowHours).toBe(24 * 90);

      const nonsense = await app.inject({
        method: "GET",
        url: "/api/v1/admin/overview?windowHours=lots",
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(nonsense.statusCode).toBe(400);
    });

    it("still answers the RBAC ping it grew out of", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/admin/ping",
        headers: { authorization: `Bearer ${admin.token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ pong: true });
    });
  });
});
