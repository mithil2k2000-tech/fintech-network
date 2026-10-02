// Domain module: payment requests ("please pay me £X for Y").
// Phase 6 shows them as QR codes; Phase 7 sends them to a named person.
// Both are the same request with a different channel — see CHANNELS
// below. The module is the only writer to the payment_requests table. It
// creates the actual payment through the payments module, and learns
// that a request was paid through a payments completion hook, so the
// payments module never needs to know requests exist.
import type { Pool, PoolClient } from "pg";
import type { MinorUnits } from "@fintech-network/shared-types";
import type { Queryable } from "../../db.js";
import { recordAuditEvent } from "../audit/index.js";
import { findUserByEmail, findUserById } from "../users/index.js";
import {
  findMerchantById,
  findMerchantNames,
  getMembership,
  requireMembership,
} from "../merchants/index.js";
import { findReceiptIdsByPaymentIds } from "../receipts/index.js";
import {
  createPayment,
  PaymentBlockedError,
  type PaymentCompletionHook,
  type PaymentsDeps,
  type PaymentView,
} from "../payments/index.js";
import {
  generateRequestCode,
  generateRequestToken,
  parseRequestKey,
} from "./codes.js";

export const MODULE_NAME = "paymentRequests" as const;
export { parseRequestKey } from "./codes.js";

export const DEFAULT_EXPIRY_MINUTES = 30;
export const MAX_EXPIRY_MINUTES = 7 * 24 * 60;
/** A direct ask sits in someone's inbox, so it gets longer by default. */
export const DEFAULT_DIRECT_EXPIRY_MINUTES = 7 * 24 * 60;

/**
 * How a request reaches its payer. 'qr': anyone holding the token or
 * code may pay it. 'direct': only the named person may, and they may
 * decline. New channels (a link, a merchant terminal) slot in here.
 */
export const CHANNELS = ["qr", "direct"] as const;
export type RequestChannel = (typeof CHANNELS)[number];

/** Who the money is for: a person, or a shop they act for. */
export type PayeeOwnerType = "user" | "merchant";

/**
 * How far we vouch for who is asking. A registered user is someone with
 * an account; a registered shop is a shop someone has registered — and
 * nothing more, because this prototype runs no business checks. The
 * levels are named so a verified tier can be added without the app
 * having to guess what an old value meant.
 */
export type RequesterVerification = "registered_user" | "registered_merchant";

export type StoredStatus = "OPEN" | "PAID" | "CANCELLED" | "DECLINED";
/** What callers see. EXPIRED is derived from expires_at, never stored. */
export type RequestStatus = StoredStatus | "EXPIRED";

export class PaymentRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string
  ) {
    super(message);
    this.name = "PaymentRequestError";
  }
}

interface RequestRow {
  id: string;
  code: string;
  token: string;
  channel: RequestChannel;
  created_by_user_id: string;
  target_user_id: string | null;
  payee_owner_type: PayeeOwnerType;
  payee_owner_id: string;
  amount_minor_units: string;
  currency: string;
  purpose: string | null;
  status: StoredStatus;
  expires_at: Date;
  paid_payment_id: string | null;
  paid_by_user_id: string | null;
  paid_at: Date | null;
  cancelled_at: Date | null;
  declined_at: Date | null;
  bill_split_id: string | null;
  split_share_index: number | null;
  created_at: Date;
}

export function effectiveStatus(
  row: { status: StoredStatus; expires_at: Date },
  now: Date = new Date()
): RequestStatus {
  if (row.status === "OPEN" && row.expires_at.getTime() <= now.getTime()) return "EXPIRED";
  return row.status;
}

/** Full view, only for the person who created the request. */
export interface OwnPaymentRequestView {
  id: string;
  code: string;
  token: string;
  channel: RequestChannel;
  amountMinorUnits: MinorUnits;
  currency: "GBP";
  purpose: string | null;
  status: RequestStatus;
  expiresAt: string;
  createdAt: string;
  /** Who it was sent to, for a direct request. Null for a QR. */
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

/** What the person who was asked sees in their inbox. */
export interface IncomingPaymentRequestView {
  id: string;
  code: string;
  amountMinorUnits: MinorUnits;
  currency: "GBP";
  purpose: string | null;
  status: RequestStatus;
  expiresAt: string;
  createdAt: string;
  requester: { displayName: string };
  paymentId: string | null;
  receiptId: string | null;
  billSplitId: string | null;
}

/**
 * What someone who scanned the QR sees. No token, nothing about who else
 * has paid or looked at it.
 */
export interface PublicPaymentRequestView {
  id: string;
  code: string;
  amountMinorUnits: MinorUnits;
  currency: "GBP";
  purpose: string | null;
  status: RequestStatus;
  expiresAt: string;
  channel: RequestChannel;
  requester: {
    type: PayeeOwnerType;
    displayName: string;
    verification: RequesterVerification;
  };
  /** True when the person looking is the one who created it. */
  isOwn: boolean;
  /** True when this was sent to the person looking, and they may pay it. */
  isForYou: boolean;
}

async function load(q: Queryable, where: string, value: string): Promise<RequestRow | null> {
  const result = await q.query<RequestRow>(
    `select * from payment_requests where ${where} = $1`,
    [value]
  );
  return result.rows[0] ?? null;
}

/**
 * Display names for a set of user ids, looked up once. Today that's the
 * email address; when users gain a chosen display name this is the only
 * place that changes. (Showing an email to a stranger is a known gap —
 * see README "Known limitations".)
 */
async function displayNames(q: Queryable, ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  for (const id of unique) {
    const user = await findUserById(q, id);
    if (user) names.set(id, user.email);
  }
  return names;
}

function nameOf(names: Map<string, string>, id: string | null): { displayName: string } | null {
  return id ? { displayName: names.get(id) ?? "Unknown" } : null;
}

async function toOwnViews(q: Queryable, rows: RequestRow[]): Promise<OwnPaymentRequestView[]> {
  const paymentIds = rows.map((r) => r.paid_payment_id).filter((id): id is string => !!id);
  const receipts = await findReceiptIdsByPaymentIds(q, paymentIds);
  const names = await displayNames(q, [
    ...rows.map((r) => r.paid_by_user_id),
    ...rows.map((r) => r.target_user_id),
  ]);
  const shops = await findMerchantNames(
    q,
    rows.filter((r) => r.payee_owner_type === "merchant").map((r) => r.payee_owner_id)
  );
  const now = new Date();
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    token: row.token,
    channel: row.channel,
    amountMinorUnits: Number(row.amount_minor_units),
    currency: row.currency as "GBP",
    purpose: row.purpose,
    status: effectiveStatus(row, now),
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    sentTo: nameOf(names, row.target_user_id),
    paidAt: row.paid_at?.toISOString() ?? null,
    paidBy: nameOf(names, row.paid_by_user_id),
    declinedAt: row.declined_at?.toISOString() ?? null,
    paymentId: row.paid_payment_id,
    receiptId: row.paid_payment_id ? receipts.get(row.paid_payment_id) ?? null : null,
    billSplitId: row.bill_split_id,
    takenFor:
      row.payee_owner_type === "merchant"
        ? {
            merchantId: row.payee_owner_id,
            displayName: shops.get(row.payee_owner_id) ?? "Unknown shop",
          }
        : null,
  }));
}

async function toIncomingViews(
  q: Queryable,
  rows: RequestRow[]
): Promise<IncomingPaymentRequestView[]> {
  const paymentIds = rows.map((r) => r.paid_payment_id).filter((id): id is string => !!id);
  const receipts = await findReceiptIdsByPaymentIds(q, paymentIds);
  const names = await displayNames(q, rows.map((r) => r.created_by_user_id));
  const shops = await findMerchantNames(
    q,
    rows.filter((r) => r.payee_owner_type === "merchant").map((r) => r.payee_owner_id)
  );
  const now = new Date();
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    amountMinorUnits: Number(row.amount_minor_units),
    currency: row.currency as "GBP",
    purpose: row.purpose,
    status: effectiveStatus(row, now),
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
    // Who you owe is whoever gets the money: the shop when there is
    // one, otherwise the person who asked.
    requester:
      row.payee_owner_type === "merchant"
        ? { displayName: shops.get(row.payee_owner_id) ?? "Unknown shop" }
        : nameOf(names, row.created_by_user_id) ?? { displayName: "Unknown" },
    paymentId: row.paid_payment_id,
    receiptId: row.paid_payment_id ? receipts.get(row.paid_payment_id) ?? null : null,
    billSplitId: row.bill_split_id,
  }));
}

export interface CreatePaymentRequestInput {
  userId: string;
  amountMinorUnits: MinorUnits;
  purpose?: string | null;
  expiresInMinutes?: number;
  /**
   * Who to ask. Omitted, the request is a QR anyone can pay; given, only
   * that person can. Future channels take their own optional field here
   * rather than changing this signature.
   */
  toEmail?: string | null;
  /** The user id of the person to ask, when the caller already has it. */
  toUserId?: string | null;
  /** Set by the billSplits module when this request is one person's share. */
  billSplitId?: string | null;
  /** Where that share sits in the split; required with billSplitId. */
  splitShareIndex?: number | null;
  /**
   * Take this money for a shop rather than for yourself. The caller
   * must be a member of it; the request is still recorded as created by
   * the person, so the audit trail says who was at the till.
   */
  asMerchantId?: string | null;
}

/**
 * Creates one request on a caller's connection, so several can be made
 * in one transaction (a split bill) and roll back together. Everything
 * about the request is decided here; `createPaymentRequest` is this
 * with the pool.
 */
export async function createPaymentRequestWithClient(
  q: Queryable,
  input: CreatePaymentRequestInput
): Promise<OwnPaymentRequestView> {
  const toEmail = input.toEmail?.trim() || null;
  const channel: RequestChannel = toEmail || input.toUserId ? "direct" : "qr";

  let targetUserId: string | null = input.toUserId ?? null;
  if (toEmail && !targetUserId) {
    const target = await findUserByEmail(q, toEmail);
    // Same wording whichever it is: "no such person" and "that's you"
    // both just mean we won't create it, and the first shouldn't become
    // a way to test whether an address is registered here.
    if (!target) targetUserId = null;
    else targetUserId = target.id;
  }
  if (channel === "direct" && (!targetUserId || targetUserId === input.userId)) {
    throw new PaymentRequestError(
      "PAYMENT_REQUEST_INVALID_RECIPIENT",
      400,
      "We couldn't send a request to that address"
    );
  }

  const minutes =
    input.expiresInMinutes ??
    (channel === "direct" ? DEFAULT_DIRECT_EXPIRY_MINUTES : DEFAULT_EXPIRY_MINUTES);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_EXPIRY_MINUTES) {
    throw new PaymentRequestError("INVALID_EXPIRY", 400, "Invalid expiry");
  }

  // Who gets paid: the person asking, or a shop they're allowed to take
  // money for. The merchants module decides whether they are.
  let payeeOwnerType: PayeeOwnerType = "user";
  let payeeOwnerId = input.userId;
  if (input.asMerchantId) {
    await requireMembership(q, input.asMerchantId, input.userId, { mustBeActive: true });
    payeeOwnerType = "merchant";
    payeeOwnerId = input.asMerchantId;
  }

  const result = await q.query<RequestRow>(
    `insert into payment_requests
       (code, token, channel, created_by_user_id, target_user_id,
        payee_owner_type, payee_owner_id,
        amount_minor_units, purpose, expires_at, bill_split_id, split_share_index)
     values ($1, $2, $3, $4, $5, $11, $12, $6, $7, now() + make_interval(mins => $8), $9, $10)
     returning *`,
    [
      generateRequestCode(),
      generateRequestToken(),
      channel,
      input.userId,
      targetUserId,
      input.amountMinorUnits,
      input.purpose ?? null,
      minutes,
      input.billSplitId ?? null,
      input.billSplitId ? input.splitShareIndex ?? null : null,
      payeeOwnerType,
      payeeOwnerId,
    ]
  );
  const row = result.rows[0];
  await recordAuditEvent(q, {
    eventType: "PAYMENT_REQUEST_CREATED",
    actorUserId: input.userId,
    metadata: {
      paymentRequestId: row.id,
      code: row.code,
      channel,
      targetUserId,
      billSplitId: input.billSplitId ?? null,
      payeeOwnerType,
      payeeOwnerId,
      amountMinorUnits: input.amountMinorUnits,
    },
  });
  const [view] = await toOwnViews(q, [row]);
  return view;
}

export async function createPaymentRequest(
  pool: Pool,
  input: CreatePaymentRequestInput
): Promise<OwnPaymentRequestView> {
  return createPaymentRequestWithClient(pool, input);
}

/**
 * Who may manage a request: the person who made it, and — for a shop's
 * charge — anyone else who works there, because the colleague on the
 * next till has to be able to cancel it.
 */
async function canManage(q: Queryable, row: RequestRow, userId: string): Promise<boolean> {
  if (row.created_by_user_id === userId) return true;
  if (row.payee_owner_type !== "merchant") return false;
  return (await getMembership(q, row.payee_owner_id, userId)) !== null;
}

function ownRequestNotFound(): PaymentRequestError {
  return new PaymentRequestError("PAYMENT_REQUEST_NOT_FOUND", 404, "Payment request not found");
}

export async function getOwnPaymentRequest(
  pool: Pool,
  userId: string,
  id: string
): Promise<OwnPaymentRequestView> {
  const row = await load(pool, "id", id);
  if (!row || !(await canManage(pool, row, userId))) throw ownRequestNotFound();
  const [view] = await toOwnViews(pool, [row]);
  return view;
}

export async function listOwnPaymentRequests(
  pool: Pool,
  userId: string,
  limit = 20
): Promise<OwnPaymentRequestView[]> {
  const result = await pool.query<RequestRow>(
    `select * from payment_requests
     where created_by_user_id = $1
     order by created_at desc
     limit $2`,
    [userId, limit]
  );
  return toOwnViews(pool, result.rows);
}

/**
 * Every share of one split bill, in the order the organiser gave them.
 * They're all written in one transaction and so share a created_at,
 * which is why the order is stored rather than inferred. The caller
 * decides who is allowed to see it — this only knows about requests.
 */
export async function listPaymentRequestsForSplit(
  q: Queryable,
  billSplitId: string
): Promise<OwnPaymentRequestView[]> {
  const result = await q.query<RequestRow>(
    `select * from payment_requests
     where bill_split_id = $1
     order by split_share_index`,
    [billSplitId]
  );
  return toOwnViews(q, result.rows);
}

/**
 * Calls off every share of a split that nobody has answered yet. Paid
 * and declined shares are left exactly as they are — cancelling a split
 * doesn't undo a payment. Returns how many were cancelled.
 */
export async function cancelPaymentRequestsForSplit(
  q: Queryable,
  billSplitId: string,
  actorUserId: string
): Promise<number> {
  const result = await q.query<{ id: string }>(
    `update payment_requests
     set status = 'CANCELLED', cancelled_at = now(), updated_at = now()
     where bill_split_id = $1 and status = 'OPEN'
     returning id`,
    [billSplitId]
  );
  for (const row of result.rows) {
    await recordAuditEvent(q, {
      eventType: "PAYMENT_REQUEST_CANCELLED",
      actorUserId,
      metadata: { paymentRequestId: row.id, billSplitId },
    });
  }
  return result.rowCount ?? 0;
}

/**
 * A shop's charges, newest first — the till's own list, whoever was on
 * it. Only members of the shop may see it.
 */
export async function listPaymentRequestsForMerchant(
  pool: Pool,
  userId: string,
  merchantId: string,
  limit = 20
): Promise<OwnPaymentRequestView[]> {
  await requireMembership(pool, merchantId, userId);
  const result = await pool.query<RequestRow>(
    `select * from payment_requests
     where payee_owner_type = 'merchant' and payee_owner_id = $1
     order by created_at desc
     limit $2`,
    [merchantId, limit]
  );
  return toOwnViews(pool, result.rows);
}

/** The inbox: requests other people have sent to this user. */
export async function listIncomingPaymentRequests(
  pool: Pool,
  userId: string,
  limit = 20
): Promise<IncomingPaymentRequestView[]> {
  const result = await pool.query<RequestRow>(
    `select * from payment_requests
     where target_user_id = $1
     order by created_at desc
     limit $2`,
    [userId, limit]
  );
  return toIncomingViews(pool, result.rows);
}

/** How many are still waiting on an answer — for the badge on Home. */
export async function countWaitingPaymentRequests(
  pool: Pool,
  userId: string
): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `select count(*)::text as count from payment_requests
     where target_user_id = $1 and status = 'OPEN' and expires_at > now()`,
    [userId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

/** Saying no. Only the person who was asked can, and only while it's open. */
export async function declinePaymentRequest(
  pool: Pool,
  userId: string,
  id: string
): Promise<IncomingPaymentRequestView> {
  const row = await load(pool, "id", id);
  // Not being the recipient looks the same as it not existing: someone
  // guessing ids learns nothing either way.
  if (!row || row.target_user_id !== userId) {
    throw new PaymentRequestError(
      "PAYMENT_REQUEST_NOT_FOUND",
      404,
      "Payment request not found"
    );
  }
  const result = await pool.query<RequestRow>(
    `update payment_requests
     set status = 'DECLINED', declined_at = now(), updated_at = now()
     where id = $1 and status = 'OPEN'
     returning *`,
    [id]
  );
  if (result.rowCount === 0) {
    const status = effectiveStatus(row);
    const [code, message] = status === "OPEN" ? NOT_PAYABLE.EXPIRED : NOT_PAYABLE[status];
    throw new PaymentRequestError(code, 409, message);
  }
  await recordAuditEvent(pool, {
    eventType: "PAYMENT_REQUEST_DECLINED",
    actorUserId: userId,
    metadata: { paymentRequestId: id, requestedByUserId: row.created_by_user_id },
  });
  const [view] = await toIncomingViews(pool, [result.rows[0]]);
  return view;
}

export async function cancelPaymentRequest(
  pool: Pool,
  userId: string,
  id: string
): Promise<OwnPaymentRequestView> {
  const row = await load(pool, "id", id);
  if (!row || !(await canManage(pool, row, userId))) throw ownRequestNotFound();

  const result = await pool.query<RequestRow>(
    `update payment_requests
     set status = 'CANCELLED', cancelled_at = now(), updated_at = now()
     where id = $1 and status = 'OPEN'
     returning *`,
    [id]
  );
  if (result.rowCount === 0) {
    throw new PaymentRequestError(
      "PAYMENT_REQUEST_NOT_OPEN",
      409,
      "This request has already been paid or cancelled"
    );
  }
  await recordAuditEvent(pool, {
    eventType: "PAYMENT_REQUEST_CANCELLED",
    actorUserId: userId,
    metadata: { paymentRequestId: id },
  });
  const [view] = await toOwnViews(pool, [result.rows[0]]);
  return view;
}

async function toPublicView(
  pool: Pool,
  row: RequestRow,
  viewerUserId: string
): Promise<PublicPaymentRequestView> {
  // Whoever the money goes to is who the payer is told they're paying:
  // a shop's trading name, or the person's own name.
  const isShop = row.payee_owner_type === "merchant";
  const shop = isShop ? await findMerchantById(pool, row.payee_owner_id) : null;
  const person = isShop ? null : await findUserById(pool, row.payee_owner_id);
  return {
    id: row.id,
    code: row.code,
    amountMinorUnits: Number(row.amount_minor_units),
    currency: row.currency as "GBP",
    purpose: row.purpose,
    status: effectiveStatus(row),
    expiresAt: row.expires_at.toISOString(),
    channel: row.channel,
    requester: {
      type: row.payee_owner_type,
      displayName: (isShop ? shop?.tradingName : person?.email) ?? "Unknown",
      // Both levels mean "has an account here" and nothing more. No
      // business checks are run in this prototype.
      verification: isShop ? "registered_merchant" : "registered_user",
    },
    isOwn: row.created_by_user_id === viewerUserId,
    // "You can pay this": allowed to, and not your own money going in a
    // circle. Paying yourself is refused by the payments module anyway;
    // this is what stops the screen offering it in the first place.
    isForYou: canPay(row, viewerUserId) && row.created_by_user_id !== viewerUserId,
  };
}

/**
 * Who may pay this request. A QR is open to whoever holds it; a direct
 * request is only for the person it was sent to.
 */
function canPay(row: RequestRow, userId: string): boolean {
  return row.target_user_id === null ? true : row.target_user_id === userId;
}

/** Who may look at it. Everything payable, plus the requester's own view. */
function canView(row: RequestRow, userId: string): boolean {
  return canPay(row, userId) || row.created_by_user_id === userId;
}

/** Looks a request up from what was scanned, typed, or opened from an inbox. */
export async function resolvePaymentRequest(
  pool: Pool,
  viewerUserId: string,
  rawKey: string
): Promise<PublicPaymentRequestView> {
  const key = parseRequestKey(rawKey);
  const row = !key
    ? null
    : "token" in key
      ? await load(pool, "token", key.token)
      : "id" in key
        ? await load(pool, "id", key.id)
        : await load(pool, "code", key.code);
  // A request sent to someone else is not yours to read, and says so the
  // same way a made-up key does.
  if (!row || !canView(row, viewerUserId)) {
    throw new PaymentRequestError(
      "PAYMENT_REQUEST_NOT_FOUND",
      404,
      "We couldn't find that payment request"
    );
  }
  return toPublicView(pool, row, viewerUserId);
}

const NOT_PAYABLE: Record<Exclude<RequestStatus, "OPEN">, [string, string]> = {
  PAID: ["PAYMENT_REQUEST_ALREADY_PAID", "This request has already been paid"],
  CANCELLED: ["PAYMENT_REQUEST_CANCELLED", "This request was cancelled"],
  DECLINED: ["PAYMENT_REQUEST_DECLINED", "This request was declined"],
  EXPIRED: ["PAYMENT_REQUEST_EXPIRED", "This request has expired"],
};

/**
 * Starts paying a request. Amount, payee and purpose all come from the
 * stored request, never from the payer. Returns the payment for review;
 * it's then confirmed through the normal payments confirm step.
 */
export async function payPaymentRequest(
  deps: PaymentsDeps,
  input: { payerUserId: string; requestId: string }
): Promise<PaymentView> {
  const row = await load(deps.pool, "id", input.requestId);
  if (!row || !canView(row, input.payerUserId)) {
    throw new PaymentRequestError("PAYMENT_REQUEST_NOT_FOUND", 404, "Payment request not found");
  }
  if (!canPay(row, input.payerUserId)) {
    // Visible but not payable: the requester looking at their own ask.
    throw new PaymentRequestError(
      "PAYMENT_REQUEST_NOT_FOR_YOU",
      403,
      "This request was sent to someone else"
    );
  }
  const status = effectiveStatus(row);
  if (status !== "OPEN") {
    const [code, message] = NOT_PAYABLE[status];
    throw new PaymentRequestError(code, 409, message);
  }
  return createPayment(deps, {
    payerUserId: input.payerUserId,
    payee: { ownerType: row.payee_owner_type, ownerId: row.payee_owner_id },
    amountMinorUnits: Number(row.amount_minor_units),
    purpose: row.purpose,
    paymentRequestId: row.id,
  });
}

/**
 * Payments completion hook. Flips the request OPEN -> PAID inside the
 * payment's own transaction. The conditional update is what makes a QR
 * payable exactly once: a second payer's transaction finds it no longer
 * OPEN and the whole payment rolls back.
 */
export const markPaymentRequestPaid: PaymentCompletionHook = async (
  client: PoolClient,
  payment
) => {
  if (!payment.paymentRequestId) return;
  const updated = await client.query(
    `update payment_requests
     set status = 'PAID', paid_payment_id = $2, paid_by_user_id = $3,
         paid_at = now(), updated_at = now()
     where id = $1 and status = 'OPEN' and expires_at > now()
       and amount_minor_units = $4
       and payee_owner_type = $5 and payee_owner_id = $6
       and (target_user_id is null or target_user_id = $3)
     returning id`,
    [
      payment.paymentRequestId,
      payment.paymentId,
      payment.payerUserId,
      payment.amountMinorUnits,
      payment.payeeOwnerType,
      payment.payeeOwnerId,
    ]
  );
  if (updated.rowCount === 1) {
    await recordAuditEvent(client, {
      eventType: "PAYMENT_REQUEST_PAID",
      actorUserId: payment.payerUserId,
      metadata: {
        paymentRequestId: payment.paymentRequestId,
        paymentId: payment.paymentId,
      },
    });
    return;
  }
  const row = await load(client, "id", payment.paymentRequestId);
  const status = row ? effectiveStatus(row) : "CANCELLED";
  throw new PaymentBlockedError(
    status === "OPEN" ? "PAYMENT_REQUEST_MISMATCH" : NOT_PAYABLE[status][0]
  );
};
