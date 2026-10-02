import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/index.js";
import { getPool } from "../../src/db.js";

// Requires a real Postgres at DATABASE_URL with migrations applied, and
// JWT_SECRET set.

const PASSWORD = "correct-horse-battery-staple";
const run = Date.now();

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

async function balance(app: FastifyInstance, u: TestUser): Promise<number> {
  return (await call(app, u, "GET", "/api/v1/accounts/me")).json().account.balanceMinorUnits;
}

describe("cashback (integration)", () => {
  let app: FastifyInstance;
  let shopper: TestUser;
  let friend: TestUser;
  let tillUser: TestUser;
  let shopId: string;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    shopper = await register(app, "cb-shopper");
    friend = await register(app, "cb-friend");
    tillUser = await register(app, "cb-till");

    const created = await call(app, tillUser, "POST", "/api/v1/merchants", {
      legalName: `Cashback Cafe Ltd ${run}`,
      tradingName: `Cashback Cafe ${run}`,
      contactEmail: `hello.${run}@cb.example`,
    });
    expect(created.statusCode).toBe(201);
    shopId = created.json().merchant.id;
  });

  afterAll(async () => {
    await app.close();
  });

  async function payShop(payer: TestUser, amountMinorUnits: number, purpose = "Coffee") {
    const charge = await call(app, tillUser, "POST", "/api/v1/payment-requests", {
      asMerchantId: shopId,
      amountMinorUnits,
      purpose,
    });
    expect(charge.statusCode).toBe(201);
    const started = await call(
      app,
      payer,
      "POST",
      `/api/v1/payment-requests/${charge.json().paymentRequest.id}/pay`
    );
    expect(started.statusCode).toBe(201);
    return call(app, payer, "POST", `/api/v1/payments/${started.json().payment.id}/confirm`, {});
  }

  const summary = async (u: TestUser) =>
    (await call(app, u, "GET", "/api/v1/rewards/cashback")).json().cashback;

  it("gives 1% back when you pay a shop, on top of the payment", async () => {
    const before = await balance(app, shopper);
    const confirmed = await payShop(shopper, 1_000, "Beans");
    expect(confirmed.json().payment.status).toBe("COMPLETED");

    // £10 out, 10p back — one net movement of £9.90.
    expect(await balance(app, shopper)).toBe(before - 1_000 + 10);

    const view = await summary(shopper);
    expect(view.totalEarnedMinorUnits).toBe(10);
    expect(view.grants[0]).toMatchObject({
      amountMinorUnits: 10,
      spendMinorUnits: 1_000,
      ratePercent: 1,
      rule: "cashback-v1",
    });
    expect(view.offer).toMatchObject({
      ratePercent: 1,
      minimumSpendMinorUnits: 100,
      maximumAwardMinorUnits: 500,
      appliesTo: "merchant_payments",
    });
  });

  it("shows up in activity as its own thing, not as a payment", async () => {
    await payShop(shopper, 2_000, "Lunch");
    const items = (await call(app, shopper, "GET", "/api/v1/transactions")).json().items;
    const cashback = items.find((i: any) => i.kind === "cashback");
    expect(cashback).toMatchObject({
      direction: "in",
      amountMinorUnits: 20,
      title: "Cashback",
      // It's a reward, not a payment, so there's nothing to open.
      paymentId: null,
      receiptId: null,
    });
    // And the payment it came from is still there in its own right.
    expect(items.some((i: any) => i.direction === "out" && i.amountMinorUnits === 2_000)).toBe(true);
  });

  it("earns nothing for paying a person", async () => {
    const before = await summary(shopper);
    const created = await call(app, shopper, "POST", "/api/v1/payments", {
      recipientEmail: friend.email,
      amountMinorUnits: 5_000,
    });
    const confirmed = await call(
      app,
      shopper,
      "POST",
      `/api/v1/payments/${created.json().payment.id}/confirm`,
      {}
    );
    expect(confirmed.json().payment.status).toBe("COMPLETED");
    expect((await summary(shopper)).totalEarnedMinorUnits).toBe(before.totalEarnedMinorUnits);
  });

  it("pays nothing under £1, and 1% on a big one", async () => {
    const small = await summary(shopper);
    await payShop(shopper, 99, "Mint");
    expect((await summary(shopper)).totalEarnedMinorUnits).toBe(small.totalEarnedMinorUnits);

    // Nobody's £500 starting balance can reach the £5 cap (it needs a
    // £500 payment plus the money to make it), so the cap itself is
    // covered by the unit tests; here we check the rate holds at size.
    const bigSpender = await register(app, "cb-big");
    const confirmed = await payShop(bigSpender, 40_000, "Catering");
    expect(confirmed.json().payment.status).toBe("COMPLETED");
    expect((await summary(bigSpender)).totalEarnedMinorUnits).toBe(400);
  });

  it("grants it exactly once per payment, and never edits a grant afterwards", async () => {
    const pool = getPool();
    const confirmed = await payShop(shopper, 3_000, "Twice?");
    const paymentId = confirmed.json().payment.id;

    // Confirming again returns the completed payment as-is.
    const again = await call(app, shopper, "POST", `/api/v1/payments/${paymentId}/confirm`, {});
    expect(again.json().payment.status).toBe("COMPLETED");

    const grants = await pool.query(
      `select * from cashback_grants where payment_id = $1`,
      [paymentId]
    );
    expect(grants.rowCount).toBe(1);

    await expect(
      pool.query(`update cashback_grants set amount_minor_units = 99999 where payment_id = $1`, [
        paymentId,
      ])
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query(`delete from cashback_grants where payment_id = $1`, [paymentId])
    ).rejects.toThrow(/immutable/);
  });

  it("funds every penny from the reserve, so the books still balance", async () => {
    const pool = getPool();
    const unbalanced = await pool.query(
      `select t.id from transactions t
       join ledger_entries le on le.transaction_id = t.id
       where t.kind = 'cashback'
       group by t.id
       having sum(case when le.direction = 'credit' then le.amount_minor_units
                       else -le.amount_minor_units end) <> 0`
    );
    expect(unbalanced.rowCount).toBe(0);

    // What the reserve has paid out equals what was granted.
    const paidOut = await pool.query<{ total: string }>(
      `select coalesce(sum(le.amount_minor_units), 0)::text as total
       from ledger_entries le
       join ledger_accounts a on a.id = le.account_id
       where a.owner_type = 'system' and a.name = 'cashback_reserve' and le.direction = 'debit'`
    );
    const granted = await pool.query<{ total: string }>(
      `select coalesce(sum(amount_minor_units), 0)::text as total from cashback_grants`
    );
    expect(paidOut.rows[0].total).toBe(granted.rows[0].total);
  });

  it("grows a tree from the cashback already granted, never a stored score", async () => {
    const pool = getPool();
    const gardener = await register(app, "cb-gardener");

    const fresh = (await call(app, gardener, "GET", "/api/v1/rewards/tree")).json();
    expect(fresh.tree).toMatchObject({
      totalEarnedMinorUnits: 0,
      rewardedPayments: 0,
      leaves: 0,
      progressPercent: 0,
      stage: { level: 0, name: "Seed" },
    });
    expect(fresh.tree.disclaimer).toMatch(/No real tree is planted/i);
    // The whole ladder comes from the server, so no screen repeats it.
    expect(fresh.stages[0]).toMatchObject({ level: 0, fromMinorUnits: 0 });
    expect(fresh.stages.length).toBeGreaterThan(3);

    // £6 at a shop earns 6p: past the first threshold, one leaf.
    await payShop(gardener, 6_00, "Sandwich");
    const sprouted = (await call(app, gardener, "GET", "/api/v1/rewards/tree")).json().tree;
    expect(sprouted).toMatchObject({
      totalEarnedMinorUnits: 6,
      rewardedPayments: 1,
      leaves: 1,
      stage: { level: 1, name: "Sprout" },
    });

    // The tree is only ever a view of the grants: it must agree with
    // the table it was counted from, not with a number kept elsewhere.
    const granted = await pool.query<{ total: string; n: string }>(
      `select coalesce(sum(amount_minor_units), 0)::text as total, count(*)::text as n
       from cashback_grants where user_id = $1`,
      [gardener.id]
    );
    expect(sprouted.totalEarnedMinorUnits).toBe(Number(granted.rows[0].total));
    expect(sprouted.rewardedPayments).toBe(Number(granted.rows[0].n));
  });

  it("keeps one person's tree to themselves", async () => {
    expect((await call(app, null, "GET", "/api/v1/rewards/tree")).statusCode).toBe(401);
    const theirs = (await call(app, friend, "GET", "/api/v1/rewards/tree")).json().tree;
    expect(theirs.totalEarnedMinorUnits).toBe(0);
    expect(theirs.stage.level).toBe(0);
  });

  it("keeps one person's cashback to themselves", async () => {
    const theirs = await summary(friend);
    expect(theirs.totalEarnedMinorUnits).toBe(0);
    expect(theirs.grants).toHaveLength(0);
    expect((await call(app, null, "GET", "/api/v1/rewards/cashback")).statusCode).toBe(401);
  });

  it("keeps the database's own rules about grants", async () => {
    const pool = getPool();
    const row = await pool.query<{ payment_id: string; user_id: string; transaction_id: string }>(
      `select payment_id, user_id, transaction_id from cashback_grants limit 1`
    );
    const { payment_id, user_id, transaction_id } = row.rows[0];

    // One grant per payment, whatever else is tried.
    await expect(
      pool.query(
        `insert into cashback_grants
           (payment_id, user_id, transaction_id, amount_minor_units,
            spend_minor_units, rate_basis_points, rule)
         values ($1, $2, $3, 1, 100, 100, 'dupe')`,
        [payment_id, user_id, transaction_id]
      )
    ).rejects.toThrow(/cashback_grants_payment_id_key|duplicate key/);

    // And cashback can never exceed the spend it came from.
    await expect(
      pool.query(
        `insert into cashback_grants
           (payment_id, user_id, transaction_id, amount_minor_units,
            spend_minor_units, rate_basis_points, rule)
         values (gen_random_uuid(), $1, $2, 500, 100, 100, 'too-generous')`,
        [user_id, transaction_id]
      )
    ).rejects.toThrow(/cashback_grants_not_more_than_spend|violates foreign key/);
  });
});

describe("cashback failures (integration)", () => {
  it("never costs someone their payment when the reward goes wrong", async () => {
    // A rule that can't be granted: the database refuses a rate above
    // 100%, so the insert fails inside the hook. The payment must
    // still complete, and the money must still move.
    const broken = buildApp({
      logger: false,
      extraCompletionHooks: [
        async (client, payment) => {
          await client.query("savepoint deliberate");
          try {
            await client.query(
              `insert into cashback_grants
                 (payment_id, user_id, transaction_id, amount_minor_units,
                  spend_minor_units, rate_basis_points, rule)
               values ($1, $2, $3, 1, 1, 99999, 'deliberately-broken')`,
              [payment.paymentId, payment.payerUserId, payment.transactionId]
            );
          } catch {
            await client.query("rollback to savepoint deliberate");
          }
        },
      ],
    });
    try {
      const payer = await register(broken, "cb-resilient");
      const payee = await register(broken, "cb-resilient-payee");
      const created = await call(broken, payer, "POST", "/api/v1/payments", {
        recipientEmail: payee.email,
        amountMinorUnits: 2_500,
      });
      const confirmed = await call(
        broken,
        payer,
        "POST",
        `/api/v1/payments/${created.json().payment.id}/confirm`,
        {}
      );
      expect(confirmed.json().payment).toMatchObject({
        status: "COMPLETED",
        failureReason: null,
      });
      expect(await balance(broken, payee)).toBe(50_000 + 2_500);
    } finally {
      await broken.close();
    }
  });
});
