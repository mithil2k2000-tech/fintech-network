import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/index.js";
import { getPool } from "../../src/db.js";
import {
  SimulatedPaymentProvider,
  type RiskEvaluator,
} from "../../src/modules/payments/index.js";

// Requires a real Postgres reachable at DATABASE_URL with migrations
// applied, and JWT_SECRET set.

const PASSWORD = "correct-horse-battery-staple";
const STARTING_BALANCE = 50_000;
const run = Date.now();

interface TestUser {
  id: string;
  email: string;
  token: string;
}

async function register(app: FastifyInstance, name: string): Promise<TestUser> {
  const email = `${name}.${run}@example.com`;
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { id: body.user.id, email: body.user.email, token: body.token };
}

function auth(user: TestUser) {
  return { authorization: `Bearer ${user.token}` };
}

async function balanceOf(app: FastifyInstance, user: TestUser): Promise<number> {
  const res = await app.inject({
    method: "GET",
    url: "/api/v1/accounts/me",
    headers: auth(user),
  });
  expect(res.statusCode).toBe(200);
  return res.json().account.balanceMinorUnits;
}

async function create(
  app: FastifyInstance,
  payer: TestUser,
  payload: Record<string, unknown>
) {
  return app.inject({
    method: "POST",
    url: "/api/v1/payments",
    headers: auth(payer),
    payload,
  });
}

async function confirm(
  app: FastifyInstance,
  payer: TestUser,
  id: string,
  payload: Record<string, unknown> = {}
) {
  return app.inject({
    method: "POST",
    url: `/api/v1/payments/${id}/confirm`,
    headers: auth(payer),
    payload,
  });
}

describe("payments (integration)", () => {
  let app: FastifyInstance;
  let alice: TestUser;
  let bob: TestUser;
  let mallory: TestUser;
  let paymentId: string;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    alice = await register(app, "alice-pay");
    bob = await register(app, "bob-pay");
    mallory = await register(app, "mallory-pay");
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates a payment that's risk-evaluated and waiting for confirmation", async () => {
    const res = await create(app, alice, {
      recipientEmail: bob.email,
      amountMinorUnits: 2_000,
      purpose: "Dinner",
    });
    expect(res.statusCode).toBe(201);
    const { payment } = res.json();
    paymentId = payment.id;
    expect(payment.status).toBe("APPROVED");
    expect(payment.direction).toBe("outgoing");
    expect(payment.amountMinorUnits).toBe(2_000);
    expect(payment.purpose).toBe("Dinner");
    expect(payment.risk.level).toBe("LOW");
    expect(payment.counterparty.displayName).toBe(bob.email);
    expect(payment.transactionId).toBeNull();

    // Nothing has moved yet.
    expect(await balanceOf(app, alice)).toBe(STARTING_BALANCE);
    expect(await balanceOf(app, bob)).toBe(STARTING_BALANCE);
  });

  it.each([
    ["a fractional amount", 12.5],
    ["a zero amount", 0],
    ["a negative amount", -100],
    ["an amount over the per-payment cap", 1_000_001],
    ["a string amount", "2000"],
  ])("rejects %s", async (_label, amountMinorUnits) => {
    const res = await create(app, alice, {
      recipientEmail: bob.email,
      amountMinorUnits,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });

  it("rejects unknown fields in the body", async () => {
    const res = await create(app, alice, {
      recipientEmail: bob.email,
      amountMinorUnits: 100,
      payerUserId: bob.id,
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown recipient", async () => {
    const res = await create(app, alice, {
      recipientEmail: `nobody.${run}@example.com`,
      amountMinorUnits: 100,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("RECIPIENT_NOT_FOUND");
  });

  it("rejects paying yourself", async () => {
    const res = await create(app, alice, {
      recipientEmail: alice.email,
      amountMinorUnits: 100,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("SELF_PAYMENT");
  });

  it("rejects creating a payment without a token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/payments",
      payload: { recipientEmail: bob.email, amountMinorUnits: 100 },
    });
    expect(res.statusCode).toBe(401);
  });

  it("hides an unconfirmed payment from the payee", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/payments/${paymentId}`,
      headers: auth(bob),
    });
    expect(res.statusCode).toBe(404);
  });

  it("won't let another user read or confirm someone else's payment (IDOR)", async () => {
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/payments/${paymentId}`,
      headers: auth(mallory),
    });
    expect(read.statusCode).toBe(404);

    const conf = await confirm(app, mallory, paymentId);
    expect(conf.statusCode).toBe(404);

    const cancel = await app.inject({
      method: "POST",
      url: `/api/v1/payments/${paymentId}/cancel`,
      headers: auth(mallory),
    });
    expect(cancel.statusCode).toBe(404);
  });

  it("rejects a malformed payment id without touching the database", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/payments/not-a-uuid",
      headers: auth(alice),
    });
    expect(res.statusCode).toBe(400);
  });

  it("completes on confirmation and moves exactly the right amount", async () => {
    const res = await confirm(app, alice, paymentId);
    expect(res.statusCode).toBe(200);
    const { payment } = res.json();
    expect(payment.status).toBe("COMPLETED");
    expect(payment.transactionId).toEqual(expect.any(String));

    expect(await balanceOf(app, alice)).toBe(STARTING_BALANCE - 2_000);
    expect(await balanceOf(app, bob)).toBe(STARTING_BALANCE + 2_000);
  });

  it("is idempotent: confirming again doesn't charge twice", async () => {
    const res = await confirm(app, alice, paymentId);
    expect(res.statusCode).toBe(200);
    expect(res.json().payment.status).toBe("COMPLETED");
    expect(await balanceOf(app, alice)).toBe(STARTING_BALANCE - 2_000);
    expect(await balanceOf(app, bob)).toBe(STARTING_BALANCE + 2_000);
  });

  it("shows the completed payment to the payee as incoming", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/payments/${paymentId}`,
      headers: auth(bob),
    });
    expect(res.statusCode).toBe(200);
    const { payment } = res.json();
    expect(payment.direction).toBe("incoming");
    expect(payment.counterparty.displayName).toBe(alice.email);
  });

  it("lists payments for both sides", async () => {
    const aliceList = await app.inject({
      method: "GET",
      url: "/api/v1/payments",
      headers: auth(alice),
    });
    const bobList = await app.inject({
      method: "GET",
      url: "/api/v1/payments",
      headers: auth(bob),
    });
    const aliceItem = aliceList.json().payments.find((p: any) => p.id === paymentId);
    const bobItem = bobList.json().payments.find((p: any) => p.id === paymentId);
    expect(aliceItem.direction).toBe("outgoing");
    expect(bobItem.direction).toBe("incoming");
    // Mallory sees none of it.
    const malloryList = await app.inject({
      method: "GET",
      url: "/api/v1/payments",
      headers: auth(mallory),
    });
    expect(malloryList.json().payments).toHaveLength(0);
  });

  it("can't cancel a completed payment", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/payments/${paymentId}/cancel`,
      headers: auth(alice),
    });
    expect(res.statusCode).toBe(409);
  });

  it("lets the payer cancel before confirming, and then refuses to confirm", async () => {
    const created = await create(app, alice, {
      recipientEmail: bob.email,
      amountMinorUnits: 300,
    });
    const id = created.json().payment.id;

    const cancelled = await app.inject({
      method: "POST",
      url: `/api/v1/payments/${id}/cancel`,
      headers: auth(alice),
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().payment).toMatchObject({
      status: "FAILED",
      failureReason: "CANCELLED_BY_PAYER",
    });

    const conf = await confirm(app, alice, id);
    expect(conf.statusCode).toBe(409);
    expect(await balanceOf(app, alice)).toBe(STARTING_BALANCE - 2_000);
  });

  it("fails cleanly on insufficient funds and leaves balances untouched", async () => {
    const created = await create(app, alice, {
      recipientEmail: bob.email,
      amountMinorUnits: 60_000,
    });
    const id = created.json().payment.id;

    // £600 to someone she's never paid, more than her whole balance:
    // since Phase 12 the real engine rates this HIGH, so it takes an
    // explicit acknowledgement before it will even be attempted.
    expect(created.json().payment.risk.level).toBe("HIGH");
    expect((await confirm(app, alice, id)).statusCode).toBe(409);

    const res = await confirm(app, alice, id, { acknowledgeRisk: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().payment).toMatchObject({
      status: "FAILED",
      failureReason: "INSUFFICIENT_FUNDS",
      transactionId: null,
    });
    expect(await balanceOf(app, alice)).toBe(STARTING_BALANCE - 2_000);
    expect(await balanceOf(app, bob)).toBe(STARTING_BALANCE + 2_000);
  });

  it("never double-spends: two concurrent payments that together exceed the balance", async () => {
    const carol = await register(app, "carol-pay");
    const [p1, p2] = await Promise.all([
      create(app, carol, { recipientEmail: bob.email, amountMinorUnits: 30_000 }),
      create(app, carol, { recipientEmail: bob.email, amountMinorUnits: 30_000 }),
    ]);
    const ids = [p1.json().payment.id, p2.json().payment.id];

    // Both are £300 to a new payee and each would take most of her
    // balance, so both come back HIGH: acknowledged, then raced.
    const results = await Promise.all(
      ids.map((id) => confirm(app, carol, id, { acknowledgeRisk: true }))
    );
    const statuses = results.map((r) => r.json().payment.status).sort();
    expect(statuses).toEqual(["COMPLETED", "FAILED"]);
    const failed = results.find((r) => r.json().payment.status === "FAILED")!;
    expect(failed.json().payment.failureReason).toBe("INSUFFICIENT_FUNDS");

    expect(await balanceOf(app, carol)).toBe(STARTING_BALANCE - 30_000);
  });

  it("never double-charges: the same payment confirmed twice at once", async () => {
    const dave = await register(app, "dave-pay");
    const created = await create(app, dave, {
      recipientEmail: bob.email,
      amountMinorUnits: 1_000,
    });
    const id = created.json().payment.id;

    const results = await Promise.all([
      confirm(app, dave, id),
      confirm(app, dave, id),
      confirm(app, dave, id),
    ]);
    for (const r of results) expect([200, 409]).toContain(r.statusCode);
    expect(results.some((r) => r.statusCode === 200)).toBe(true);

    expect(await balanceOf(app, dave)).toBe(STARTING_BALANCE - 1_000);

    const pool = getPool();
    const ledger = await pool.query(
      `select count(*)::int as n from ledger_entries le
       join payments p on p.transaction_id = le.transaction_id
       where p.id = $1`,
      [id]
    );
    expect(ledger.rows[0].n).toBe(2);
  });

  it("writes the audit trail for a completed payment", async () => {
    const pool = getPool();
    const result = await pool.query(
      `select event_type from audit_events
       where metadata->>'paymentId' = $1
       order by created_at`,
      [paymentId]
    );
    const types = result.rows.map((r) => r.event_type);
    expect(types).toEqual(
      expect.arrayContaining([
        "PAYMENT_CREATED",
        "RISK_EVALUATED",
        "PAYMENT_APPROVED",
        "LEDGER_POSTED",
        "PAYMENT_COMPLETED",
      ])
    );
  });

  it("keeps the whole ledger balanced and every completed payment matched to its entries", async () => {
    const pool = getPool();
    const totals = await pool.query(
      `select
         coalesce(sum(amount_minor_units) filter (where direction = 'debit'), 0)::bigint as debits,
         coalesce(sum(amount_minor_units) filter (where direction = 'credit'), 0)::bigint as credits
       from ledger_entries`
    );
    expect(totals.rows[0].debits).toBe(totals.rows[0].credits);

    const mismatched = await pool.query(
      `select p.id from payments p
       join ledger_entries le on le.transaction_id = p.transaction_id
       where p.status = 'COMPLETED'
       group by p.id, p.amount_minor_units
       having sum(le.amount_minor_units) filter (where le.direction = 'debit') <> p.amount_minor_units
           or sum(le.amount_minor_units) filter (where le.direction = 'credit') <> p.amount_minor_units`
    );
    expect(mismatched.rowCount).toBe(0);
  });
});

describe("payments with high risk, provider declines and evaluator failures (integration)", () => {
  let app: FastifyInstance;
  let erin: TestUser;
  let frank: TestUser;

  // Stand-in for the Phase 12 engine — proves the payment flow already
  // handles every outcome that engine can produce.
  const stubRisk: RiskEvaluator = {
    async evaluate(input) {
      if (input.amountMinorUnits === 999) throw new Error("risk backend exploded");
      if (input.amountMinorUnits >= 40_000) {
        return {
          level: "HIGH",
          reasons: ["Unusual amount", "New recipient"],
          evaluator: "test-stub",
        };
      }
      return { level: "LOW", reasons: [], evaluator: "test-stub" };
    },
  };

  beforeAll(async () => {
    app = buildApp({
      logger: false,
      riskEvaluator: stubRisk,
      paymentProvider: new SimulatedPaymentProvider({
        declineWhen: (r) => (r.amountMinorUnits === 1_234 ? "Simulated bank decline" : null),
      }),
    });
    erin = await register(app, "erin-pay");
    frank = await register(app, "frank-pay");
  });

  afterAll(async () => {
    await app.close();
  });

  it("requires explicit acknowledgement before a HIGH-risk payment can go through", async () => {
    const created = await create(app, erin, {
      recipientEmail: frank.email,
      amountMinorUnits: 45_000,
    });
    expect(created.statusCode).toBe(201);
    const { payment } = created.json();
    expect(payment.risk).toEqual({
      level: "HIGH",
      reasons: ["Unusual amount", "New recipient"],
    });

    const blocked = await confirm(app, erin, payment.id);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      code: "RISK_ACKNOWLEDGEMENT_REQUIRED",
      details: { reasons: ["Unusual amount", "New recipient"] },
    });
    expect(await balanceOf(app, erin)).toBe(STARTING_BALANCE);

    const acknowledged = await confirm(app, erin, payment.id, { acknowledgeRisk: true });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json().payment.status).toBe("COMPLETED");
    expect(await balanceOf(app, erin)).toBe(STARTING_BALANCE - 45_000);
  });

  it("marks a provider decline as FAILED and moves no money", async () => {
    const created = await create(app, frank, {
      recipientEmail: erin.email,
      amountMinorUnits: 1_234,
    });
    const before = await balanceOf(app, frank);
    const res = await confirm(app, frank, created.json().payment.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().payment.status).toBe("FAILED");
    expect(res.json().payment.failureReason).toMatch(/^PROVIDER_DECLINED/);
    expect(await balanceOf(app, frank)).toBe(before);
  });

  it("doesn't strand a payment when risk evaluation blows up, and doesn't leak the error", async () => {
    const res = await create(app, frank, {
      recipientEmail: erin.email,
      amountMinorUnits: 999,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Something went wrong",
    });
    expect(JSON.stringify(res.json())).not.toMatch(/exploded/);

    const pool = getPool();
    const rows = await pool.query(
      `select status, failure_reason from payments
       where payer_user_id = $1 and amount_minor_units = 999`,
      [frank.id]
    );
    expect(rows.rows).toEqual([
      { status: "FAILED", failure_reason: "RISK_EVALUATION_ERROR" },
    ]);
  });
});
