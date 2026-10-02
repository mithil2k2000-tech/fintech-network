import type { PaymentStatus } from "@fintech-network/shared-types";

// The single source of truth for which payment status changes are legal
// (spec §9). Every status update in the payments service goes through
// `assertTransition` — adding a new state later means editing this table,
// not hunting through handlers.
//
// APPROVED means "passed risk evaluation, waiting for the payer to
// confirm". It does not mean money has moved.
const ALLOWED: Record<PaymentStatus, readonly PaymentStatus[]> = {
  CREATED: ["PENDING_RISK"],
  PENDING_RISK: ["APPROVED", "FAILED"],
  APPROVED: ["PROCESSING", "FAILED"],
  PROCESSING: ["COMPLETED", "FAILED"],
  COMPLETED: ["REFUNDED", "DISPUTED"],
  FAILED: [],
  REFUNDED: [],
  DISPUTED: ["REFUNDED", "COMPLETED"],
};

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: PaymentStatus,
    public readonly to: PaymentStatus
  ) {
    super(`Illegal payment transition ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

export function isTerminal(status: PaymentStatus): boolean {
  return ALLOWED[status].length === 0;
}
