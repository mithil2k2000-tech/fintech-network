import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/index.js";
import { getPool } from "../../src/db.js";
import { getAssessmentForPayment } from "../../src/modules/risk/index.js";

// Requires a real Postgres at DATABASE_URL with migrations applied, and
// JWT_SECRET set.

const PASSWORD = "correct-horse-battery-staple";
const run = Date.now();
const STARTING_BALANCE = 50_000;

interface TestUser {
  id: string;
  email: string;
  token: string;
}

async function register(app: FastifyInstance, name: string): Promise<TestUser> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/auth/register",
    payload: { email: `${name}.${run}@example.com`, password: PASSWORD },
  });
  expect(res.statusCode).toBe(201);
  const b = res.json();
  return { id: b.user.id, email: b.user.email, token: b.token };
}

function call(
  app: FastifyInstance,
  user: TestUser | null,
  method: "GET" | "POST",
  url: string,
  payload?: unknown
) {
  return app.inject({
    method,
    url,
    headers: user ? { authorization: `Bearer ${user.token}` } : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

describe("risk engine (integration)", () => {
  let app: FastifyInstance;
  let payer: TestUser;
  let friend: TestUser;
  let stranger: TestUser;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    payer = await register(app, "risk-payer");
    friend = await register(app, "risk-friend");
    stranger = await register(app, "risk-stranger");
  });

  afterAll(async () => {
    await app.close();
  });

  const start = async (from: TestUser, to: TestUser, amountMinorUnits: number) => {
    const res = await call(app, from, "POST", "/api/v1/payments", {
      recipientEmail: to.email,
      amountMinorUnits,
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    return res.json().payment;
  };

  const confirm = (from: TestUser, id: string, acknowledgeRisk = false) =>
    call(
      app,
      from,
      "POST",
      `/api/v1/payments/${id}/confirm`,
      acknowledgeRisk ? { acknowledgeRisk: true } : {}
    );

  it("rates an everyday payment LOW, and stops mentioning a payee once they're familiar", async () => {
    // A fiver to someone new: noticed, said out loud, and still LOW.
    const payment = await start(payer, friend, 500);
    expect(payment.risk.level).toBe("LOW");
    expect(payment.risk.reasons).toEqual(["You haven't paid this person before"]);
    expect((await confirm(payer, payment.id)).json().payment.status).toBe("COMPLETED");

    // Paying the same person again is familiar, so there's nothing left
    // to say — and the engine says exactly that rather than inventing
    // reassurance.
    const again = await start(payer, friend, 500);
    expect(again.risk.level).toBe("LOW");
    expect(again.risk.reasons).toEqual(["Nothing unusual about this payment"]);
    expect((await confirm(payer, again.id)).json().payment.status).toBe("COMPLETED");
  });

  it("warns in plain words, without naming a rule or showing a score", async () => {
    const payment = await start(payer, stranger, 20_000);
    expect(payment.risk.level).toBe("HIGH");
    for (const reason of payment.risk.reasons) {
      expect(reason).toMatch(/^[A-Z]/);
      expect(reason).not.toMatch(/_/);
    }
    // The payer is told what was noticed, never the working.
    expect(JSON.stringify(payment)).not.toMatch(/score/i);
    expect(JSON.stringify(payment)).not.toMatch(/NEW_PAYEE|EMPTIES_BALANCE/);
  });

  it("won't move money on a HIGH payment until the payer says so", async () => {
    const before = (await call(app, payer, "GET", "/api/v1/accounts/me")).json().account
      .balanceMinorUnits;
    const payment = await start(payer, stranger, 20_000);
    expect(payment.risk.level).toBe("HIGH");

    const refused = await confirm(payer, payment.id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().code).toBe("RISK_ACKNOWLEDGEMENT_REQUIRED");
    // The refusal carries the reasons, so the app can show them.
    expect(refused.json().details.reasons.length).toBeGreaterThan(0);

    // Nothing moved on the refusal: the balance is whatever it was
    // before this payment was ever started.
    const balance = (await call(app, payer, "GET", "/api/v1/accounts/me")).json().account
      .balanceMinorUnits;
    expect(balance).toBe(before);

    const confirmed = await confirm(payer, payment.id, true);
    expect(confirmed.json().payment.status).toBe("COMPLETED");
  });

  it("files the working: the score, the rules and the signals it judged", async () => {
    const pool = getPool();
    const newcomer = await register(app, "risk-audited");
    const payment = await start(newcomer, stranger, 30_000);

    const assessment = await getAssessmentForPayment(pool, payment.id);
    expect(assessment).not.toBeNull();
    expect(assessment).toMatchObject({
      level: payment.risk.level,
      evaluator: "rules-v1",
    });
    expect(assessment!.score).toBeGreaterThan(0);
    expect(assessment!.firedRules.map((r) => r.id)).toContain("NEW_PAYEE");
    expect(assessment!.reasons).toEqual(payment.risk.reasons);

    // The signals are stored as they stood, which is what makes the
    // decision explainable later — the payer's history has moved on.
    expect(assessment!.signals).toMatchObject({
      amountMinorUnits: 30_000,
      payeeOwnerType: "user",
      balanceMinorUnits: STARTING_BALANCE,
      previousPaymentsToPayee: 0,
    });
  });

  it("never edits an assessment, even in the database", async () => {
    const pool = getPool();
    const payment = await start(payer, friend, 300);
    await expect(
      pool.query(`update risk_assessments set level = 'LOW' where payment_id = $1`, [payment.id])
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query(`delete from risk_assessments where payment_id = $1`, [payment.id])
    ).rejects.toThrow(/immutable/);
  });

  it("assesses every payment, and only once each", async () => {
    const pool = getPool();
    // Every payment the rules engine judged has its working on file.
    // Payments rated before Phase 12, or by a stub in another test, say
    // so in risk_evaluator and are not expected to have one.
    const unassessed = await pool.query(
      `select p.id from payments p
       left join risk_assessments r on r.payment_id = p.id
       where p.risk_evaluator = 'rules-v1' and r.payment_id is null`
    );
    expect(unassessed.rowCount).toBe(0);

    const duplicated = await pool.query(
      `select payment_id from risk_assessments group by payment_id having count(*) > 1`
    );
    expect(duplicated.rowCount).toBe(0);
  });

  it("agrees with the payment it judged, every time", async () => {
    const pool = getPool();
    const disagreeing = await pool.query(
      `select p.id from payments p
       join risk_assessments r on r.payment_id = p.id
       where p.risk_level <> r.level`
    );
    expect(disagreeing.rowCount).toBe(0);
  });

  it("is lighter on shops than on someone you've never paid", async () => {
    const shopkeeper = await register(app, "risk-shopkeeper");
    const created = await call(app, shopkeeper, "POST", "/api/v1/merchants", {
      legalName: `Risk Cafe Ltd ${run}`,
      tradingName: `Risk Cafe ${run}`,
      contactEmail: `hi.${run}@riskcafe.example`,
    });
    const shopId = created.json().merchant.id;
    const charge = await call(app, shopkeeper, "POST", "/api/v1/payment-requests", {
      asMerchantId: shopId,
      amountMinorUnits: 12_000,
      purpose: "Catering",
    });
    const customer = await register(app, "risk-customer");
    const started = await call(
      app,
      customer,
      "POST",
      `/api/v1/payment-requests/${charge.json().paymentRequest.id}/pay`
    );
    const shopPayment = started.json().payment;

    // The same £120 to a person they've never paid would be flagged;
    // to a registered shop it isn't, because a shop can be found again.
    const toAStranger = await start(customer, stranger, 12_000);
    expect(toAStranger.risk.level).not.toBe("LOW");
    expect(shopPayment.risk.level).toBe("LOW");
  });

  it("fails closed: no decision means no payment", async () => {
    const broken = buildApp({
      logger: false,
      riskEvaluator: {
        async evaluate() {
          throw new Error("risk engine unavailable");
        },
      },
    });
    try {
      const a = await register(broken, "risk-closed-a");
      const b = await register(broken, "risk-closed-b");
      const res = await call(broken, a, "POST", "/api/v1/payments", {
        recipientEmail: b.email,
        amountMinorUnits: 1_000,
      });
      expect(res.statusCode).toBe(500);

      // The payment is on file as failed, and nobody's balance moved.
      const pool = getPool();
      const failed = await pool.query<{ status: string; failure_reason: string }>(
        `select status, failure_reason from payments
         where payer_user_id = $1 order by created_at desc limit 1`,
        [a.id]
      );
      expect(failed.rows[0]).toMatchObject({
        status: "FAILED",
        failure_reason: "RISK_EVALUATION_ERROR",
      });
      const balance = (await call(broken, a, "GET", "/api/v1/accounts/me")).json().account
        .balanceMinorUnits;
      expect(balance).toBe(STARTING_BALANCE);
    } finally {
      await broken.close();
    }
  });
});
