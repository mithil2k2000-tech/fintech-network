// Shared contract types used by the API and all three frontends.
// Money is ALWAYS an integer number of minor units (pence) — never a float.
// See spec §10 (Ledger Architecture) and §7 (money arithmetic rule).
export type MinorUnits = number;

export interface Money {
  amountMinorUnits: MinorUnits;
  currency: "GBP";
}

export type UserRole = "consumer" | "merchant" | "admin";

export type PaymentStatus =
  | "CREATED"
  | "PENDING_RISK"
  | "APPROVED"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "REFUNDED"
  | "DISPUTED";

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH";

export type * from "./api.js";
