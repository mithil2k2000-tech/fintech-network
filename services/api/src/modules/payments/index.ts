// Domain module: payments
// Orchestrates a simulated payment through the spec §9 flow:
//   create -> risk evaluation -> payer confirms -> provider -> ledger
//
// The module depends only on interfaces it's handed (PaymentProvider,
// RiskEvaluator) and on other modules' exported functions (ledger, users,
// receipts, audit), never on their tables. That's what lets Phase 12 swap in the
// real risk engine, or a later phase add a regulated provider, without
// touching this file's flow.
import type { Pool, PoolClient } from "pg";
import type {
  MinorUnits,
  PaymentStatus,
  RiskLevel,
} from "@fintech-network/shared-types";
import type { Queryable } from "../../db.js";
import { recordAuditEvent } from "../audit/index.js";
import { findUserByEmail, findUserById } from "../users/index.js";
import { countRecentRecipientLookupFailures } from "../identity/attempts.js";
import { findMerchantById } from "../merchants/index.js";
import {
  getOrCreateAccountForOwner,
  postTransactionWithClient,
  InsufficientFundsError,
} from "../ledger/index.js";
import {
  issueReceiptWithClient,
  findReceiptIdsByPaymentIds,
} from "../receipts/index.js";
import { assertTransition } from "./stateMachine.js";
import type { PaymentProvider } from "./provider.js";
import type { RiskEvaluator } from "./risk.js";

export const MODULE_NAME = "payments" as const;

export { SimulatedPaymentProvider } from "./provider.js";
export type { PaymentProvider } from "./provider.js";
export { PlaceholderRiskEvaluator } from "./risk.js";
export type { RiskEvaluator, RiskDecision, RiskInput } from "./risk.js";

/** What a completion hook is told about the payment that just completed. */
export interface CompletedPaymentContext {
  paymentId: string;
  payerUserId: string;
  payeeOwnerType: PayeeType;
  payeeOwnerId: string;
  amountMinorUnits: MinorUnits;
  transactionId: string;
  paymentRequestId: string | null;
}

/**
 * Runs inside the same database transaction that completes a payment,
 * after the ledger posting and receipt. Other modules use this to react
 * to a payment (mark a QR request paid; later, grant cashback) without
 * the payments module knowing about them. Throw PaymentBlockedError to
 * stop the payment: everything rolls back and it ends FAILED with that
 * code. Any other error also rolls back and is treated as unexpected.
 */
export type PaymentCompletionHook = (
  client: PoolClient,
  payment: CompletedPaymentContext
) => Promise<void>;

export class PaymentBlockedError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
    this.name = "PaymentBlockedError";
  }
}

export interface PaymentsDeps {
  pool: Pool;
  provider: PaymentProvider;
  riskEvaluator: RiskEvaluator;
  completionHooks?: PaymentCompletionHook[];
  /** Per-route limit for money-moving writes; routes read it from here. */
  writeRateLimitPerMinute?: number;
  /**
   * How long a started payment may sit on the review screen before it
   * has to be started again (Phase 14). The risk decision it carries was
   * made against the payer's balance and history at the time; hours
   * later that decision is stale, and a stale approval is not an
   * approval.
   */
  approvalTtlMinutes?: number;
  /**
   * How many "no account with that email" answers one payer may get in
   * an hour before this stops answering (Phase 14).
   */
  recipientLookupFailureLimit?: number;
}

/** An expected, user-facing failure. Routes turn this into an HTTP error. */
export class PaymentError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

type PayeeType = "user" | "merchant";

interface PaymentRow {
  id: string;
  payer_user_id: string;
  payee_owner_type: PayeeType;
  payee_owner_id: string;
  amount_minor_units: string; // bigint arrives as a string from pg
  currency: string;
  purpose: string | null;
  status: PaymentStatus;
  risk_level: RiskLevel | null;
  risk_reasons: string[];
  provider_name: string | null;
  provider_reference: string | null;
  transaction_id: string | null;
  failure_reason: string | null;
  payment_request_id: string | null;
  created_at: Date;
  updated_at: Date;
  payer_email: string;
  payee_name: string | null;
}

export interface PaymentView {
  id: string;
  direction: "outgoing" | "incoming";
  amountMinorUnits: MinorUnits;
  currency: "GBP";
  purpose: string | null;
  status: PaymentStatus;
  counterparty: { type: PayeeType; displayName: string | null };
  risk: { level: RiskLevel | null; reasons: string[] };
  failureReason: string | null;
  transactionId: string | null;
  /** Set once the payment has completed and its receipt was issued. */
  receiptId: string | null;
  /** Set when the payment was made from a payment request (e.g. a QR code). */
  paymentRequestId: string | null;
  createdAt: string;
  updatedAt: string;
}

// A payee only sees a payment once money has actually moved. Drafts,
// declined and cancelled attempts stay private to the payer.
const PAYEE_VISIBLE_STATUSES: readonly PaymentStatus[] = [
  "COMPLETED",
  "REFUNDED",
  "DISPUTED",
];

// Read-only joins for display names. The payee is a person or a shop,
// so both are joined and only one can match. (Writes to those tables
// still go through the users and merchants modules — spec §17.)
const SELECT_PAYMENT = `
  select p.*, pu.email as payer_email,
         coalesce(ru.email, rm.trading_name) as payee_name
  from payments p
  join users pu on pu.id = p.payer_user_id
  left join users ru on p.payee_owner_type = 'user' and ru.id = p.payee_owner_id
  left join merchants rm on p.payee_owner_type = 'merchant' and rm.id = p.payee_owner_id
`;

function toView(
  row: PaymentRow,
  viewerUserId: string,
  receiptId: string | null = null
): PaymentView {
  const outgoing = row.payer_user_id === viewerUserId;
  return {
    id: row.id,
    direction: outgoing ? "outgoing" : "incoming",
    amountMinorUnits: Number(row.amount_minor_units),
    currency: row.currency as "GBP",
    purpose: row.purpose,
    status: row.status,
    counterparty: outgoing
      ? { type: row.payee_owner_type, displayName: row.payee_name }
      : { type: "user", displayName: row.payer_email },
    risk: { level: row.risk_level, reasons: row.risk_reasons },
    failureReason: row.failure_reason,
    transactionId: row.transaction_id,
    receiptId,
    paymentRequestId: row.payment_request_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function toViews(
  q: Queryable,
  rows: PaymentRow[],
  viewerUserId: string
): Promise<PaymentView[]> {
  const receipts = await findReceiptIdsByPaymentIds(
    q,
    rows.filter((r) => r.transaction_id !== null).map((r) => r.id)
  );
  return rows.map((row) => toView(row, viewerUserId, receipts.get(row.id) ?? null));
}

async function toSingleView(
  q: Queryable,
  row: PaymentRow,
  viewerUserId: string
): Promise<PaymentView> {
  const [view] = await toViews(q, [row], viewerUserId);
  return view;
}

function canView(row: PaymentRow, userId: string): boolean {
  if (row.payer_user_id === userId) return true;
  return (
    row.payee_owner_type === "user" &&
    row.payee_owner_id === userId &&
    PAYEE_VISIBLE_STATUSES.includes(row.status)
  );
}

async function loadPayment(q: Queryable, id: string): Promise<PaymentRow | null> {
  const result = await q.query<PaymentRow>(`${SELECT_PAYMENT} where p.id = $1`, [id]);
  return result.rows[0] ?? null;
}

async function mustReload(q: Queryable, id: string): Promise<PaymentRow> {
  const row = await loadPayment(q, id);
  if (!row) throw new Error(`Payment ${id} disappeared`);
  return row;
}

interface TransitionFields {
  riskLevel?: RiskLevel;
  riskReasons?: string[];
  /** Which evaluator decided, so the payment says who judged it. */
  riskEvaluator?: string;
  providerName?: string;
  providerReference?: string | null;
  transactionId?: string;
  failureReason?: string;
}

/**
 * Compare-and-set status change. Returns false if the payment wasn't in
 * `from` any more (someone else moved it first) — callers decide what
 * that means. The legality of from -> to is checked by the state machine.
 */
async function transitionPayment(
  q: Queryable,
  id: string,
  from: PaymentStatus,
  to: PaymentStatus,
  fields: TransitionFields = {}
): Promise<boolean> {
  assertTransition(from, to);
  const result = await q.query(
    `update payments set
       status = $3,
       updated_at = now(),
       risk_level = coalesce($4, risk_level),
       risk_reasons = coalesce($5::jsonb, risk_reasons),
       risk_evaluator = coalesce($10, risk_evaluator),
       provider_name = coalesce($6, provider_name),
       provider_reference = coalesce($7, provider_reference),
       transaction_id = coalesce($8::uuid, transaction_id),
       failure_reason = coalesce($9, failure_reason)
     where id = $1 and status = $2
     returning id`,
    [
      id,
      from,
      to,
      fields.riskLevel ?? null,
      fields.riskReasons ? JSON.stringify(fields.riskReasons) : null,
      fields.providerName ?? null,
      fields.providerReference ?? null,
      fields.transactionId ?? null,
      fields.failureReason ?? null,
      fields.riskEvaluator ?? null,
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

async function failPayment(
  q: Queryable,
  id: string,
  from: PaymentStatus,
  actorUserId: string,
  reason: string,
  providerReference: string | null = null
): Promise<void> {
  const moved = await transitionPayment(q, id, from, "FAILED", {
    failureReason: reason,
    providerReference,
  });
  if (moved) {
    await recordAuditEvent(q, {
      eventType: "PAYMENT_FAILED",
      actorUserId,
      metadata: { paymentId: id, reason },
    });
  }
}

function notFound(): PaymentError {
  // Same error whether the payment doesn't exist or belongs to someone
  // else, so ids can't be probed (IDOR protection).
  return new PaymentError("PAYMENT_NOT_FOUND", 404, "Payment not found");
}

export type PaymentPayee =
  /** Someone the payer typed in. */
  | { recipientEmail: string }
  /** A payee another module already identified (e.g. from a QR request). */
  | { payee: { ownerType: PayeeType; ownerId: string } };

export type CreatePaymentInput = PaymentPayee & {
  payerUserId: string;
  amountMinorUnits: MinorUnits;
  purpose?: string | null;
  /** Links the payment to the request it pays. */
  paymentRequestId?: string | null;
};

async function resolvePayee(
  pool: Pool,
  input: PaymentPayee
): Promise<{ ownerType: PayeeType; ownerId: string } | null> {
  if ("recipientEmail" in input) {
    const user = await findUserByEmail(pool, input.recipientEmail);
    return user ? { ownerType: "user", ownerId: user.id } : null;
  }
  if (input.payee.ownerType === "user") {
    const user = await findUserById(pool, input.payee.ownerId);
    return user ? { ownerType: "user", ownerId: user.id } : null;
  }
  // A shop. It has to exist and be open for business; a suspended shop
  // can't be paid even through a QR code printed earlier.
  const merchant = await findMerchantById(pool, input.payee.ownerId);
  if (!merchant || merchant.status !== "active") return null;
  return { ownerType: "merchant", ownerId: merchant.id };
}

/**
 * Step 1 of 2: records the payment and runs risk evaluation. Nothing moves
 * yet — the returned view is what the payer reviews before confirming.
 */
export async function createPayment(
  deps: PaymentsDeps,
  input: CreatePaymentInput
): Promise<PaymentView> {
  const { pool, riskEvaluator } = deps;

  const payee = await resolvePayee(pool, input);
  if (!payee) {
    // Someone has to be told when they've typed an address wrong, so
    // this answer can't be made opaque without breaking the thing it
    // protects. What it can do is stop being free: a payer who keeps
    // missing is told nothing more, and both the misses and the refusal
    // are on file (Phase 14, spec §26).
    if ("recipientEmail" in input) {
      const limit = deps.recipientLookupFailureLimit ?? 10;
      const misses = await countRecentRecipientLookupFailures(pool, input.payerUserId);
      if (misses >= limit) {
        await recordAuditEvent(pool, {
          eventType: "RECIPIENT_LOOKUP_THROTTLED",
          actorUserId: input.payerUserId,
          metadata: { misses },
        });
        throw new PaymentError(
          "TOO_MANY_LOOKUPS",
          429,
          "Too many payments to addresses that don't exist. Please try again later."
        );
      }
      await recordAuditEvent(pool, {
        eventType: "RECIPIENT_LOOKUP_FAILED",
        actorUserId: input.payerUserId,
        metadata: {},
      });
    }
    throw new PaymentError(
      "RECIPIENT_NOT_FOUND",
      404,
      "No account found for that recipient"
    );
  }
  if (payee.ownerType === "user" && payee.ownerId === input.payerUserId) {
    throw new PaymentError("SELF_PAYMENT", 422, "You can't pay yourself");
  }

  const inserted = await pool.query<{ id: string }>(
    `insert into payments
       (payer_user_id, payee_owner_type, payee_owner_id, amount_minor_units, purpose, status,
        payment_request_id)
     values ($1, $2, $3, $4, $5, 'CREATED', $6)
     returning id`,
    [
      input.payerUserId,
      payee.ownerType,
      payee.ownerId,
      input.amountMinorUnits,
      input.purpose ?? null,
      input.paymentRequestId ?? null,
    ]
  );
  const paymentId = inserted.rows[0].id;

  await recordAuditEvent(pool, {
    eventType: "PAYMENT_CREATED",
    actorUserId: input.payerUserId,
    metadata: {
      paymentId,
      amountMinorUnits: input.amountMinorUnits,
      paymentRequestId: input.paymentRequestId ?? null,
    },
  });

  await transitionPayment(pool, paymentId, "CREATED", "PENDING_RISK");

  let decision;
  try {
    decision = await riskEvaluator.evaluate({
      paymentId,
      payerUserId: input.payerUserId,
      payeeOwnerType: payee.ownerType,
      payeeOwnerId: payee.ownerId,
      amountMinorUnits: input.amountMinorUnits,
    });
  } catch (err) {
    // Never leave a payment stranded in PENDING_RISK.
    await failPayment(pool, paymentId, "PENDING_RISK", input.payerUserId, "RISK_EVALUATION_ERROR");
    throw err;
  }

  await recordAuditEvent(pool, {
    eventType: "RISK_EVALUATED",
    actorUserId: input.payerUserId,
    metadata: {
      paymentId,
      level: decision.level,
      reasons: decision.reasons,
      evaluator: decision.evaluator,
    },
  });

  await transitionPayment(pool, paymentId, "PENDING_RISK", "APPROVED", {
    riskLevel: decision.level,
    riskReasons: decision.reasons,
    riskEvaluator: decision.evaluator,
  });

  await recordAuditEvent(pool, {
    eventType: "PAYMENT_APPROVED",
    actorUserId: input.payerUserId,
    metadata: { paymentId, riskLevel: decision.level },
  });

  return toSingleView(pool, await mustReload(pool, paymentId), input.payerUserId);
}

export interface ConfirmPaymentInput {
  payerUserId: string;
  paymentId: string;
  /** Required when the payment was rated HIGH risk (spec §12). */
  acknowledgeRisk?: boolean;
}

/**
 * Step 2 of 2: the payer confirms. Calls the provider, then posts the
 * ledger transaction and marks the payment COMPLETED in ONE database
 * transaction, so a payment can never be COMPLETED without its ledger
 * entries (or vice versa). Safe to call twice: a completed payment is
 * returned as-is and never posted again.
 */
export async function confirmPayment(
  deps: PaymentsDeps,
  input: ConfirmPaymentInput
): Promise<PaymentView> {
  const { pool, provider } = deps;
  const { payerUserId, paymentId } = input;

  const row = await loadPayment(pool, paymentId);
  if (!row || row.payer_user_id !== payerUserId) throw notFound();

  if (row.status === "COMPLETED") return toSingleView(pool, row, payerUserId);
  if (row.status === "PROCESSING") {
    throw new PaymentError("PAYMENT_IN_PROGRESS", 409, "This payment is already being processed");
  }
  if (row.status !== "APPROVED") {
    throw new PaymentError(
      "INVALID_PAYMENT_STATE",
      409,
      `This payment can't be confirmed (status: ${row.status})`
    );
  }
  // An approval goes stale. The risk decision on this payment was made
  // against a balance and a history that have moved on since, so past
  // the window the payment is failed rather than quietly confirmed —
  // and the payer starts it again, against today's facts.
  const ttlMinutes = deps.approvalTtlMinutes ?? 15;
  const ageMinutes = (Date.now() - row.created_at.getTime()) / 60_000;
  if (ageMinutes > ttlMinutes) {
    await failPayment(pool, paymentId, "APPROVED", payerUserId, "APPROVAL_EXPIRED");
    await recordAuditEvent(pool, {
      eventType: "PAYMENT_APPROVAL_EXPIRED",
      actorUserId: payerUserId,
      metadata: { paymentId, ttlMinutes },
    });
    throw new PaymentError(
      "PAYMENT_EXPIRED",
      409,
      "This payment sat too long before being confirmed. Nothing has been sent — please start it again."
    );
  }

  if (row.risk_level === "HIGH" && input.acknowledgeRisk !== true) {
    throw new PaymentError(
      "RISK_ACKNOWLEDGEMENT_REQUIRED",
      409,
      "This payment was flagged as high risk. Review the reasons and confirm again to continue.",
      { riskLevel: row.risk_level, reasons: row.risk_reasons }
    );
  }

  // Claim the payment. Only one concurrent confirm can win this.
  const claimed = await transitionPayment(pool, paymentId, "APPROVED", "PROCESSING", {
    providerName: provider.name,
  });
  if (!claimed) {
    const current = await mustReload(pool, paymentId);
    if (current.status === "COMPLETED") return toSingleView(pool, current, payerUserId);
    throw new PaymentError("PAYMENT_IN_PROGRESS", 409, "This payment is already being processed");
  }

  const amountMinorUnits = Number(row.amount_minor_units);

  let providerResult;
  try {
    providerResult = await provider.createPayment({
      paymentId,
      amountMinorUnits,
      currency: "GBP",
    });
  } catch (err) {
    await failPayment(pool, paymentId, "PROCESSING", payerUserId, "PROVIDER_ERROR");
    throw err;
  }

  if (providerResult.outcome === "failed") {
    await failPayment(
      pool,
      paymentId,
      "PROCESSING",
      payerUserId,
      `PROVIDER_DECLINED: ${providerResult.reason}`,
      providerResult.providerReference
    );
    return toSingleView(pool, await mustReload(pool, paymentId), payerUserId);
  }

  const providerReference = providerResult.providerReference;
  const payerAccount = await getOrCreateAccountForOwner(pool, "user", payerUserId);
  const payeeAccount = await getOrCreateAccountForOwner(
    pool,
    row.payee_owner_type,
    row.payee_owner_id
  );

  const client = await pool.connect();
  let failureReason: string | null = null;
  try {
    await client.query("BEGIN");

    const posted = await postTransactionWithClient(client, {
      description: `Payment ${paymentId}`,
      kind: "payment",
      entries: [
        { accountId: payerAccount.id, direction: "debit", amountMinorUnits },
        { accountId: payeeAccount.id, direction: "credit", amountMinorUnits },
      ],
      nonNegativeAccountIds: [payerAccount.id],
    });

    const completed = await transitionPayment(client, paymentId, "PROCESSING", "COMPLETED", {
      transactionId: posted.transactionId,
      providerReference,
    });
    if (!completed) {
      throw new Error(`Payment ${paymentId} left PROCESSING unexpectedly`);
    }

    const receipt = await issueReceiptWithClient(client, {
      paymentId,
      transactionId: posted.transactionId,
      payerUserId,
      payeeOwnerType: row.payee_owner_type,
      payeeOwnerId: row.payee_owner_id,
      payerDisplayName: row.payer_email,
      payeeDisplayName: row.payee_name ?? "Unknown recipient",
      amountMinorUnits,
      purpose: row.purpose,
    });

    await recordAuditEvent(client, {
      eventType: "LEDGER_POSTED",
      actorUserId: payerUserId,
      metadata: { paymentId, transactionId: posted.transactionId },
    });
    await recordAuditEvent(client, {
      eventType: "PAYMENT_COMPLETED",
      actorUserId: payerUserId,
      metadata: {
        paymentId,
        transactionId: posted.transactionId,
        amountMinorUnits,
      },
    });

    await recordAuditEvent(client, {
      eventType: "RECEIPT_CREATED",
      actorUserId: payerUserId,
      metadata: {
        paymentId,
        receiptId: receipt.id,
        receiptNumber: receipt.receiptNumber,
      },
    });

    const context: CompletedPaymentContext = {
      paymentId,
      payerUserId,
      payeeOwnerType: row.payee_owner_type,
      payeeOwnerId: row.payee_owner_id,
      amountMinorUnits,
      transactionId: posted.transactionId,
      paymentRequestId: row.payment_request_id,
    };
    for (const hook of deps.completionHooks ?? []) {
      await hook(client, context);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    const expected = err instanceof InsufficientFundsError || err instanceof PaymentBlockedError;
    failureReason =
      err instanceof InsufficientFundsError
        ? "INSUFFICIENT_FUNDS"
        : err instanceof PaymentBlockedError
          ? err.code
          : "PROCESSING_ERROR";
    // The provider already said yes; void that so it matches our books.
    await provider.cancelPayment(providerReference).catch(() => undefined);
    await failPayment(pool, paymentId, "PROCESSING", payerUserId, failureReason, providerReference);
    if (!expected) throw err;
  } finally {
    client.release();
  }

  return toSingleView(pool, await mustReload(pool, paymentId), payerUserId);
}

/** Payer backs out after reviewing. Only possible before confirming. */
export async function cancelPayment(
  deps: PaymentsDeps,
  input: { payerUserId: string; paymentId: string }
): Promise<PaymentView> {
  const { pool } = deps;
  const row = await loadPayment(pool, input.paymentId);
  if (!row || row.payer_user_id !== input.payerUserId) throw notFound();

  const moved =
    row.status === "APPROVED" &&
    (await transitionPayment(pool, input.paymentId, "APPROVED", "FAILED", {
      failureReason: "CANCELLED_BY_PAYER",
    }));
  if (!moved) {
    throw new PaymentError(
      "INVALID_PAYMENT_STATE",
      409,
      "Only a payment that hasn't been confirmed yet can be cancelled"
    );
  }

  await recordAuditEvent(pool, {
    eventType: "PAYMENT_CANCELLED",
    actorUserId: input.payerUserId,
    metadata: { paymentId: input.paymentId },
  });

  return toSingleView(pool, await mustReload(pool, input.paymentId), input.payerUserId);
}

export async function getPaymentForUser(
  pool: Pool,
  userId: string,
  paymentId: string
): Promise<PaymentView> {
  const row = await loadPayment(pool, paymentId);
  if (!row || !canView(row, userId)) throw notFound();
  return toSingleView(pool, row, userId);
}

export async function listPaymentsForUser(
  pool: Pool,
  userId: string,
  limit = 50
): Promise<PaymentView[]> {
  const result = await pool.query<PaymentRow>(
    `${SELECT_PAYMENT}
     where p.payer_user_id = $1
        or (p.payee_owner_type = 'user' and p.payee_owner_id = $1 and p.status = any($2::text[]))
     order by p.created_at desc
     limit $3`,
    [userId, PAYEE_VISIBLE_STATUSES, limit]
  );
  return toViews(pool, result.rows, userId);
}

/**
 * For the activity feed: the payments behind a set of ledger
 * transactions, keyed by transaction id, limited to what `userId` is
 * allowed to see.
 */
/**
 * What the risk engine needs to know about a payer's history. Read
 * here because payments owns this table; the risk module decides what
 * any of it means.
 *
 * "In the last hour" counts payments the payer started, not only ones
 * that completed — someone making five attempts in ten minutes is the
 * signal, whether or not they all went through.
 */
export async function getPayerHistory(
  q: Queryable,
  payerUserId: string,
  payee: { ownerType: PayeeType; ownerId: string }
): Promise<{
  previousPaymentsToPayee: number;
  largestPreviousPaymentMinorUnits: MinorUnits;
  paymentsInLastHour: number;
  spentInLastHourMinorUnits: MinorUnits;
}> {
  const result = await q.query<{
    to_payee: string;
    largest: string;
    last_hour: string;
    last_hour_spend: string;
  }>(
    `select
       count(*) filter (
         where status = 'COMPLETED'
           and payee_owner_type = $2 and payee_owner_id = $3
       )::text as to_payee,
       coalesce(max(amount_minor_units) filter (where status = 'COMPLETED'), 0)::text as largest,
       count(*) filter (where created_at > now() - interval '1 hour')::text as last_hour,
       coalesce(sum(amount_minor_units) filter (
         where created_at > now() - interval '1 hour' and status = 'COMPLETED'
       ), 0)::text as last_hour_spend
     from payments
     where payer_user_id = $1`,
    [payerUserId, payee.ownerType, payee.ownerId]
  );
  const row = result.rows[0];
  return {
    previousPaymentsToPayee: Number(row.to_payee),
    largestPreviousPaymentMinorUnits: Number(row.largest),
    paymentsInLastHour: Number(row.last_hour),
    spentInLastHourMinorUnits: Number(row.last_hour_spend),
  };
}

/**
 * Just the live status of a payment, with no visibility check of its
 * own. Only for callers that have already established the viewer may
 * see this payment — a receipt lookup, say, which does its own
 * authorising and then needs the status that may have changed since.
 */
export async function getPaymentStatusById(
  q: Queryable,
  paymentId: string
): Promise<PaymentStatus | null> {
  const result = await q.query<{ status: PaymentStatus }>(
    `select status from payments where id = $1`,
    [paymentId]
  );
  return result.rows[0]?.status ?? null;
}

/**
 * The same lookup for a shop's own account: every completed payment
 * into it, seen from the shop's side (incoming, counterparty = whoever
 * paid). The caller has already checked that the viewer works there.
 */
export async function findPaymentsByTransactionIdsForMerchant(
  pool: Pool,
  merchantId: string,
  transactionIds: string[]
): Promise<Map<string, PaymentView>> {
  if (transactionIds.length === 0) return new Map();
  const result = await pool.query<PaymentRow>(
    `${SELECT_PAYMENT}
     where p.transaction_id = any($1::uuid[])
       and p.payee_owner_type = 'merchant' and p.payee_owner_id = $2`,
    [transactionIds, merchantId]
  );
  const visible = result.rows.filter((row) => PAYEE_VISIBLE_STATUSES.includes(row.status));
  // A merchant id never equals a payer's user id, so every one of these
  // comes out as incoming with the payer as the counterparty.
  const views = await toViews(pool, visible, merchantId);
  return new Map(views.map((v) => [v.transactionId!, v]));
}

/**
 * What a payer has sent over a recent window: the total and how many
 * payments made it up. Summed in the database, in minor units, because
 * nothing else in this codebase is allowed to add money up — least of
 * all the assistant that asks this question (spec §7, §13).
 *
 * Only COMPLETED payments count: an attempt that failed never left the
 * account, so including it would overstate what someone spent.
 */
export async function sumOutgoingPaymentsSince(
  q: Queryable,
  payerUserId: string,
  days: number
): Promise<{ totalMinorUnits: MinorUnits; payments: number }> {
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new Error("days must be a positive integer");
  }
  const result = await q.query<{ total: string; payments: string }>(
    `select coalesce(sum(amount_minor_units), 0)::text as total,
            count(*)::text as payments
     from payments
     where payer_user_id = $1
       and status = 'COMPLETED'
       and created_at > now() - make_interval(days => $2::int)`,
    [payerUserId, days]
  );
  const row = result.rows[0];
  return { totalMinorUnits: Number(row.total), payments: Number(row.payments) };
}

/**
 * The payer's most recent payment, and separately their most recent one
 * that the risk engine had something to say about. Both are reads for
 * explaining a decision after the fact; neither can change one.
 */
export async function findLastOutgoingPayment(
  pool: Pool,
  payerUserId: string
): Promise<PaymentView | null> {
  const result = await pool.query<PaymentRow>(
    `${SELECT_PAYMENT}
     where p.payer_user_id = $1 and p.status = 'COMPLETED'
     order by p.created_at desc
     limit 1`,
    [payerUserId]
  );
  const row = result.rows[0];
  return row ? toSingleView(pool, row, payerUserId) : null;
}

export async function findLastFlaggedPayment(
  pool: Pool,
  payerUserId: string,
  levels: readonly RiskLevel[] = ["MEDIUM", "HIGH"]
): Promise<PaymentView | null> {
  const result = await pool.query<PaymentRow>(
    `${SELECT_PAYMENT}
     where p.payer_user_id = $1 and p.risk_level = any($2::text[])
     order by p.created_at desc
     limit 1`,
    [payerUserId, levels]
  );
  const row = result.rows[0];
  return row ? toSingleView(pool, row, payerUserId) : null;
}

export async function findPaymentsByTransactionIds(
  pool: Pool,
  userId: string,
  transactionIds: string[]
): Promise<Map<string, PaymentView>> {
  if (transactionIds.length === 0) return new Map();
  const result = await pool.query<PaymentRow>(
    `${SELECT_PAYMENT} where p.transaction_id = any($1::uuid[])`,
    [transactionIds]
  );
  const visible = result.rows.filter((row) => canView(row, userId));
  const views = await toViews(pool, visible, userId);
  return new Map(views.map((v) => [v.transactionId!, v]));
}

/**
 * How payments have gone over a window, for the operations view
 * (Phase 15). Counted here because payments owns this table; what the
 * numbers mean is the reader's business.
 */
export async function countPaymentsByStatusSince(
  q: Queryable,
  hours: number
): Promise<{ status: PaymentStatus; count: number; totalMinorUnits: MinorUnits }[]> {
  const result = await q.query<{ status: PaymentStatus; count: string; total: string }>(
    `select status, count(*)::text as count,
            coalesce(sum(amount_minor_units), 0)::text as total
     from payments
     where created_at > now() - make_interval(hours => $1::int)
     group by status
     order by count(*) desc`,
    [hours]
  );
  return result.rows.map((row) => ({
    status: row.status,
    count: Number(row.count),
    totalMinorUnits: Number(row.total),
  }));
}

/** Payments that failed, by reason, over the same window. */
export async function countFailuresByReasonSince(
  q: Queryable,
  hours: number
): Promise<{ reason: string; count: number }[]> {
  const result = await q.query<{ reason: string | null; count: string }>(
    `select failure_reason as reason, count(*)::text as count
     from payments
     where status = 'FAILED' and created_at > now() - make_interval(hours => $1::int)
     group by failure_reason
     order by count(*) desc`,
    [hours]
  );
  return result.rows.map((row) => ({ reason: row.reason ?? "UNKNOWN", count: Number(row.count) }));
}
