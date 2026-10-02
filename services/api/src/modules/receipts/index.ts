// Domain module: receipts
// One immutable digital receipt per completed payment (spec §14). This
// module is the only writer to the `receipts` table. Payments calls
// `issueReceiptWithClient` inside the same database transaction that
// completes the payment, so a completed payment always has a receipt.
//
// Receipts snapshot what was true when the money moved (names, amount,
// purpose). What can change afterwards (the payment's status after a
// refund, cashback in Phase 10) is supplied by callers when building a
// view, so this table never needs updating.
import { randomBytes } from "node:crypto";
import type { MinorUnits, PaymentStatus } from "@fintech-network/shared-types";
import type { Queryable } from "../../db.js";

export const MODULE_NAME = "receipts" as const;

export interface IssueReceiptInput {
  paymentId: string;
  transactionId: string;
  payerUserId: string;
  payeeOwnerType: "user" | "merchant";
  payeeOwnerId: string;
  payerDisplayName: string;
  payeeDisplayName: string;
  amountMinorUnits: MinorUnits;
  purpose: string | null;
}

export interface Receipt {
  id: string;
  receiptNumber: string;
  paymentId: string;
  transactionId: string;
  payerUserId: string;
  payeeOwnerType: "user" | "merchant";
  payeeOwnerId: string;
  payerDisplayName: string;
  payeeDisplayName: string;
  amountMinorUnits: MinorUnits;
  currency: "GBP";
  purpose: string | null;
  passportReference: string;
  issuedAt: string;
}

/** What a user sees. Built per viewer, so each side sees its own framing. */
export interface ReceiptView {
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

// No 0/O or 1/I, so a receipt number can be read out over the phone.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function randomCode(length: number): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/** e.g. RCP-7KQ2MX9TRA4P — 60 bits, human-friendly, not a secret. */
export function generateReceiptNumber(): string {
  return `RCP-${randomCode(12)}`;
}

/**
 * e.g. PP-<52 chars> — ~260 bits. This one IS a secret-ish capability:
 * later it's what a user shares to let someone verify this payment.
 */
export function generatePassportReference(): string {
  return `PP-${randomBytes(32).toString("base64url")}`;
}

interface ReceiptRow {
  id: string;
  receipt_number: string;
  payment_id: string;
  transaction_id: string;
  payer_user_id: string;
  payee_owner_type: "user" | "merchant";
  payee_owner_id: string;
  payer_display_name: string;
  payee_display_name: string;
  amount_minor_units: string;
  currency: string;
  purpose: string | null;
  passport_reference: string;
  issued_at: Date;
}

function toReceipt(row: ReceiptRow): Receipt {
  return {
    id: row.id,
    receiptNumber: row.receipt_number,
    paymentId: row.payment_id,
    transactionId: row.transaction_id,
    payerUserId: row.payer_user_id,
    payeeOwnerType: row.payee_owner_type,
    payeeOwnerId: row.payee_owner_id,
    payerDisplayName: row.payer_display_name,
    payeeDisplayName: row.payee_display_name,
    amountMinorUnits: Number(row.amount_minor_units),
    currency: row.currency as "GBP",
    purpose: row.purpose,
    passportReference: row.passport_reference,
    issuedAt: row.issued_at.toISOString(),
  };
}

/**
 * Must be called with a client inside the caller's BEGIN, so the receipt
 * commits or rolls back together with the payment it describes.
 */
export async function issueReceiptWithClient(
  client: Queryable,
  input: IssueReceiptInput
): Promise<Receipt> {
  const result = await client.query<ReceiptRow>(
    `insert into receipts (
       receipt_number, payment_id, transaction_id, payer_user_id,
       payee_owner_type, payee_owner_id, payer_display_name, payee_display_name,
       amount_minor_units, purpose, passport_reference
     ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     returning *`,
    [
      generateReceiptNumber(),
      input.paymentId,
      input.transactionId,
      input.payerUserId,
      input.payeeOwnerType,
      input.payeeOwnerId,
      input.payerDisplayName,
      input.payeeDisplayName,
      input.amountMinorUnits,
      input.purpose,
      generatePassportReference(),
    ]
  );
  return toReceipt(result.rows[0]);
}

/**
 * Returns the receipt only if the viewer is one of the two sides of it:
 * its payer, its payee when that's them, or — when the payee is a shop
 * — a shop they work for. `merchantIds` is passed in by the caller
 * (from the merchants module); this module doesn't decide membership.
 * Anyone else gets null, which callers turn into a plain 404.
 */
export async function findReceiptForViewer(
  q: Queryable,
  viewer: { userId: string; merchantIds?: string[] },
  by: { receiptId: string } | { paymentId: string }
): Promise<Receipt | null> {
  const column = "receiptId" in by ? "id" : "payment_id";
  const value = "receiptId" in by ? by.receiptId : by.paymentId;
  const result = await q.query<ReceiptRow>(
    `select * from receipts
     where ${column} = $1
       and (payer_user_id = $2
            or (payee_owner_type = 'user' and payee_owner_id = $2)
            or (payee_owner_type = 'merchant' and payee_owner_id = any($3::uuid[])))`,
    [value, viewer.userId, viewer.merchantIds ?? []]
  );
  return result.rows[0] ? toReceipt(result.rows[0]) : null;
}

/** The common case: a person looking at their own receipt. */
export async function findReceiptForUser(
  q: Queryable,
  userId: string,
  by: { receiptId: string } | { paymentId: string }
): Promise<Receipt | null> {
  return findReceiptForViewer(q, { userId }, by);
}

/** paymentId -> receiptId, for decorating lists without N+1 queries. */
export async function findReceiptIdsByPaymentIds(
  q: Queryable,
  paymentIds: string[]
): Promise<Map<string, string>> {
  if (paymentIds.length === 0) return new Map();
  const result = await q.query<{ id: string; payment_id: string }>(
    `select id, payment_id from receipts where payment_id = any($1::uuid[])`,
    [paymentIds]
  );
  return new Map(result.rows.map((r) => [r.payment_id, r.id]));
}

/**
 * Pure: frames a receipt for one viewer. `paymentStatus` is passed in
 * (read live from payments) because it can change after issue.
 */
export function toReceiptView(
  receipt: Receipt,
  viewerUserId: string,
  paymentStatus: PaymentStatus
): ReceiptView {
  return {
    id: receipt.id,
    receiptNumber: receipt.receiptNumber,
    paymentId: receipt.paymentId,
    transactionId: receipt.transactionId,
    role: receipt.payerUserId === viewerUserId ? "payer" : "payee",
    from: receipt.payerDisplayName,
    to: receipt.payeeDisplayName,
    amountMinorUnits: receipt.amountMinorUnits,
    currency: receipt.currency,
    purpose: receipt.purpose,
    issuedAt: receipt.issuedAt,
    paymentStatus,
    // The verification view itself is a later increment. Until then the
    // reference exists but isn't shareable or checkable.
    passport: { reference: receipt.passportReference, available: false },
  };
}
