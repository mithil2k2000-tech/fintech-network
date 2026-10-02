import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/index.js";
import { getPool } from "../../src/db.js";
import { PaymentBlockedError } from "../../src/modules/payments/index.js";

// Requires a real Postgres at DATABASE_URL with migrations applied, and
// JWT_SECRET set.

const PASSWORD = "correct-horse-battery-staple";
const run = Date.now();
const START = 50_000;

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

const auth = (u: TestUser) => ({ authorization: `Bearer ${u.token}` });

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
    headers: user ? auth(user) : {},
    ...(payload !== undefined ? { payload: payload as object } : {}),
  });
}

async function balance(app: FastifyInstance, u: TestUser): Promise<number> {
  return (await call(app, u, "GET", "/api/v1/accounts/me")).json().account.balanceMinorUnits;
}

async function createRequest(app: FastifyInstance, u: TestUser, body: object) {
  const res = await call(app, u, "POST", "/api/v1/payment-requests", body);
  expect(res.statusCode).toBe(201);
  return res.json().paymentRequest;
}

async function payAndConfirm(app: FastifyInstance, payer: TestUser, requestId: string) {
  const started = await call(app, payer, "POST", `/api/v1/payment-requests/${requestId}/pay`);
  expect(started.statusCode).toBe(201);
  const payment = started.json().payment;
  // A big payment to someone new comes back HIGH since Phase 12, and
  // confirming one needs the acknowledgement the app's checkbox sends.
  const body = payment.risk?.level === "HIGH" ? { acknowledgeRisk: true } : {};
  return call(app, payer, "POST", `/api/v1/payments/${payment.id}/confirm`, body);
}

describe("QR payment requests (integration)", () => {
  let app: FastifyInstance;
  let shop: TestUser;
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    shop = await register(app, "shop-qr");
    alice = await register(app, "alice-qr");
    bob = await register(app, "bob-qr");
  });

  afterAll(async () => {
    await app.close();
  });

  it("lets a user create a request with a code, a token and an expiry", async () => {
    const before = Date.now();
    const req = await createRequest(app, shop, { amountMinorUnits: 1_250, purpose: "Flat white" });
    expect(req).toMatchObject({
      amountMinorUnits: 1_250,
      currency: "GBP",
      purpose: "Flat white",
      status: "OPEN",
      paidAt: null,
      paidBy: null,
      paymentId: null,
      receiptId: null,
    });
    expect(req.code).toMatch(/^REQ-[A-HJ-NP-Z2-9]{8}$/);
    expect(req.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const expiresIn = Date.parse(req.expiresAt) - before;
    expect(expiresIn).toBeGreaterThan(29 * 60_000);
    expect(expiresIn).toBeLessThan(31 * 60_000);
  });

  it.each([
    ["no amount", {}],
    ["a fractional amount", { amountMinorUnits: 1.5 }],
    ["a string amount", { amountMinorUnits: "150" }],
    ["an amount over the cap", { amountMinorUnits: 1_000_001 }],
    ["a zero expiry", { amountMinorUnits: 100, expiresInMinutes: 0 }],
    ["an expiry over 7 days", { amountMinorUnits: 100, expiresInMinutes: 10_081 }],
    ["an attempt to set the payee", { amountMinorUnits: 100, payeeOwnerId: "x" }],
    ["an attempt to set the status", { amountMinorUnits: 100, status: "PAID" }],
  ])("rejects creating a request with %s", async (_label, body) => {
    const res = await call(app, shop, "POST", "/api/v1/payment-requests", body);
    expect(res.statusCode).toBe(400);
  });

  it("requires sign-in for every request endpoint", async () => {
    const req = await createRequest(app, shop, { amountMinorUnits: 100 });
    for (const [method, url] of [
      ["POST", "/api/v1/payment-requests"],
      ["GET", "/api/v1/payment-requests"],
      ["GET", `/api/v1/payment-requests/${req.id}`],
      ["GET", `/api/v1/payment-requests/resolve/${req.token}`],
      ["POST", `/api/v1/payment-requests/${req.id}/pay`],
      ["POST", `/api/v1/payment-requests/${req.id}/cancel`],
    ] as const) {
      const res = await call(app, null, method, url, method === "POST" ? {} : undefined);
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("resolves by token or code for a payer, without revealing the token", async () => {
    const req = await createRequest(app, shop, { amountMinorUnits: 700, purpose: "Muffin" });
    const byToken = await call(app, alice, "GET", `/api/v1/payment-requests/resolve/${req.token}`);
    const byCode = await call(
      app,
      alice,
      "GET",
      `/api/v1/payment-requests/resolve/${req.code.toLowerCase()}`
    );
    expect(byToken.statusCode).toBe(200);
    expect(byCode.json()).toEqual(byToken.json());
    const view = byToken.json().paymentRequest;
    expect(view).toEqual({
      id: req.id,
      code: req.code,
      amountMinorUnits: 700,
      currency: "GBP",
      purpose: "Muffin",
      status: "OPEN",
      expiresAt: req.expiresAt,
      channel: "qr",
      requester: { type: "user", displayName: shop.email, verification: "registered_user" },
      isOwn: false,
      isForYou: true,
    });
    expect(JSON.stringify(byToken.json())).not.toContain(req.token);
  });

  it("says who owns it when the requester resolves their own QR", async () => {
    const req = await createRequest(app, shop, { amountMinorUnits: 700 });
    const res = await call(app, shop, "GET", `/api/v1/payment-requests/resolve/${req.token}`);
    expect(res.json().paymentRequest.isOwn).toBe(true);
  });

  it.each([
    ["an unknown code", "REQ-ZZZZZZZZ", 404],
    ["an unknown token", "A".repeat(43), 404],
    ["a malformed key", "not-a-real-key", 404],
    ["a too-short key", "abc", 400],
  ])("returns not found for %s", async (_label, key, status) => {
    const res = await call(app, alice, "GET", `/api/v1/payment-requests/resolve/${key}`);
    expect(res.statusCode).toBe(status);
  });

  it("keeps the full request private to its owner (IDOR)", async () => {
    const req = await createRequest(app, shop, { amountMinorUnits: 300 });
    const other = await call(app, alice, "GET", `/api/v1/payment-requests/${req.id}`);
    expect(other.statusCode).toBe(404);
    const cancel = await call(app, alice, "POST", `/api/v1/payment-requests/${req.id}/cancel`);
    expect(cancel.statusCode).toBe(404);
    const list = await call(app, alice, "GET", "/api/v1/payment-requests");
    expect(list.json().paymentRequests.map((r: any) => r.id)).not.toContain(req.id);
  });

  it("pays a request end to end: fixed amount, payee credited, request marked paid", async () => {
    const req = await createRequest(app, shop, { amountMinorUnits: 1_250, purpose: "Flat white" });
    const shopBefore = await balance(app, shop);
    const aliceBefore = await balance(app, alice);

    const started = await call(app, alice, "POST", `/api/v1/payment-requests/${req.id}/pay`);
    expect(started.statusCode).toBe(201);
    const payment = started.json().payment;
    expect(payment).toMatchObject({
      status: "APPROVED",
      amountMinorUnits: 1_250,
      purpose: "Flat white",
      paymentRequestId: req.id,
      counterparty: { type: "user", displayName: shop.email },
    });

    // Starting a payment doesn't mark the request paid.
    expect((await call(app, shop, "GET", `/api/v1/payment-requests/${req.id}`)).json()
      .paymentRequest.status).toBe("OPEN");

    const confirmed = await call(app, alice, "POST", `/api/v1/payments/${payment.id}/confirm`, {});
    expect(confirmed.json().payment.status).toBe("COMPLETED");
    expect(await balance(app, alice)).toBe(aliceBefore - 1_250);
    expect(await balance(app, shop)).toBe(shopBefore + 1_250);

    const own = (await call(app, shop, "GET", `/api/v1/payment-requests/${req.id}`)).json()
      .paymentRequest;
    expect(own).toMatchObject({
      status: "PAID",
      paidBy: { displayName: alice.email },
      paymentId: payment.id,
      receiptId: confirmed.json().payment.receiptId,
    });
    expect(own.paidAt).toEqual(expect.any(String));

    // The requester can open the receipt for money they received.
    const receipt = await call(app, shop, "GET", `/api/v1/receipts/${own.receiptId}`);
    expect(receipt.json().receipt).toMatchObject({ role: "payee", amountMinorUnits: 1_250 });

    // The public view now says paid, and it can't be paid again.
    const resolved = await call(app, bob, "GET", `/api/v1/payment-requests/resolve/${req.code}`);
    expect(resolved.json().paymentRequest.status).toBe("PAID");
    const again = await call(app, bob, "POST", `/api/v1/payment-requests/${req.id}/pay`);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe("PAYMENT_REQUEST_ALREADY_PAID");
  });

  it("won't let you pay your own request", async () => {
    const req = await createRequest(app, shop, { amountMinorUnits: 100 });
    const res = await call(app, shop, "POST", `/api/v1/payment-requests/${req.id}/pay`);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe("SELF_PAYMENT");
  });

  it("lets two people start paying the same QR, but only the first confirm completes", async () => {
    const req = await createRequest(app, shop, { amountMinorUnits: 500 });
    const shopBefore = await balance(app, shop);
    const aliceBefore = await balance(app, alice);
    const bobBefore = await balance(app, bob);

    const a = (await call(app, alice, "POST", `/api/v1/payment-requests/${req.id}/pay`)).json().payment;
    const b = (await call(app, bob, "POST", `/api/v1/payment-requests/${req.id}/pay`)).json().payment;

    const [ra, rb] = await Promise.all([
      call(app, alice, "POST", `/api/v1/payments/${a.id}/confirm`, {}),
      call(app, bob, "POST", `/api/v1/payments/${b.id}/confirm`, {}),
    ]);
    const results = [ra.json().payment, rb.json().payment];
    const statuses = results.map((p) => p.status).sort();
    expect(statuses).toEqual(["COMPLETED", "FAILED"]);
    const loser = results.find((p) => p.status === "FAILED")!;
    expect(loser.failureReason).toBe("PAYMENT_REQUEST_ALREADY_PAID");
    expect(loser.receiptId).toBeNull();

    expect(await balance(app, shop)).toBe(shopBefore + 500);
    expect((await balance(app, alice)) + (await balance(app, bob))).toBe(aliceBefore + bobBefore - 500);

    const own = (await call(app, shop, "GET", `/api/v1/payment-requests/${req.id}`)).json()
      .paymentRequest;
    const winner = results.find((p) => p.status === "COMPLETED")!;
    expect(own.paymentId).toBe(winner.id);
  });

  it("stops a payment started before the request was cancelled", async () => {
    const req = await createRequest(app, shop, { amountMinorUnits: 400 });
    const payment = (await call(app, alice, "POST", `/api/v1/payment-requests/${req.id}/pay`)).json()
      .payment;
    const cancelled = await call(app, shop, "POST", `/api/v1/payment-requests/${req.id}/cancel`);
    expect(cancelled.json().paymentRequest.status).toBe("CANCELLED");

    const before = await balance(app, alice);
    const confirmed = await call(app, alice, "POST", `/api/v1/payments/${payment.id}/confirm`, {});
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json().payment).toMatchObject({
      status: "FAILED",
      failureReason: "PAYMENT_REQUEST_CANCELLED",
    });
    expect(await balance(app, alice)).toBe(before);

    const again = await call(app, bob, "POST", `/api/v1/payment-requests/${req.id}/pay`);
    expect(again.json().code).toBe("PAYMENT_REQUEST_CANCELLED");
    const cancelAgain = await call(app, shop, "POST", `/api/v1/payment-requests/${req.id}/cancel`);
    expect(cancelAgain.statusCode).toBe(409);
  });

  it("treats a request past its expiry as expired, for new and in-flight payments", async () => {
    const pool = getPool();
    const req = await createRequest(app, shop, { amountMinorUnits: 250, expiresInMinutes: 1 });
    const payment = (await call(app, alice, "POST", `/api/v1/payment-requests/${req.id}/pay`)).json()
      .payment;

    // Move the clock for this request only.
    await pool.query(
      `update payment_requests
       set created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
       where id = $1`,
      [req.id]
    );

    const own = (await call(app, shop, "GET", `/api/v1/payment-requests/${req.id}`)).json()
      .paymentRequest;
    expect(own.status).toBe("EXPIRED");

    const before = await balance(app, alice);
    const confirmed = await call(app, alice, "POST", `/api/v1/payments/${payment.id}/confirm`, {});
    expect(confirmed.json().payment.failureReason).toBe("PAYMENT_REQUEST_EXPIRED");
    expect(await balance(app, alice)).toBe(before);

    const fresh = await call(app, bob, "POST", `/api/v1/payment-requests/${req.id}/pay`);
    expect(fresh.statusCode).toBe(409);
    expect(fresh.json().code).toBe("PAYMENT_REQUEST_EXPIRED");

    // Stored status stays OPEN; expiry is computed, and it can still be tidied away.
    const cancel = await call(app, shop, "POST", `/api/v1/payment-requests/${req.id}/cancel`);
    expect(cancel.json().paymentRequest.status).toBe("CANCELLED");
  });

  it("fails cleanly when the payer can't afford the request, leaving it open", async () => {
    const big = await createRequest(app, shop, { amountMinorUnits: 900_000 });
    const res = await payAndConfirm(app, bob, big.id);
    expect(res.json().payment).toMatchObject({
      status: "FAILED",
      failureReason: "INSUFFICIENT_FUNDS",
    });
    const own = (await call(app, shop, "GET", `/api/v1/payment-requests/${big.id}`)).json()
      .paymentRequest;
    expect(own.status).toBe("OPEN");
  });

  it("lists the owner's requests newest first", async () => {
    const r1 = await createRequest(app, bob, { amountMinorUnits: 101 });
    const r2 = await createRequest(app, bob, { amountMinorUnits: 102 });
    const list = (await call(app, bob, "GET", "/api/v1/payment-requests")).json().paymentRequests;
    expect(list.slice(0, 2).map((r: any) => r.id)).toEqual([r2.id, r1.id]);
  });

  it("writes the audit trail for create, pay and cancel", async () => {
    const pool = getPool();
    const req = await createRequest(app, shop, { amountMinorUnits: 150 });
    await payAndConfirm(app, alice, req.id);
    const types = (
      await pool.query(
        `select event_type from audit_events where metadata->>'paymentRequestId' = $1 order by created_at`,
        [req.id]
      )
    ).rows.map((r) => r.event_type);
    expect(types).toEqual(
      expect.arrayContaining(["PAYMENT_REQUEST_CREATED", "PAYMENT_CREATED", "PAYMENT_REQUEST_PAID"])
    );
  });

  it("keeps the database's own rules: a paid request always points at its payment", async () => {
    const pool = getPool();
    const req = await createRequest(app, shop, { amountMinorUnits: 150 });
    await expect(
      pool.query(`update payment_requests set status = 'PAID' where id = $1`, [req.id])
    ).rejects.toThrow(/payment_requests_paid_consistent/);
    const orphans = await pool.query(
      `select pr.id from payment_requests pr
       left join payments p on p.id = pr.paid_payment_id
       where pr.status = 'PAID'
         and (p.status <> 'COMPLETED' or p.payment_request_id <> pr.id
              or p.amount_minor_units <> pr.amount_minor_units)`
    );
    expect(orphans.rowCount).toBe(0);
  });
});

describe("direct payment requests (integration)", () => {
  let app: FastifyInstance;
  let asker: TestUser;
  let friend: TestUser;
  let stranger: TestUser;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    asker = await register(app, "asker-direct");
    friend = await register(app, "friend-direct");
    stranger = await register(app, "stranger-direct");
  });

  afterAll(async () => {
    await app.close();
  });

  const ask = (body: object) => createRequest(app, asker, { toEmail: friend.email, ...body });

  it("creates a request addressed to a person, defaulting to a 7-day expiry", async () => {
    const before = Date.now();
    const req = await ask({ amountMinorUnits: 2_400, purpose: "Taxi" });
    expect(req).toMatchObject({
      channel: "direct",
      amountMinorUnits: 2_400,
      purpose: "Taxi",
      status: "OPEN",
      sentTo: { displayName: friend.email },
      declinedAt: null,
      paidBy: null,
    });
    const expiresIn = Date.parse(req.expiresAt) - before;
    expect(expiresIn).toBeGreaterThan(6.9 * 24 * 60 * 60_000);
    expect(expiresIn).toBeLessThan(7.1 * 24 * 60 * 60_000);
  });

  it("still creates a QR request when no recipient is given", async () => {
    const req = await createRequest(app, asker, { amountMinorUnits: 100 });
    expect(req.channel).toBe("qr");
    expect(req.sentTo).toBeNull();
  });

  it.each([
    ["an address nobody has registered", `nobody.${run}@example.com`],
    ["your own address", null],
    ["an empty address", "   "],
  ])("refuses to send a request to %s", async (_label, email) => {
    const res = await call(app, asker, "POST", "/api/v1/payment-requests", {
      amountMinorUnits: 100,
      toEmail: email ?? asker.email,
    });
    // A blank address falls back to a QR request rather than failing.
    if (email === "   ") {
      expect(res.statusCode).toBe(201);
      expect(res.json().paymentRequest.channel).toBe("qr");
      return;
    }
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("PAYMENT_REQUEST_INVALID_RECIPIENT");
  });

  it("puts it in the recipient's inbox and counts it as waiting", async () => {
    const req = await ask({ amountMinorUnits: 555, purpose: "Lunch" });
    const inbox = (await call(app, friend, "GET", "/api/v1/payment-requests/incoming")).json();
    const mine = inbox.paymentRequests.find((r: any) => r.id === req.id);
    expect(mine).toMatchObject({
      amountMinorUnits: 555,
      purpose: "Lunch",
      status: "OPEN",
      requester: { displayName: asker.email },
    });
    // The inbox view never carries the QR token.
    expect(mine.token).toBeUndefined();
    expect(inbox.waitingCount).toBeGreaterThan(0);

    const others = (await call(app, stranger, "GET", "/api/v1/payment-requests/incoming")).json();
    expect(others.paymentRequests.map((r: any) => r.id)).not.toContain(req.id);
  });

  it("is visible to the two people involved and to nobody else", async () => {
    const req = await ask({ amountMinorUnits: 320 });

    const forFriend = (
      await call(app, friend, "GET", `/api/v1/payment-requests/resolve/${req.id}`)
    ).json().paymentRequest;
    expect(forFriend).toMatchObject({ channel: "direct", isOwn: false, isForYou: true });

    const forAsker = (
      await call(app, asker, "GET", `/api/v1/payment-requests/resolve/${req.id}`)
    ).json().paymentRequest;
    expect(forAsker).toMatchObject({ isOwn: true, isForYou: false });

    for (const key of [req.id, req.code, req.token]) {
      const res = await call(app, stranger, "GET", `/api/v1/payment-requests/resolve/${key}`);
      expect(res.statusCode, `resolve ${key}`).toBe(404);
    }
  });

  it("can only be paid by the person it was sent to", async () => {
    const req = await ask({ amountMinorUnits: 640 });

    const byStranger = await call(app, stranger, "POST", `/api/v1/payment-requests/${req.id}/pay`);
    expect(byStranger.statusCode).toBe(404);

    const byAsker = await call(app, asker, "POST", `/api/v1/payment-requests/${req.id}/pay`);
    expect(byAsker.statusCode).toBe(403);
    expect(byAsker.json().code).toBe("PAYMENT_REQUEST_NOT_FOR_YOU");

    expect((await call(app, friend, "POST", `/api/v1/payment-requests/${req.id}/pay`)).statusCode)
      .toBe(201);
  });

  it("pays it end to end and closes it on both sides", async () => {
    const req = await ask({ amountMinorUnits: 1_100, purpose: "Concert ticket" });
    const askerBefore = await balance(app, asker);
    const friendBefore = await balance(app, friend);
    const waitingBefore = (
      await call(app, friend, "GET", "/api/v1/payment-requests/incoming")
    ).json().waitingCount;

    const confirmed = await payAndConfirm(app, friend, req.id);
    expect(confirmed.json().payment.status).toBe("COMPLETED");
    expect(await balance(app, friend)).toBe(friendBefore - 1_100);
    expect(await balance(app, asker)).toBe(askerBefore + 1_100);

    const own = (await call(app, asker, "GET", `/api/v1/payment-requests/${req.id}`)).json()
      .paymentRequest;
    expect(own).toMatchObject({
      status: "PAID",
      paidBy: { displayName: friend.email },
      paymentId: confirmed.json().payment.id,
    });

    const inbox = (await call(app, friend, "GET", "/api/v1/payment-requests/incoming")).json();
    const mine = inbox.paymentRequests.find((r: any) => r.id === req.id);
    expect(mine.status).toBe("PAID");
    expect(mine.receiptId).toBe(confirmed.json().payment.receiptId);
    expect(inbox.waitingCount).toBe(waitingBefore - 1);
  });

  it("lets the recipient decline, and records who said no", async () => {
    const pool = getPool();
    const req = await ask({ amountMinorUnits: 700 });

    const byStranger = await call(app, stranger, "POST", `/api/v1/payment-requests/${req.id}/decline`);
    expect(byStranger.statusCode).toBe(404);
    // The person asking can't decline on the other's behalf — they cancel instead.
    const byAsker = await call(app, asker, "POST", `/api/v1/payment-requests/${req.id}/decline`);
    expect(byAsker.statusCode).toBe(404);

    const declined = await call(app, friend, "POST", `/api/v1/payment-requests/${req.id}/decline`);
    expect(declined.statusCode).toBe(200);
    expect(declined.json().paymentRequest.status).toBe("DECLINED");

    const own = (await call(app, asker, "GET", `/api/v1/payment-requests/${req.id}`)).json()
      .paymentRequest;
    expect(own.status).toBe("DECLINED");
    expect(own.declinedAt).toEqual(expect.any(String));
    expect(own.paidBy).toBeNull();

    const again = await call(app, friend, "POST", `/api/v1/payment-requests/${req.id}/decline`);
    expect(again.statusCode).toBe(409);

    const pay = await call(app, friend, "POST", `/api/v1/payment-requests/${req.id}/pay`);
    expect(pay.statusCode).toBe(409);
    expect(pay.json().code).toBe("PAYMENT_REQUEST_DECLINED");

    const events = (
      await pool.query(
        `select event_type, actor_user_id from audit_events
         where metadata->>'paymentRequestId' = $1 order by created_at`,
        [req.id]
      )
    ).rows;
    const declinedEvent = events.find((e) => e.event_type === "PAYMENT_REQUEST_DECLINED");
    expect(declinedEvent?.actor_user_id).toBe(friend.id);
  });

  it("stops a payment that was started before the recipient declined", async () => {
    const req = await ask({ amountMinorUnits: 480 });
    const payment = (
      await call(app, friend, "POST", `/api/v1/payment-requests/${req.id}/pay`)
    ).json().payment;
    await call(app, friend, "POST", `/api/v1/payment-requests/${req.id}/decline`);

    const before = await balance(app, friend);
    const confirmed = await call(app, friend, "POST", `/api/v1/payments/${payment.id}/confirm`, {});
    expect(confirmed.json().payment).toMatchObject({
      status: "FAILED",
      failureReason: "PAYMENT_REQUEST_DECLINED",
      receiptId: null,
    });
    expect(await balance(app, friend)).toBe(before);
  });

  it("lets the requester cancel one that hasn't been answered", async () => {
    const req = await ask({ amountMinorUnits: 210 });
    const cancelled = await call(app, asker, "POST", `/api/v1/payment-requests/${req.id}/cancel`);
    expect(cancelled.json().paymentRequest.status).toBe("CANCELLED");
    const decline = await call(app, friend, "POST", `/api/v1/payment-requests/${req.id}/decline`);
    expect(decline.statusCode).toBe(409);
  });

  it("requires sign-in for the inbox and for declining", async () => {
    const req = await ask({ amountMinorUnits: 100 });
    for (const [method, url] of [
      ["GET", "/api/v1/payment-requests/incoming"],
      ["POST", `/api/v1/payment-requests/${req.id}/decline`],
    ] as const) {
      const res = await call(app, null, method, url, method === "POST" ? {} : undefined);
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("keeps the database's own rules: a direct request can only be paid by its target", async () => {
    const pool = getPool();
    const req = await ask({ amountMinorUnits: 100 });
    await expect(
      pool.query(`update payment_requests set paid_by_user_id = $2 where id = $1`, [
        req.id,
        stranger.id,
      ])
    ).rejects.toThrow(/payment_requests_direct_payer_is_target/);
    await expect(
      pool.query(`update payment_requests set target_user_id = created_by_user_id where id = $1`, [
        req.id,
      ])
    ).rejects.toThrow(/payment_requests_target_not_self/);
  });
});

describe("payment completion hooks (integration)", () => {
  it("rolls a payment back when an extra hook blocks it", async () => {
    const app = buildApp({
      logger: false,
      extraCompletionHooks: [
        async (_client, payment) => {
          if (payment.amountMinorUnits === 4_321) throw new PaymentBlockedError("TEST_BLOCKED");
        },
      ],
    });
    try {
      const payer = await register(app, "hook-payer");
      const payee = await register(app, "hook-payee");
      const created = await call(app, payer, "POST", "/api/v1/payments", {
        recipientEmail: payee.email,
        amountMinorUnits: 4_321,
      });
      const res = await call(
        app,
        payer,
        "POST",
        `/api/v1/payments/${created.json().payment.id}/confirm`,
        {}
      );
      expect(res.json().payment).toMatchObject({
        status: "FAILED",
        failureReason: "TEST_BLOCKED",
        receiptId: null,
        transactionId: null,
      });
      expect(await balance(app, payer)).toBe(START);
      expect(await balance(app, payee)).toBe(START);
    } finally {
      await app.close();
    }
  });
});
