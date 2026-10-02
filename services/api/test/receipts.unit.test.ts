import { describe, it, expect } from "vitest";
import {
  generateReceiptNumber,
  generatePassportReference,
  toReceiptView,
  type Receipt,
} from "../src/modules/receipts/index.js";
import { encodeCursor, decodeCursor } from "../src/routes/transactions.js";

describe("receipt numbers", () => {
  it("are RCP- plus 12 unambiguous characters", () => {
    for (let i = 0; i < 200; i++) {
      expect(generateReceiptNumber()).toMatch(/^RCP-[A-HJ-NP-Z2-9]{12}$/);
    }
  });

  it("don't repeat across a large sample", () => {
    const seen = new Set(Array.from({ length: 20_000 }, generateReceiptNumber));
    expect(seen.size).toBe(20_000);
  });
});

describe("passport references", () => {
  it("are long, url-safe and unique", () => {
    const refs = Array.from({ length: 1_000 }, generatePassportReference);
    for (const ref of refs) expect(ref).toMatch(/^PP-[A-Za-z0-9_-]{43}$/);
    expect(new Set(refs).size).toBe(refs.length);
  });
});

describe("toReceiptView", () => {
  const receipt: Receipt = {
    id: "r1",
    receiptNumber: "RCP-ABCDEFGHJKLM",
    paymentId: "p1",
    transactionId: "t1",
    payerUserId: "alice",
    payeeOwnerType: "user",
    payeeOwnerId: "bob",
    payerDisplayName: "alice@example.com",
    payeeDisplayName: "bob@example.com",
    amountMinorUnits: 1250,
    currency: "GBP",
    purpose: "Coffee",
    passportReference: "PP-x",
    issuedAt: "2026-09-17T10:00:00.000Z",
  };

  it("frames the receipt for the payer", () => {
    const view = toReceiptView(receipt, "alice", "COMPLETED");
    expect(view).toMatchObject({
      role: "payer",
      from: "alice@example.com",
      to: "bob@example.com",
      amountMinorUnits: 1250,
      paymentStatus: "COMPLETED",
    });
  });

  it("frames the receipt for the payee and reflects the live status", () => {
    const view = toReceiptView(receipt, "bob", "REFUNDED");
    expect(view.role).toBe("payee");
    expect(view.paymentStatus).toBe("REFUNDED");
  });

  it("marks the Payment Passport as not yet available", () => {
    expect(toReceiptView(receipt, "alice", "COMPLETED").passport).toEqual({
      reference: "PP-x",
      available: false,
    });
  });
});

describe("activity cursors", () => {
  const cursor = {
    occurredAt: "2026-09-17T10:00:00.123Z",
    entryId: "3f2a9c1e-5b7d-4e8a-9c21-7d4e5f6a8b90",
  };

  it("round-trip", () => {
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it.each([
    ["garbage", "not-a-cursor!!"],
    ["valid base64 but not JSON", Buffer.from("hello").toString("base64url")],
    ["wrong shape", Buffer.from(JSON.stringify({ a: 1 })).toString("base64url")],
    ["bad date", Buffer.from(JSON.stringify(["yesterday", cursor.entryId])).toString("base64url")],
    ["bad id (SQL-ish)", Buffer.from(JSON.stringify([cursor.occurredAt, "1' or '1'='1"])).toString("base64url")],
  ])("reject %s", (_label, raw) => {
    expect(decodeCursor(raw)).toBeNull();
  });
});
