// Response shapes the consumer app relies on. They mirror what the API
// returns today (services/api: PaymentView, ReceiptView, ActivityItem).
// The end-to-end test exercises every one of these against the real API,
// so drift shows up as a failing test rather than a broken screen.
import type { MinorUnits, PaymentStatus, RiskLevel, UserRole } from "./index.js";

export interface ApiErrorBody {
  code: string;
  message: string;
  requestId?: string;
  details?: Record<string, unknown>;
}

export interface UserDto {
  id: string;
  email: string;
  role: UserRole;
  createdAt: string;
}

export interface AuthResponse {
  user: UserDto;
  token: string;
}

export interface AccountDto {
  id: string;
  currency: "GBP";
  balanceMinorUnits: MinorUnits;
}

export interface PaymentDto {
  id: string;
  direction: "outgoing" | "incoming";
  amountMinorUnits: MinorUnits;
  currency: "GBP";
  purpose: string | null;
  status: PaymentStatus;
  counterparty: { type: "user" | "merchant"; displayName: string | null };
  risk: { level: RiskLevel | null; reasons: string[] };
  failureReason: string | null;
  transactionId: string | null;
  receiptId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReceiptDto {
  id: string;
  receiptNumber: string;
  paymentId: string;
  transactionId: string;
  role: "payer" | "payee";
  from: string;
  to: string;
  amountMinorUnits: MinorUnits;
  currency: "GBP";
  purpose: string | null;
  issuedAt: string;
  paymentStatus: PaymentStatus;
  passport: { reference: string; available: boolean };
}

export interface ActivityItemDto {
  id: string;
  transactionId: string;
  kind: string;
  direction: "in" | "out";
  amountMinorUnits: MinorUnits;
  balanceAfterMinorUnits: MinorUnits;
  occurredAt: string;
  title: string;
  purpose: string | null;
  paymentId: string | null;
  receiptId: string | null;
}

export interface ActivityPageDto {
  items: ActivityItemDto[];
  nextCursor: string | null;
}

export type PaymentRequestStatus =
  | "OPEN"
  | "PAID"
  | "CANCELLED"
  | "DECLINED"
  | "EXPIRED";

/** How a request reaches its payer: a QR anyone can scan, or a named person. */
export type PaymentRequestChannel = "qr" | "direct";

export interface OwnPaymentRequestDto {
  id: string;
  code: string;
  token: string;
  channel: PaymentRequestChannel;
  amountMinorUnits: MinorUnits;
  currency: "GBP";
  purpose: string | null;
  status: PaymentRequestStatus;
  expiresAt: string;
  createdAt: string;
  sentTo: { displayName: string } | null;
  paidAt: string | null;
  paidBy: { displayName: string } | null;
  declinedAt: string | null;
  paymentId: string | null;
  receiptId: string | null;
  /** Set when this request is one person's share of a split bill. */
  billSplitId: string | null;
  /** The shop this was taken for, when it wasn't for the person themselves. */
  takenFor: { merchantId: string; displayName: string } | null;
}

/** A request someone else sent to you. */
export interface IncomingPaymentRequestDto {
  id: string;
  code: string;
  amountMinorUnits: MinorUnits;
  currency: "GBP";
  purpose: string | null;
  status: PaymentRequestStatus;
  expiresAt: string;
  createdAt: string;
  requester: { displayName: string };
  paymentId: string | null;
  receiptId: string | null;
  billSplitId: string | null;
}

export type BillSplitStatus = "OPEN" | "SETTLED" | "CANCELLED";

/** One person's part of a split bill. */
export interface SplitShareDto {
  paymentRequestId: string;
  person: { displayName: string };
  amountMinorUnits: MinorUnits;
  status: PaymentRequestStatus;
  paidAt: string | null;
  receiptId: string | null;
}

export interface BillSplitDto {
  id: string;
  totalMinorUnits: MinorUnits;
  currency: "GBP";
  purpose: string | null;
  method: "even" | "custom";
  status: BillSplitStatus;
  createdAt: string;
  organiser: { displayName: string; isYou: boolean };
  organiserShareMinorUnits: MinorUnits;
  shares: SplitShareDto[];
  collectedMinorUnits: MinorUnits;
  outstandingMinorUnits: MinorUnits;
}

export interface PublicPaymentRequestDto {
  id: string;
  code: string;
  amountMinorUnits: MinorUnits;
  currency: "GBP";
  purpose: string | null;
  status: PaymentRequestStatus;
  expiresAt: string;
  channel: PaymentRequestChannel;
  requester: {
    type: "user" | "merchant";
    displayName: string;
    /**
     * How far the network vouches for who this is. Both levels mean
     * "has an account here" and nothing more: no business checks are
     * run in this prototype, so the app must not imply otherwise.
     */
    verification: "registered_user" | "registered_merchant";
  };
  isOwn: boolean;
  isForYou: boolean;
}

export type MerchantRole = "owner" | "staff";

export interface MerchantDto {
  id: string;
  legalName: string;
  tradingName: string;
  contactEmail: string;
  status: "active" | "suspended";
  /** Always "unverified" in this prototype — nothing is checked. */
  verification: "unverified" | "verified";
  createdAt: string;
  yourRole: MerchantRole;
}

export interface MerchantMemberDto {
  userId: string;
  displayName: string;
  role: MerchantRole;
  isYou: boolean;
  addedAt: string;
}

/** One payment's cashback, as the person who earned it sees it. */
export interface CashbackGrantDto {
  id: string;
  paymentId: string;
  amountMinorUnits: MinorUnits;
  spendMinorUnits: MinorUnits;
  ratePercent: number;
  rule: string;
  earnedAt: string;
}

export interface CashbackSummaryDto {
  totalEarnedMinorUnits: MinorUnits;
  currency: "GBP";
  grants: CashbackGrantDto[];
  /** What's on offer now — the app shows the server's rate, never its own. */
  offer: {
    ratePercent: number;
    minimumSpendMinorUnits: MinorUnits;
    maximumAwardMinorUnits: MinorUnits;
    appliesTo: "merchant_payments";
  };
}

export interface TreeStageDto {
  level: number;
  name: string;
  fromMinorUnits: MinorUnits;
}

/** A picture of the cashback earned — derived, never a stored score. */
export interface RewardsTreeDto {
  stage: TreeStageDto;
  nextStage: TreeStageDto | null;
  totalEarnedMinorUnits: MinorUnits;
  progressPercent: number;
  toNextStageMinorUnits: MinorUnits;
  leaves: number;
  rewardedPayments: number;
  currency: "GBP";
  /** Comes from the server so every client says the same thing. */
  disclaimer: string;
}

// --- Assistant (spec §13) -------------------------------------------------

/**
 * A value the assistant quoted. `display` is what appears in the answer
 * text; `minorUnits` is the integer it was rendered from, so a client can
 * check the sentence against the number instead of trusting it.
 */
export interface AssistantFigureDto {
  name: string;
  display: string;
  minorUnits?: MinorUnits;
}

/** A screen the person can go to. Nothing happens on arrival. */
export interface AssistantSuggestionDto {
  label: string;
  path: string;
}

export interface AssistantAnswerDto {
  answer: string;
  intent: string;
  figures: AssistantFigureDto[];
  suggestions: AssistantSuggestionDto[];
  disclaimer: string;
  /** Which model wrote the words, and which rule set classified. */
  provenance: { model: string; rules: string };
}

export interface AssistantCapabilitiesDto {
  can: string[];
  cannot: string[];
  examples: string[];
  disclaimer: string;
}

// --- Operations view (spec §24, Phase 15) ---------------------------------

/**
 * What the admin app shows. Every figure is read live from the tables
 * that own it — nothing here is a cached or in-process counter, because
 * a counter that resets when a process restarts is a lie about a ledger.
 */
export interface OperationsOverviewDto {
  windowHours: number;
  generatedAt: string;
  payments: {
    byStatus: { status: PaymentStatus; count: number; totalMinorUnits: MinorUnits }[];
    failuresByReason: { reason: string; count: number }[];
  };
  risk: {
    byLevel: { level: RiskLevel; count: number }[];
    firedRules: { rule: string; count: number }[];
  };
  rewards: {
    paidOutMinorUnits: MinorUnits;
    /** Negative, and getting more so: the reserve is funded by nothing. */
    reserveBalanceMinorUnits: MinorUnits;
  };
  ledger: {
    entries: number;
    unbalancedTransactions: number;
    negativeOwnerAccounts: number;
    balanced: boolean;
  };
  security: { eventType: string; count: number }[];
}
