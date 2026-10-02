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

describe("bill splits (integration)", () => {
  let app: FastifyInstance;
  let organiser: TestUser;
  let ana: TestUser;
  let ben: TestUser;
  let outsider: TestUser;

  beforeAll(async () => {
    app = buildApp({ logger: false });
    organiser = await register(app, "split-organiser");
    ana = await register(app, "split-ana");
    ben = await register(app, "split-ben");
    outsider = await register(app, "split-outsider");
  });

  afterAll(async () => {
    await app.close();
  });

  const createSplit = async (body: object, as: TestUser = organiser) => {
    const res = await call(app, as, "POST", "/api/v1/bill-splits", body);
    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    return res.json().billSplit;
  };

  const inbox = async (u: TestUser) =>
    (await call(app, u, "GET", "/api/v1/payment-requests/incoming")).json().paymentRequests;

  async function payShare(payer: TestUser, requestId: string) {
    const started = await call(app, payer, "POST", `/api/v1/payment-requests/${requestId}/pay`);
    expect(started.statusCode).toBe(201);
    return call(app, payer, "POST", `/api/v1/payments/${started.json().payment.id}/confirm`, {});
  }

  it("splits a bill three ways, keeping the organiser's share and asking for the rest", async () => {
    const split = await createSplit({
      totalMinorUnits: 1_000,
      purpose: "Pizza",
      participantEmails: [ana.email, ben.email],
    });

    // £10 between 3: 334 / 333 / 333, and the organiser takes the extra penny.
    expect(split).toMatchObject({
      totalMinorUnits: 1_000,
      currency: "GBP",
      purpose: "Pizza",
      method: "even",
      status: "OPEN",
      organiserShareMinorUnits: 334,
      collectedMinorUnits: 0,
      outstandingMinorUnits: 666,
      organiser: { displayName: organiser.email, isYou: true },
    });
    expect(split.shares.map((s: any) => s.amountMinorUnits)).toEqual([333, 333]);
    expect(split.shares.map((s: any) => s.person.displayName)).toEqual([ana.email, ben.email]);
    expect(split.shares.every((s: any) => s.status === "OPEN")).toBe(true);

    const sum =
      split.organiserShareMinorUnits +
      split.shares.reduce((t: number, s: any) => t + s.amountMinorUnits, 0);
    expect(sum).toBe(1_000);
  });

  it("puts each share in the right person's inbox, and nobody else's", async () => {
    const split = await createSplit({
      totalMinorUnits: 3_000,
      purpose: "Taxi",
      participantEmails: [ana.email, ben.email],
    });

    const forAna = (await inbox(ana)).find((r: any) => r.billSplitId === split.id);
    const forBen = (await inbox(ben)).find((r: any) => r.billSplitId === split.id);
    expect(forAna).toMatchObject({ amountMinorUnits: 1_000, purpose: "Taxi", status: "OPEN" });
    expect(forBen).toMatchObject({ amountMinorUnits: 1_000, status: "OPEN" });
    expect(forAna.id).not.toBe(forBen.id);

    const forOutsider = await inbox(outsider);
    expect(forOutsider.map((r: any) => r.billSplitId)).not.toContain(split.id);
  });

  it("collects the money one share at a time and settles when everyone has answered", async () => {
    const split = await createSplit({
      totalMinorUnits: 3_000,
      purpose: "Dinner",
      participantEmails: [ana.email, ben.email],
    });
    const organiserBefore = await balance(app, organiser);
    const anaBefore = await balance(app, ana);

    const anaShare = split.shares[0];
    const benShare = split.shares[1];

    const paid = await payShare(ana, anaShare.paymentRequestId);
    expect(paid.json().payment.status).toBe("COMPLETED");
    expect(await balance(app, ana)).toBe(anaBefore - 1_000);
    expect(await balance(app, organiser)).toBe(organiserBefore + 1_000);

    let view = (await call(app, organiser, "GET", `/api/v1/bill-splits/${split.id}`)).json()
      .billSplit;
    expect(view).toMatchObject({
      status: "OPEN",
      collectedMinorUnits: 1_000,
      outstandingMinorUnits: 1_000,
    });
    expect(view.shares[0]).toMatchObject({ status: "PAID" });
    expect(view.shares[0].receiptId).toEqual(expect.any(String));

    // Ben says no; the split is finished with, even though only half arrived.
    const declined = await call(
      app,
      ben,
      "POST",
      `/api/v1/payment-requests/${benShare.paymentRequestId}/decline`
    );
    expect(declined.statusCode).toBe(200);

    view = (await call(app, organiser, "GET", `/api/v1/bill-splits/${split.id}`)).json().billSplit;
    expect(view).toMatchObject({
      status: "SETTLED",
      collectedMinorUnits: 1_000,
      outstandingMinorUnits: 0,
    });
    expect(view.shares.map((s: any) => s.status)).toEqual(["PAID", "DECLINED"]);
  });

  it("takes exact amounts when they add up, and refuses them when they don't", async () => {
    const split = await createSplit({
      totalMinorUnits: 5_000,
      purpose: "Weekend",
      participantEmails: [ana.email, ben.email],
      shareMinorUnits: [3_000, 1_500, 500],
    });
    expect(split.method).toBe("custom");
    expect(split.organiserShareMinorUnits).toBe(3_000);
    expect(split.shares.map((s: any) => s.amountMinorUnits)).toEqual([1_500, 500]);

    for (const bad of [
      [3_000, 1_500, 499],
      [3_000, 1_500, 501],
      [2_500, 2_500],
    ]) {
      const res = await call(app, organiser, "POST", "/api/v1/bill-splits", {
        totalMinorUnits: 5_000,
        participantEmails: [ana.email, ben.email],
        shareMinorUnits: bad,
      });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it("can leave the organiser out, so the whole bill is asked of the others", async () => {
    const split = await createSplit({
      totalMinorUnits: 2_000,
      purpose: "Gift for the organiser",
      participantEmails: [ana.email, ben.email],
      includeOrganiser: false,
    });
    expect(split.organiserShareMinorUnits).toBe(0);
    expect(split.shares.map((s: any) => s.amountMinorUnits)).toEqual([1_000, 1_000]);
    expect(split.outstandingMinorUnits).toBe(2_000);
  });

  it.each([
    ["nobody else", { totalMinorUnits: 1_000, participantEmails: [] }],
    ["the same person twice", { totalMinorUnits: 1_000, participantEmails: ["a", "a"] }],
    ["a fractional total", { totalMinorUnits: 10.5, participantEmails: ["a"] }],
    ["a string total", { totalMinorUnits: "1000", participantEmails: ["a"] }],
    ["a total over the cap", { totalMinorUnits: 1_000_001, participantEmails: ["a"] }],
    ["an attempt to set the status", { totalMinorUnits: 1_000, participantEmails: ["a"], status: "SETTLED" }],
  ])("refuses a split with %s", async (_label, body) => {
    const payload = {
      ...body,
      participantEmails: (body.participantEmails as string[]).map((p) =>
        p === "a" ? ana.email : `${p}.${run}@example.com`
      ),
    };
    const res = await call(app, organiser, "POST", "/api/v1/bill-splits", payload);
    expect(res.statusCode).toBe(400);
  });

  it("creates nothing at all when one of the people can't be added", async () => {
    const pool = getPool();
    const before = await pool.query(`select count(*)::int as n from bill_splits`);
    const beforeRequests = await pool.query(`select count(*)::int as n from payment_requests`);

    for (const bad of [`ghost.${run}@example.com`, organiser.email]) {
      const res = await call(app, organiser, "POST", "/api/v1/bill-splits", {
        totalMinorUnits: 3_000,
        purpose: "Never happens",
        participantEmails: [ana.email, bad],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("BILL_SPLIT_INVALID_PARTICIPANT");
    }

    const after = await pool.query(`select count(*)::int as n from bill_splits`);
    const afterRequests = await pool.query(`select count(*)::int as n from payment_requests`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(afterRequests.rows[0].n).toBe(beforeRequests.rows[0].n);
  });

  it("shows the split to everyone in it, and to nobody else", async () => {
    const split = await createSplit({
      totalMinorUnits: 1_500,
      participantEmails: [ana.email],
    });

    const forAna = await call(app, ana, "GET", `/api/v1/bill-splits/${split.id}`);
    expect(forAna.statusCode).toBe(200);
    expect(forAna.json().billSplit.organiser).toMatchObject({
      displayName: organiser.email,
      isYou: false,
    });

    const forOutsider = await call(app, outsider, "GET", `/api/v1/bill-splits/${split.id}`);
    expect(forOutsider.statusCode).toBe(404);

    // Only the organiser's own splits are listed.
    const anaList = (await call(app, ana, "GET", "/api/v1/bill-splits")).json().billSplits;
    expect(anaList.map((s: any) => s.id)).not.toContain(split.id);
  });

  it("cancels the shares nobody answered, and leaves paid ones alone", async () => {
    const split = await createSplit({
      totalMinorUnits: 3_000,
      purpose: "Cancelled outing",
      participantEmails: [ana.email, ben.email],
    });
    const organiserBefore = await balance(app, organiser);
    await payShare(ana, split.shares[0].paymentRequestId);

    const byOther = await call(app, ana, "POST", `/api/v1/bill-splits/${split.id}/cancel`);
    expect(byOther.statusCode).toBe(404);

    const cancelled = await call(app, organiser, "POST", `/api/v1/bill-splits/${split.id}/cancel`);
    expect(cancelled.statusCode).toBe(200);
    const view = cancelled.json().billSplit;
    expect(view.status).toBe("CANCELLED");
    expect(view.shares.map((s: any) => s.status)).toEqual(["PAID", "CANCELLED"]);
    // The money that already arrived stays put.
    expect(view.collectedMinorUnits).toBe(1_000);
    expect(await balance(app, organiser)).toBe(organiserBefore + 1_000);

    // Ben can't pay his share now.
    const tryPay = await call(
      app,
      ben,
      "POST",
      `/api/v1/payment-requests/${split.shares[1].paymentRequestId}/pay`
    );
    expect(tryPay.statusCode).toBe(409);
    expect(tryPay.json().code).toBe("PAYMENT_REQUEST_CANCELLED");

    const again = await call(app, organiser, "POST", `/api/v1/bill-splits/${split.id}/cancel`);
    expect(again.statusCode).toBe(409);
  });

  it("keeps a share a normal request: only its person can pay it", async () => {
    const split = await createSplit({
      totalMinorUnits: 2_000,
      participantEmails: [ana.email],
    });
    const shareId = split.shares[0].paymentRequestId;

    expect((await call(app, outsider, "POST", `/api/v1/payment-requests/${shareId}/pay`)).statusCode)
      .toBe(404);
    expect((await call(app, organiser, "POST", `/api/v1/payment-requests/${shareId}/pay`)).statusCode)
      .toBe(403);
    expect((await call(app, ana, "POST", `/api/v1/payment-requests/${shareId}/pay`)).statusCode)
      .toBe(201);
  });

  it("requires sign-in for every split endpoint", async () => {
    const split = await createSplit({ totalMinorUnits: 1_000, participantEmails: [ana.email] });
    for (const [method, url] of [
      ["POST", "/api/v1/bill-splits"],
      ["GET", "/api/v1/bill-splits"],
      ["GET", `/api/v1/bill-splits/${split.id}`],
      ["POST", `/api/v1/bill-splits/${split.id}/cancel`],
    ] as const) {
      const res = await call(app, null, method, url, method === "POST" ? {} : undefined);
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("writes the audit trail for a split and its shares", async () => {
    const pool = getPool();
    const split = await createSplit({
      totalMinorUnits: 1_200,
      purpose: "Audited",
      participantEmails: [ana.email, ben.email],
    });
    const events = (
      await pool.query(
        `select event_type from audit_events
         where metadata->>'billSplitId' = $1 order by created_at`,
        [split.id]
      )
    ).rows.map((r) => r.event_type);
    expect(events).toEqual(
      expect.arrayContaining([
        "BILL_SPLIT_CREATED",
        "PAYMENT_REQUEST_CREATED",
        "PAYMENT_REQUEST_CREATED",
      ])
    );
  });

  it("keeps the database's own rules about splits", async () => {
    const pool = getPool();
    const split = await createSplit({ totalMinorUnits: 1_000, participantEmails: [ana.email] });

    await expect(
      pool.query(`update bill_splits set status = 'CANCELLED' where id = $1`, [split.id])
    ).rejects.toThrow(/bill_splits_cancelled_consistent/);
    await expect(
      pool.query(`update bill_splits set total_minor_units = 0 where id = $1`, [split.id])
    ).rejects.toThrow(/bill_splits_(total_positive|organiser_share_not_negative)/);
    await expect(
      pool.query(
        `update bill_splits set organiser_share_minor_units = total_minor_units + 1 where id = $1`,
        [split.id]
      )
    ).rejects.toThrow(/bill_splits_organiser_share_not_negative/);
    // A share is always addressed to someone.
    await expect(
      pool.query(
        `update payment_requests set target_user_id = null, channel = 'qr'
         where bill_split_id = $1`,
        [split.id]
      )
    ).rejects.toThrow(/payment_requests_split_is_direct/);
  });

  it("never loses or invents a penny across every split made here", async () => {
    const pool = getPool();
    const mismatched = await pool.query(
      `select bs.id
       from bill_splits bs
       join payment_requests pr on pr.bill_split_id = bs.id
       group by bs.id, bs.total_minor_units, bs.organiser_share_minor_units
       having sum(pr.amount_minor_units) + bs.organiser_share_minor_units
              <> bs.total_minor_units`
    );
    expect(mismatched.rowCount).toBe(0);
  });
});
