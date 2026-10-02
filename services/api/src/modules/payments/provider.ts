import { randomUUID } from "node:crypto";
import type { MinorUnits } from "@fintech-network/shared-types";

// The boundary between our payment flow and whatever actually moves money
// (spec §9, §29 of the master brief). v0.1 only has the simulated
// implementation below. An Open Banking or regulated-PSP provider later
// implements the same interface, and the payments service doesn't change.

export interface ProviderPaymentRequest {
  paymentId: string;
  amountMinorUnits: MinorUnits;
  currency: "GBP";
}

export type ProviderPaymentResult =
  | { outcome: "succeeded"; providerReference: string }
  | { outcome: "failed"; providerReference: string | null; reason: string };

export interface ProviderPaymentStatus {
  providerReference: string;
  state: "succeeded" | "failed" | "cancelled" | "refunded" | "unknown";
}

export interface PaymentProvider {
  /** Stable identifier stored on each payment, e.g. "simulated". */
  readonly name: string;
  createPayment(request: ProviderPaymentRequest): Promise<ProviderPaymentResult>;
  getPayment(providerReference: string): Promise<ProviderPaymentStatus>;
  cancelPayment(providerReference: string): Promise<void>;
  refundPayment(
    providerReference: string,
    amountMinorUnits: MinorUnits
  ): Promise<{ providerReference: string }>;
}

export interface SimulatedPaymentProviderOptions {
  /**
   * Lets tests (and demos) force a provider-side decline without touching
   * the payments service. Returns a reason to decline, or null to accept.
   */
  declineWhen?: (request: ProviderPaymentRequest) => string | null;
}

/**
 * SIMULATED. Moves no real money and talks to no bank. It only records
 * what it was asked to do, in memory, so the rest of the flow can be
 * exercised end to end. The ledger remains the record of simulated
 * balances — this class never touches it.
 */
export class SimulatedPaymentProvider implements PaymentProvider {
  readonly name = "simulated";
  private readonly states = new Map<string, ProviderPaymentStatus["state"]>();

  constructor(private readonly options: SimulatedPaymentProviderOptions = {}) {}

  async createPayment(request: ProviderPaymentRequest): Promise<ProviderPaymentResult> {
    const providerReference = `sim_${randomUUID()}`;
    const declineReason = this.options.declineWhen?.(request) ?? null;
    if (declineReason) {
      this.states.set(providerReference, "failed");
      return { outcome: "failed", providerReference, reason: declineReason };
    }
    this.states.set(providerReference, "succeeded");
    return { outcome: "succeeded", providerReference };
  }

  async getPayment(providerReference: string): Promise<ProviderPaymentStatus> {
    return {
      providerReference,
      state: this.states.get(providerReference) ?? "unknown",
    };
  }

  async cancelPayment(providerReference: string): Promise<void> {
    if (this.states.has(providerReference)) {
      this.states.set(providerReference, "cancelled");
    }
  }

  async refundPayment(
    providerReference: string,
    _amountMinorUnits: MinorUnits
  ): Promise<{ providerReference: string }> {
    this.states.set(providerReference, "refunded");
    return { providerReference: `sim_refund_${randomUUID()}` };
  }
}
