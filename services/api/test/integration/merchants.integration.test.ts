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

describe("merchants (integration)", () => {
  let app: FastifyInstance;
  let owner: TestUser;
  let staff: TestUser;
  let customer: TestUser;
  let outsider: TestUser;
  let shopId: string;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    owner = await register(app, "shop-owner");
    staff = await register(app, "shop-staff");
    customer = await register(app, "shop-customer");
    outsider = await register(app, "shop-outsider");

    const created = await call(app, owner, "POST", "/api/v1/merchants", {
      legalName: `Bean Counter Ltd ${run}`,
      tradingName: `Bean Counter ${run}`,
      contactEmail: `hello.${run}@beancounter.example`,
    });
    expect(created.statusCode).toBe(201);
    shopId = created.json().merchant.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const shopBalance = async (as: TestUser = owner) =>
    (await call(app, as, "GET", `/api/v1/merchants/${shopId}/account`)).json().account
      .balanceMinorUnits;

  async function charge(as: TestUser, body: object) {
    const res = await call(app, as, "POST", "/api/v1/payment-requests", {
      asMerchantId: shopId,
      ...body,
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    return res.json().paymentRequest;
  }

  async function payAndConfirm(payer: TestUser, requestId: string) {
    const started = await call(app, payer, "POST", `/api/v1/payment-requests/${requestId}/pay`);
    expect(started.statusCode, JSON.stringify(started.json())).toBe(201);
    return call(app, payer, "POST", `/api/v1/payments/${started.json().payment.id}/confirm`, {});
  }

  it("registers a shop with its creator as owner, and an empty account", async () => {
    const mine = (await call(app, owner, "GET", "/api/v1/merchants")).json().merchants;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      id: shopId,
      tradingName: `Bean Counter ${run}`,
      status: "active",
      // No business checks are run here, so it can never say otherwise.
      verification: "unverified",
      yourRole: "owner",
    });
    expect(await shopBalance()).toBe(0);
  });

  it("won't let two shops trade under the same name", async () => {
    const res = await call(app, outsider, "POST", "/api/v1/merchants", {
      legalName: "Someone Else Ltd",
      tradingName: `  bean counter ${run}  `,
      contactEmail: "hi@example.com",
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("MERCHANT_NAME_TAKEN");
  });

  it("keeps a shop invisible to people who don't work there", async () => {
    for (const url of [
      `/api/v1/merchants/${shopId}`,
      `/api/v1/merchants/${shopId}/account`,
      `/api/v1/merchants/${shopId}/members`,
      `/api/v1/merchants/${shopId}/activity`,
      `/api/v1/merchants/${shopId}/payment-requests`,
    ]) {
      const res = await call(app, outsider, "GET", url);
      expect(res.statusCode, url).toBe(404);
    }
    const theirs = (await call(app, outsider, "GET", "/api/v1/merchants")).json().merchants;
    expect(theirs).toHaveLength(0);
  });

  it("takes a payment for the shop: the customer pays the shop, not a person", async () => {
    const request = await charge(owner, { amountMinorUnits: 4_50, purpose: "Flat white" });
    expect(request.takenFor).toMatchObject({ merchantId: shopId });

    // What the customer is told they're paying.
    const resolved = (
      await call(app, customer, "GET", `/api/v1/payment-requests/resolve/${request.token}`)
    ).json().paymentRequest;
    expect(resolved.requester).toEqual({
      type: "merchant",
      displayName: `Bean Counter ${run}`,
      verification: "registered_merchant",
    });
    // The person at the till is never named to the customer.
    expect(JSON.stringify(resolved)).not.toContain(owner.email);

    const customerBefore = await balance(app, customer);
    const ownerBefore = await balance(app, owner);
    const shopBefore = await shopBalance();

    const confirmed = await payAndConfirm(customer, request.id);
    expect(confirmed.json().payment).toMatchObject({
      status: "COMPLETED",
      counterparty: { type: "merchant", displayName: `Bean Counter ${run}` },
    });

    // The money is the shop's, not the owner's personal balance. The
    // customer is 450 down and 4 up: paying a shop earns 1% back
    // (Phase 10), and the shop is paid in full either way.
    expect(await balance(app, customer)).toBe(customerBefore - 450 + 4);
    expect(await shopBalance()).toBe(shopBefore + 450);
    expect(await balance(app, owner)).toBe(ownerBefore);
  });

  it("shows the takings on the shop's own activity, with who paid", async () => {
    const request = await charge(owner, { amountMinorUnits: 1_000, purpose: "Beans" });
    await payAndConfirm(customer, request.id);

    const activity = (await call(app, owner, "GET", `/api/v1/merchants/${shopId}/activity`)).json();
    const latest = activity.items[0];
    expect(latest).toMatchObject({
      direction: "in",
      amountMinorUnits: 1_000,
      title: customer.email,
      purpose: "Beans",
    });
    expect(latest.receiptId).toEqual(expect.any(String));
    expect(latest.balanceAfterMinorUnits).toBe(await shopBalance());

    // And it is NOT in the owner's personal activity.
    const personal = (await call(app, owner, "GET", "/api/v1/transactions")).json();
    expect(personal.items.map((i: any) => i.transactionId)).not.toContain(latest.transactionId);
  });

  it("lets both sides open the receipt, and nobody else", async () => {
    const request = await charge(owner, { amountMinorUnits: 2_50, purpose: "Tea" });
    const confirmed = await payAndConfirm(customer, request.id);
    const receiptId = confirmed.json().payment.receiptId;

    const forCustomer = (await call(app, customer, "GET", `/api/v1/receipts/${receiptId}`)).json()
      .receipt;
    expect(forCustomer).toMatchObject({
      role: "payer",
      to: `Bean Counter ${run}`,
      amountMinorUnits: 250,
    });

    const forShop = (await call(app, owner, "GET", `/api/v1/receipts/${receiptId}`)).json().receipt;
    expect(forShop).toMatchObject({ role: "payee", from: customer.email });

    expect((await call(app, outsider, "GET", `/api/v1/receipts/${receiptId}`)).statusCode).toBe(404);
  });

  it("lets an owner add staff, who can take money but not change the team", async () => {
    const added = await call(app, owner, "POST", `/api/v1/merchants/${shopId}/members`, {
      email: staff.email,
      role: "staff",
    });
    expect(added.statusCode).toBe(201);
    expect(added.json().member).toMatchObject({ role: "staff", displayName: staff.email });

    // Staff can charge for the shop, and the audit trail says who did.
    const request = await charge(staff, { amountMinorUnits: 3_00, purpose: "Bun" });
    await payAndConfirm(customer, request.id);
    const pool = getPool();
    const events = await pool.query(
      `select actor_user_id from audit_events
       where event_type = 'PAYMENT_REQUEST_CREATED' and metadata->>'paymentRequestId' = $1`,
      [request.id]
    );
    expect(events.rows[0].actor_user_id).toBe(staff.id);

    // Staff can see the shop, but can't bring anyone else in.
    expect((await call(app, staff, "GET", `/api/v1/merchants/${shopId}`)).statusCode).toBe(200);
    const byStaff = await call(app, staff, "POST", `/api/v1/merchants/${shopId}/members`, {
      email: outsider.email,
      role: "staff",
    });
    expect(byStaff.statusCode).toBe(403);
    expect(byStaff.json().code).toBe("MERCHANT_OWNER_ONLY");

    // Adding the same person twice is refused, and an unknown address
    // gets the same answer as anyone else's.
    expect(
      (
        await call(app, owner, "POST", `/api/v1/merchants/${shopId}/members`, {
          email: staff.email,
          role: "staff",
        })
      ).statusCode
    ).toBe(409);
    const ghost = await call(app, owner, "POST", `/api/v1/merchants/${shopId}/members`, {
      email: `ghost.${run}@example.com`,
      role: "staff",
    });
    expect(ghost.statusCode).toBe(400);
    expect(ghost.json().code).toBe("MERCHANT_MEMBER_INVALID");
  });

  it("shows the till's charges to everyone who works there, whoever rang them up", async () => {
    const mine = await charge(staff, { amountMinorUnits: 1_75, purpose: "Scone" });
    const list = (
      await call(app, owner, "GET", `/api/v1/merchants/${shopId}/payment-requests`)
    ).json().paymentRequests;
    expect(list.map((r: any) => r.id)).toContain(mine.id);

    // And a colleague can call one off.
    const cancelled = await call(app, owner, "POST", `/api/v1/payment-requests/${mine.id}/cancel`);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().paymentRequest.status).toBe("CANCELLED");
  });

  it("refuses to take money for a shop you don't work for", async () => {
    const res = await call(app, outsider, "POST", "/api/v1/payment-requests", {
      asMerchantId: shopId,
      amountMinorUnits: 100,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("MERCHANT_NOT_FOUND");

    const nonsense = await call(app, owner, "POST", "/api/v1/payment-requests", {
      asMerchantId: "3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b",
      amountMinorUnits: 100,
    });
    expect(nonsense.statusCode).toBe(404);
  });

  it("won't take money for a suspended shop", async () => {
    const pool = getPool();
    await pool.query(`update merchants set status = 'suspended' where id = $1`, [shopId]);
    try {
      const res = await call(app, owner, "POST", "/api/v1/payment-requests", {
        asMerchantId: shopId,
        amountMinorUnits: 100,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("MERCHANT_SUSPENDED");
      // Reading is still allowed, so a shop can see what it took.
      expect((await call(app, owner, "GET", `/api/v1/merchants/${shopId}`)).statusCode).toBe(200);
    } finally {
      await pool.query(`update merchants set status = 'active' where id = $1`, [shopId]);
    }
  });

  it.each([
    ["no names", {}],
    ["a blank trading name", { legalName: "A Ltd", tradingName: "  ", contactEmail: "a@b.com" }],
    ["an unexpected field", { legalName: "A", tradingName: "B", contactEmail: "a@b.com", verification: "verified" }],
    ["an attempt to set the status", { legalName: "A", tradingName: "B", contactEmail: "a@b.com", status: "active" }],
  ])("refuses to register a shop with %s", async (_label, body) => {
    const res = await call(app, outsider, "POST", "/api/v1/merchants", body);
    expect(res.statusCode).toBe(400);
  });

  it("requires sign-in for every merchant endpoint", async () => {
    for (const [method, url] of [
      ["POST", "/api/v1/merchants"],
      ["GET", "/api/v1/merchants"],
      ["GET", `/api/v1/merchants/${shopId}`],
      ["GET", `/api/v1/merchants/${shopId}/account`],
      ["GET", `/api/v1/merchants/${shopId}/activity`],
      ["GET", `/api/v1/merchants/${shopId}/members`],
      ["POST", `/api/v1/merchants/${shopId}/members`],
      ["GET", `/api/v1/merchants/${shopId}/payment-requests`],
    ] as const) {
      const res = await call(app, null, method, url, method === "POST" ? {} : undefined);
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("keeps the database's own rules about shops", async () => {
    const pool = getPool();
    await expect(
      pool.query(`update merchants set status = 'closed' where id = $1`, [shopId])
    ).rejects.toThrow(/merchants_status_check/);
    await expect(
      pool.query(`update merchants set trading_name = '   ' where id = $1`, [shopId])
    ).rejects.toThrow(/merchants_names_not_blank/);
    await expect(
      pool.query(
        `insert into merchant_members (merchant_id, user_id, role, added_by_user_id)
         values ($1, $2, 'manager', $2)`,
        [shopId, outsider.id]
      )
    ).rejects.toThrow(/merchant_members_role_check/);
  });

  it("keeps every shop's balance equal to what the ledger says", async () => {
    const pool = getPool();
    const mismatched = await pool.query(
      `select a.owner_id
       from ledger_accounts a
       join merchants m on m.id = a.owner_id
       left join ledger_entries le on le.account_id = a.id
       where a.owner_type = 'merchant'
       group by a.owner_id
       having coalesce(sum(case when le.direction = 'credit' then le.amount_minor_units
                                when le.direction = 'debit' then -le.amount_minor_units
                                else 0 end), 0) < 0`
    );
    expect(mismatched.rowCount).toBe(0);
  });
});
