import { describe, it, expect } from "vitest";
import { assertBalanced, LedgerImbalanceError } from "../src/modules/ledger/index.js";

// Pure logic, no DB — the invariant a Postgres CHECK constraint can't
// express on its own (it can't see sibling rows in the same transaction).

describe("assertBalanced", () => {
  it("accepts a simple balanced debit/credit pair", () => {
    expect(() =>
      assertBalanced([
        { accountId: "a", direction: "debit", amountMinorUnits: 2000 },
        { accountId: "b", direction: "credit", amountMinorUnits: 2000 },
      ])
    ).not.toThrow();
  });

  it("accepts a multi-entry transaction that nets to zero", () => {
    expect(() =>
      assertBalanced([
        { accountId: "a", direction: "debit", amountMinorUnits: 1000 },
        { accountId: "b", direction: "debit", amountMinorUnits: 500 },
        { accountId: "c", direction: "credit", amountMinorUnits: 1500 },
      ])
    ).not.toThrow();
  });

  it("rejects debits that don't equal credits", () => {
    expect(() =>
      assertBalanced([
        { accountId: "a", direction: "debit", amountMinorUnits: 2000 },
        { accountId: "b", direction: "credit", amountMinorUnits: 1999 },
      ])
    ).toThrow(LedgerImbalanceError);
  });

  it("rejects a single-entry transaction", () => {
    expect(() =>
      assertBalanced([
        { accountId: "a", direction: "debit", amountMinorUnits: 2000 },
      ])
    ).toThrow(LedgerImbalanceError);
  });

  it("rejects a zero or negative amount", () => {
    expect(() =>
      assertBalanced([
        { accountId: "a", direction: "debit", amountMinorUnits: 0 },
        { accountId: "b", direction: "credit", amountMinorUnits: 0 },
      ])
    ).toThrow(LedgerImbalanceError);
  });

  it("rejects a non-integer amount (no floats in money)", () => {
    expect(() =>
      assertBalanced([
        { accountId: "a", direction: "debit", amountMinorUnits: 10.5 },
        { accountId: "b", direction: "credit", amountMinorUnits: 10.5 },
      ])
    ).toThrow(LedgerImbalanceError);
  });
});
