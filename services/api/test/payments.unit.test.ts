import { describe, it, expect } from "vitest";
import {
  assertTransition,
  canTransition,
  isTerminal,
  InvalidTransitionError,
} from "../src/modules/payments/stateMachine.js";
import { SimulatedPaymentProvider } from "../src/modules/payments/provider.js";
import { PlaceholderRiskEvaluator } from "../src/modules/payments/risk.js";
import { netChangeFor } from "../src/modules/ledger/index.js";

describe("payment state machine", () => {
  it("allows the happy path CREATED -> PENDING_RISK -> APPROVED -> PROCESSING -> COMPLETED", () => {
    expect(() => {
      assertTransition("CREATED", "PENDING_RISK");
      assertTransition("PENDING_RISK", "APPROVED");
      assertTransition("APPROVED", "PROCESSING");
      assertTransition("PROCESSING", "COMPLETED");
    }).not.toThrow();
  });

  it("refuses to skip risk evaluation", () => {
    expect(() => assertTransition("CREATED", "APPROVED")).toThrow(InvalidTransitionError);
    expect(() => assertTransition("CREATED", "COMPLETED")).toThrow(InvalidTransitionError);
  });

  it("refuses to complete a payment the payer never confirmed", () => {
    expect(canTransition("APPROVED", "COMPLETED")).toBe(false);
    expect(canTransition("PENDING_RISK", "PROCESSING")).toBe(false);
  });

  it("never lets a failed payment come back", () => {
    expect(isTerminal("FAILED")).toBe(true);
    expect(canTransition("FAILED", "PROCESSING")).toBe(false);
    expect(canTransition("FAILED", "COMPLETED")).toBe(false);
  });

  it("only allows refunds and disputes after completion", () => {
    expect(canTransition("COMPLETED", "REFUNDED")).toBe(true);
    expect(canTransition("COMPLETED", "DISPUTED")).toBe(true);
    expect(canTransition("APPROVED", "REFUNDED")).toBe(false);
    expect(isTerminal("REFUNDED")).toBe(true);
  });
});

describe("SimulatedPaymentProvider", () => {
  it("accepts by default and returns a simulated reference", async () => {
    const provider = new SimulatedPaymentProvider();
    const result = await provider.createPayment({
      paymentId: "p1",
      amountMinorUnits: 500,
      currency: "GBP",
    });
    expect(result.outcome).toBe("succeeded");
    expect(result.providerReference).toMatch(/^sim_/);
    const status = await provider.getPayment(result.providerReference!);
    expect(status.state).toBe("succeeded");
  });

  it("can be told to decline, for demos and tests", async () => {
    const provider = new SimulatedPaymentProvider({
      declineWhen: (r) => (r.amountMinorUnits > 100 ? "Too much" : null),
    });
    const result = await provider.createPayment({
      paymentId: "p2",
      amountMinorUnits: 101,
      currency: "GBP",
    });
    expect(result).toMatchObject({ outcome: "failed", reason: "Too much" });
  });

  it("records cancellation of an earlier authorisation", async () => {
    const provider = new SimulatedPaymentProvider();
    const result = await provider.createPayment({
      paymentId: "p3",
      amountMinorUnits: 1,
      currency: "GBP",
    });
    await provider.cancelPayment(result.providerReference!);
    expect((await provider.getPayment(result.providerReference!)).state).toBe("cancelled");
  });
});

describe("PlaceholderRiskEvaluator", () => {
  it("is openly a placeholder, not a real risk decision", async () => {
    const decision = await new PlaceholderRiskEvaluator().evaluate({
      payerUserId: "a",
      payeeOwnerType: "user",
      payeeOwnerId: "b",
      amountMinorUnits: 100,
    });
    expect(decision.level).toBe("LOW");
    expect(decision.evaluator).toBe("placeholder-v0");
    expect(decision.reasons.join(" ")).toMatch(/not yet enabled/i);
  });
});

describe("netChangeFor", () => {
  it("computes an account's net change across entries", () => {
    const entries = [
      { accountId: "a", direction: "debit" as const, amountMinorUnits: 700 },
      { accountId: "b", direction: "credit" as const, amountMinorUnits: 700 },
    ];
    expect(netChangeFor(entries, "a")).toBe(-700);
    expect(netChangeFor(entries, "b")).toBe(700);
    expect(netChangeFor(entries, "c")).toBe(0);
  });
});
