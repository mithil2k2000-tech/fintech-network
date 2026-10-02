import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/index.js";
import { getPool } from "../../src/db.js";
import {
  postTransaction,
  getBalanceMinorUnits,
  getOrCreateAccountForOwner,
  getOrCreateSystemAccount,
  LedgerImbalanceError,
} from "../../src/modules/ledger/index.js";

// Requires a real Postgres reachable at DATABASE_URL with migrations
// already applied.

describe("ledger (integration)", () => {
  let app: FastifyInstance;
  const email = `carol.${Date.now()}@example.com`;
  const password = "correct-horse-battery-staple";

  beforeAll(() => {
    app = buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("seeds a starting balance on registration", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { email, password },
    });
    expect(res.statusCode).toBe(201);
    const { token } = res.json();

    const accountRes = await app.inject({
      method: "GET",
      url: "/api/v1/accounts/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(accountRes.statusCode).toBe(200);
    expect(accountRes.json().account.balanceMinorUnits).toBe(50_000);
  });

  it("rejects the balance endpoint with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/accounts/me" });
    expect(res.statusCode).toBe(401);
  });

  it("moves money between two accounts and keeps both balances consistent", async () => {
    const pool = getPool();
    const payer = await getOrCreateSystemAccount(pool, `test-payer-${Date.now()}`);
    const payee = await getOrCreateSystemAccount(pool, `test-payee-${Date.now()}`);

    // Give the payer funds first, the same way seedDemoBalance does.
    const funding = await getOrCreateSystemAccount(pool, "seed_funding");
    await postTransaction(pool, {
      description: "test funding",
      entries: [
        { accountId: funding.id, direction: "debit", amountMinorUnits: 1000 },
        { accountId: payer.id, direction: "credit", amountMinorUnits: 1000 },
      ],
    });

    await postTransaction(pool, {
      description: "test transfer",
      entries: [
        { accountId: payer.id, direction: "debit", amountMinorUnits: 400 },
        { accountId: payee.id, direction: "credit", amountMinorUnits: 400 },
      ],
    });

    expect(await getBalanceMinorUnits(pool, payer.id)).toBe(600);
    expect(await getBalanceMinorUnits(pool, payee.id)).toBe(400);
  });

  it("rejects an unbalanced transaction before touching the database", async () => {
    const pool = getPool();
    const account = await getOrCreateSystemAccount(pool, `test-unbalanced-${Date.now()}`);

    await expect(
      postTransaction(pool, {
        description: "should never be posted",
        entries: [
          { accountId: account.id, direction: "debit", amountMinorUnits: 500 },
          { accountId: account.id, direction: "credit", amountMinorUnits: 499 },
        ],
      })
    ).rejects.toBeInstanceOf(LedgerImbalanceError);

    // Confirm nothing was written — balance is untouched by the rejected attempt.
    expect(await getBalanceMinorUnits(pool, account.id)).toBe(0);
  });

  it("getOrCreateAccountForOwner is idempotent for the same user", async () => {
    const pool = getPool();
    const first = await getOrCreateAccountForOwner(pool, "user", "00000000-0000-0000-0000-000000000000".replace(/0$/, "1"));
    const second = await getOrCreateAccountForOwner(pool, "user", "00000000-0000-0000-0000-000000000000".replace(/0$/, "1"));
    expect(first.id).toBe(second.id);
  });
});
