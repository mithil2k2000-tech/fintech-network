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
  const body = res.json();
  return { id: body.user.id, email: body.user.email, token: body.token };
}

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });

async function pay(
  app: FastifyInstance,
  from: TestUser,
  to: TestUser,
  amountMinorUnits: number,
  purpose?: string
) {
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/payments",
    headers: auth(from),
    payload: { recipientEmail: to.email, amountMinorUnits, ...(purpose ? { purpose } : {}) },
  });
  expect(created.statusCode).toBe(201);
  // Since Phase 12 a payment can come back HIGH, and confirming one
  // takes an explicit acknowledgement — exactly what the app does when
  // the payer ticks the box. These tests are about receipts and
  // history, so the helper does it for them.
  const flagged = created.json().payment.risk?.level === "HIGH";
  const confirmed = await app.inject({
    method: "POST",
    url: `/api/v1/payments/${created.json().payment.id}/confirm`,
    headers: auth(from),
    payload: flagged ? { acknowledgeRisk: true } : {},
  });
  return confirmed;
}

async function history(app: FastifyInstance, user: TestUser, qs = "") {
  return app.inject({
    method: "GET",
    url: `/api/v1/transactions${qs}`,
    headers: auth(user),
  });
}

describe("receipts (integration)", () => {
  let app: FastifyInstance;
  let alice: TestUser;
  let bob: TestUser;
  let eve: TestUser;
  let paymentId: string;
  let receiptId: string;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    alice = await register(app, "alice-rcpt");
    bob = await register(app, "bob-rcpt");
    eve = await register(app, "eve-rcpt");
  });

  afterAll(async () => {
    await app.close();
  });

  it("has no receipt before the payment completes", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/payments",
      headers: auth(alice),
      payload: { recipientEmail: bob.email, amountMinorUnits: 1_250, purpose: "Coffee" },
    });
    paymentId = created.json().payment.id;
    expect(created.json().payment.receiptId).toBeNull();

    const res = await app.inject({
      method: "GET",
      url: `/api/v1/payments/${paymentId}/receipt`,
      headers: auth(alice),
    });
    expect(res.statusCode).toBe(404);
  });

  it("issues a receipt the moment the payment completes", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/payments/${paymentId}/confirm`,
      headers: auth(alice),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const { payment } = res.json();
    expect(payment.status).toBe("COMPLETED");
    expect(payment.receiptId).toEqual(expect.any(String));
    receiptId = payment.receiptId;
  });

  it("shows the payer their receipt, by id and via the payment", async () => {
    const byId = await app.inject({
      method: "GET",
      url: `/api/v1/receipts/${receiptId}`,
      headers: auth(alice),
    });
    const byPayment = await app.inject({
      method: "GET",
      url: `/api/v1/payments/${paymentId}/receipt`,
      headers: auth(alice),
    });
    expect(byId.statusCode).toBe(200);
    expect(byPayment.json()).toEqual(byId.json());
    const { receipt } = byId.json();
    expect(receipt).toMatchObject({
      id: receiptId,
      paymentId,
      role: "payer",
      from: alice.email,
      to: bob.email,
      amountMinorUnits: 1_250,
      currency: "GBP",
      purpose: "Coffee",
      paymentStatus: "COMPLETED",
      passport: { available: false },
    });
    expect(receipt.receiptNumber).toMatch(/^RCP-[A-HJ-NP-Z2-9]{12}$/);
    expect(receipt.passport.reference).toMatch(/^PP-/);
    expect(receipt.transactionId).toEqual(expect.any(String));
  });

  it("shows the payee the same receipt from their side", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/receipts/${receiptId}`,
      headers: auth(bob),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().receipt.role).toBe("payee");
  });

  it("hides the receipt from anyone else (IDOR)", async () => {
    for (const url of [`/api/v1/receipts/${receiptId}`, `/api/v1/payments/${paymentId}/receipt`]) {
      const res = await app.inject({ method: "GET", url, headers: auth(eve) });
      expect(res.statusCode).toBe(404);
      expect(res.json().code).toBe("RECEIPT_NOT_FOUND");
    }
    const noToken = await app.inject({ method: "GET", url: `/api/v1/receipts/${receiptId}` });
    expect(noToken.statusCode).toBe(401);
    const badId = await app.inject({
      method: "GET",
      url: "/api/v1/receipts/not-a-uuid",
      headers: auth(alice),
    });
    expect(badId.statusCode).toBe(400);
  });

  it("gives failed payments no receipt", async () => {
    const res = await pay(app, eve, bob, 900_000); // more than Eve has
    expect(res.json().payment).toMatchObject({
      status: "FAILED",
      failureReason: "INSUFFICIENT_FUNDS",
      receiptId: null,
    });
    const receipt = await app.inject({
      method: "GET",
      url: `/api/v1/payments/${res.json().payment.id}/receipt`,
      headers: auth(eve),
    });
    expect(receipt.statusCode).toBe(404);
  });

  it("records RECEIPT_CREATED in the audit trail", async () => {
    const pool = getPool();
    const result = await pool.query(
      `select metadata from audit_events
       where event_type = 'RECEIPT_CREATED' and metadata->>'paymentId' = $1`,
      [paymentId]
    );
    expect(result.rowCount).toBe(1);
    expect(result.rows[0].metadata.receiptId).toBe(receiptId);
  });

  it("refuses to change or delete a receipt, a ledger entry or a transaction at the database level", async () => {
    const pool = getPool();
    await expect(
      pool.query(`update receipts set amount_minor_units = 1 where id = $1`, [receiptId])
    ).rejects.toThrow(/immutable/);
    await expect(pool.query(`delete from receipts where id = $1`, [receiptId])).rejects.toThrow(
      /immutable/
    );

    const { rows } = await pool.query(
      `select transaction_id from receipts where id = $1`,
      [receiptId]
    );
    const txId = rows[0].transaction_id;
    await expect(
      pool.query(`update ledger_entries set amount_minor_units = 1 where transaction_id = $1`, [txId])
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query(`delete from ledger_entries where transaction_id = $1`, [txId])
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query(`update transactions set description = 'x' where id = $1`, [txId])
    ).rejects.toThrow(/immutable/);
  });

  it("rolls the whole payment back if the receipt can't be written", async () => {
    const pool = getPool();
    // Simulate a receipt-store failure for one specific amount only.
    await pool.query(`
      create or replace function test_fail_receipt() returns trigger language plpgsql as $$
      begin
        if new.amount_minor_units = 777 then raise exception 'simulated receipt failure'; end if;
        return new;
      end; $$;
      drop trigger if exists test_fail_receipt on receipts;
      create trigger test_fail_receipt before insert on receipts
        for each row execute function test_fail_receipt();
    `);
    try {
      const before = (
        await app.inject({ method: "GET", url: "/api/v1/accounts/me", headers: auth(bob) })
      ).json().account.balanceMinorUnits;

      const res = await pay(app, bob, alice, 777);
      expect(res.statusCode).toBe(500);
      expect(JSON.stringify(res.json())).not.toMatch(/simulated receipt failure/);

      const after = (
        await app.inject({ method: "GET", url: "/api/v1/accounts/me", headers: auth(bob) })
      ).json().account.balanceMinorUnits;
      expect(after).toBe(before);

      const row = await pool.query(
        `select status, failure_reason, transaction_id from payments
         where payer_user_id = $1 and amount_minor_units = 777`,
        [bob.id]
      );
      expect(row.rows).toEqual([
        { status: "FAILED", failure_reason: "PROCESSING_ERROR", transaction_id: null },
      ]);
    } finally {
      await pool.query(`
        drop trigger if exists test_fail_receipt on receipts;
        drop function if exists test_fail_receipt();
      `);
    }
  });
});

describe("transaction history (integration)", () => {
  let app: FastifyInstance;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    alice = await register(app, "alice-hist");
    bob = await register(app, "bob-hist");
    carol = await register(app, "carol-hist");
  });

  afterAll(async () => {
    await app.close();
  });

  it("starts with just the starting balance", async () => {
    const res = await history(app, alice);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        expect.objectContaining({
          kind: "seed",
          direction: "in",
          amountMinorUnits: 50_000,
          balanceAfterMinorUnits: 50_000,
          title: "Starting balance",
          paymentId: null,
          receiptId: null,
        }),
      ],
      nextCursor: null,
    });
  });

  it("shows payments both ways, newest first, with running balances and receipts", async () => {
    expect((await pay(app, alice, bob, 1_500, "Lunch")).json().payment.status).toBe("COMPLETED");
    expect((await pay(app, carol, alice, 700, "Cinema")).json().payment.status).toBe("COMPLETED");
    // A failed payment moves nothing, so it isn't in the money history.
    expect((await pay(app, alice, bob, 999_999)).json().payment.status).toBe("FAILED");

    const { items } = (await history(app, alice)).json();
    expect(items).toHaveLength(3);
    expect(items.map((i: any) => [i.kind, i.direction, i.amountMinorUnits, i.balanceAfterMinorUnits])).toEqual([
      ["payment", "in", 700, 49_200],
      ["payment", "out", 1_500, 48_500],
      ["seed", "in", 50_000, 50_000],
    ]);
    expect(items[0]).toMatchObject({ title: carol.email, purpose: "Cinema" });
    expect(items[1]).toMatchObject({ title: bob.email, purpose: "Lunch" });
    for (const item of items.slice(0, 2)) {
      expect(item.paymentId).toEqual(expect.any(String));
      expect(item.receiptId).toEqual(expect.any(String));
      // Raw ledger descriptions contain ids; they must never be the title.
      expect(item.title).not.toMatch(/^Payment /);
    }

    // The newest running balance equals the account balance.
    const account = await app.inject({
      method: "GET",
      url: "/api/v1/accounts/me",
      headers: auth(alice),
    });
    expect(account.json().account.balanceMinorUnits).toBe(items[0].balanceAfterMinorUnits);
  });

  it("shows the other side of the same payment to the payee", async () => {
    const { items } = (await history(app, bob)).json();
    expect(items[0]).toMatchObject({
      kind: "payment",
      direction: "in",
      amountMinorUnits: 1_500,
      title: alice.email,
      purpose: "Lunch",
    });
  });

  it("pages through everything with no gaps or duplicates", async () => {
    // Give Alice enough history to page through.
    for (let i = 1; i <= 5; i++) {
      expect((await pay(app, alice, carol, i * 10)).json().payment.status).toBe("COMPLETED");
    }
    const all = (await history(app, alice, "?limit=100")).json();
    expect(all.nextCursor).toBeNull();
    expect(all.items).toHaveLength(8);

    const paged: any[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs: string = `?limit=3${cursor ? `&cursor=${cursor}` : ""}`;
      const res = await history(app, alice, qs);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items.length).toBeLessThanOrEqual(3);
      paged.push(...body.items);
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);

    expect(pages).toBe(3);
    expect(paged).toEqual(all.items);

    // Running balances are consistent from one item to the next, across pages.
    for (let i = 0; i < paged.length - 1; i++) {
      const cur = paged[i];
      const prev = paged[i + 1];
      const delta = cur.direction === "in" ? cur.amountMinorUnits : -cur.amountMinorUnits;
      expect(cur.balanceAfterMinorUnits).toBe(prev.balanceAfterMinorUnits + delta);
    }
  });

  it("only ever shows the caller's own history", async () => {
    const aliceIds = new Set(
      (await history(app, alice, "?limit=100")).json().items.map((i: any) => i.id)
    );
    const carolItems = (await history(app, carol, "?limit=100")).json().items;
    for (const item of carolItems) expect(aliceIds.has(item.id)).toBe(false);
  });

  it.each([
    ["a non-numeric limit", "?limit=abc"],
    ["a negative limit", "?limit=-1"],
    ["an unknown parameter", "?userId=someone-else"],
  ])("rejects %s", async (_label, qs) => {
    const res = await history(app, alice, qs);
    expect(res.statusCode).toBe(400);
  });

  it("rejects a tampered cursor", async () => {
    const res = await history(app, alice, "?cursor=not-a-real-cursor");
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_CURSOR");
  });

  it("caps the page size", async () => {
    const res = await history(app, alice, "?limit=999");
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeLessThanOrEqual(100);
  });

  it("requires a token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/transactions" });
    expect(res.statusCode).toBe(401);
  });
});
