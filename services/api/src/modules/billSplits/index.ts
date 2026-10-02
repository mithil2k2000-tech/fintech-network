// Domain module: bill splits ("this cost £60, there were four of us").
//
// A split is a small amount of bookkeeping on top of Phase 7: the
// organiser keeps their own share, and everyone else gets an ordinary
// direct payment request. Paying, declining, receipts and the ledger
// are untouched — a share is paid through exactly the same two steps as
// any other request, so there is one way money moves, not two.
//
// This module is the only writer to bill_splits. It never writes to
// payment_requests itself: it calls the paymentRequests module, which
// owns that table.
import type { Pool, PoolClient } from "pg";
import type { MinorUnits } from "@fintech-network/shared-types";
import type { Queryable } from "../../db.js";
import { recordAuditEvent } from "../audit/index.js";
import { findUserByEmail, findUserById } from "../users/index.js";
import {
  cancelPaymentRequestsForSplit,
  createPaymentRequestWithClient,
  listPaymentRequestsForSplit,
  type OwnPaymentRequestView,
  type RequestStatus,
} from "../paymentRequests/index.js";
import { MAX_SPLIT_PARTS, SplitMathError, shareOut } from "./shares.js";

export const MODULE_NAME = "billSplits" as const;
export { MAX_SPLIT_PARTS, SplitMathError, shareOut, splitEvenly, checkCustomShares } from "./shares.js";

export type SplitMethod = "even" | "custom";
export type StoredSplitStatus = "OPEN" | "CANCELLED";
/** SETTLED is worked out from the shares when read, never stored. */
export type SplitStatus = StoredSplitStatus | "SETTLED";

export class BillSplitError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    message: string
  ) {
    super(message);
    this.name = "BillSplitError";
  }
}

interface SplitRow {
  id: string;
  created_by_user_id: string;
  total_minor_units: string;
  organiser_share_minor_units: string;
  currency: string;
  purpose: string | null;
  method: SplitMethod;
  status: StoredSplitStatus;
  cancelled_at: Date | null;
  created_at: Date;
}

/** One person's part of the bill, as either side sees it. */
export interface SplitShareView {
  paymentRequestId: string;
  person: { displayName: string };
  amountMinorUnits: MinorUnits;
  status: RequestStatus;
  paidAt: string | null;
  receiptId: string | null;
}

export interface BillSplitView {
  id: string;
  totalMinorUnits: MinorUnits;
  currency: "GBP";
  purpose: string | null;
  method: SplitMethod;
  status: SplitStatus;
  createdAt: string;
  organiser: { displayName: string; isYou: boolean };
  /** What the organiser is covering themselves. */
  organiserShareMinorUnits: MinorUnits;
  shares: SplitShareView[];
  /** Of the money asked of other people, how much has arrived. */
  collectedMinorUnits: MinorUnits;
  outstandingMinorUnits: MinorUnits;
}

function notFound(): BillSplitError {
  return new BillSplitError("BILL_SPLIT_NOT_FOUND", 404, "Bill split not found");
}

async function loadSplit(q: Queryable, id: string): Promise<SplitRow | null> {
  const result = await q.query<SplitRow>(`select * from bill_splits where id = $1`, [id]);
  return result.rows[0] ?? null;
}

/**
 * A split is settled when nobody still owes anything: every share has
 * been paid, declined, cancelled or has run out. Declined counts as
 * finished, not paid — the money simply never arrives, and the
 * organiser can see exactly who said no.
 */
export function effectiveSplitStatus(
  row: { status: StoredSplitStatus },
  shares: { status: RequestStatus }[]
): SplitStatus {
  if (row.status === "CANCELLED") return "CANCELLED";
  const anyWaiting = shares.some((s) => s.status === "OPEN");
  return anyWaiting ? "OPEN" : "SETTLED";
}

async function toView(
  q: Queryable,
  row: SplitRow,
  viewerUserId: string,
  requests?: OwnPaymentRequestView[]
): Promise<BillSplitView> {
  const shareRequests = requests ?? (await listPaymentRequestsForSplit(q, row.id));
  const organiser = await findUserById(q, row.created_by_user_id);

  const shares: SplitShareView[] = shareRequests.map((r) => ({
    paymentRequestId: r.id,
    person: r.sentTo ?? { displayName: "Unknown" },
    amountMinorUnits: r.amountMinorUnits,
    status: r.status,
    paidAt: r.paidAt,
    receiptId: r.receiptId,
  }));

  // Sums of whole pence: safe integers, no rounding to do.
  const collected = shares
    .filter((s) => s.status === "PAID")
    .reduce((sum, s) => sum + s.amountMinorUnits, 0);
  const outstanding = shares
    .filter((s) => s.status === "OPEN")
    .reduce((sum, s) => sum + s.amountMinorUnits, 0);

  return {
    id: row.id,
    totalMinorUnits: Number(row.total_minor_units),
    currency: row.currency as "GBP",
    purpose: row.purpose,
    method: row.method,
    status: effectiveSplitStatus(row, shares),
    createdAt: row.created_at.toISOString(),
    organiser: {
      displayName: organiser?.email ?? "Unknown",
      isYou: row.created_by_user_id === viewerUserId,
    },
    organiserShareMinorUnits: Number(row.organiser_share_minor_units),
    shares,
    // Anything asked of others that is neither paid nor still open was
    // declined or lapsed, so these two don't have to add up to the total.
    collectedMinorUnits: collected,
    outstandingMinorUnits: outstanding,
  };
}

export interface CreateBillSplitInput {
  userId: string;
  totalMinorUnits: MinorUnits;
  purpose?: string | null;
  /** Everyone else in the split, by email. The organiser is not listed. */
  participantEmails: string[];
  /**
   * Optional exact amounts, organiser first, then the participants in
   * the order given. Omitted, the total is split evenly.
   */
  shareMinorUnits?: number[];
  /** Whether the organiser is paying a share themselves. Default true. */
  includeOrganiser?: boolean;
  expiresInMinutes?: number;
}

/**
 * Creates the split and one request per participant in a single
 * transaction: either everyone was asked or nobody was, so a split can
 * never exist half-made.
 */
export async function createBillSplit(
  pool: Pool,
  input: CreateBillSplitInput
): Promise<BillSplitView> {
  const includeOrganiser = input.includeOrganiser ?? true;
  const emails = input.participantEmails.map((e) => e.trim().toLowerCase()).filter(Boolean);

  if (emails.length === 0) {
    throw new BillSplitError("BILL_SPLIT_NO_PARTICIPANTS", 400, "Add at least one other person");
  }
  if (new Set(emails).size !== emails.length) {
    throw new BillSplitError(
      "BILL_SPLIT_DUPLICATE_PARTICIPANT",
      400,
      "Each person can only be in a split once"
    );
  }

  // Resolve everyone before any writing, so a bad address fails before
  // a single request exists. One wording for "no such person" and "that
  // is you", as in Phase 7.
  const targets: { id: string; email: string }[] = [];
  for (const email of emails) {
    const user = await findUserByEmail(pool, email);
    if (!user || user.id === input.userId) {
      throw new BillSplitError(
        "BILL_SPLIT_INVALID_PARTICIPANT",
        400,
        `We couldn't add ${email} to this split`
      );
    }
    targets.push({ id: user.id, email: user.email });
  }

  const parts = targets.length + (includeOrganiser ? 1 : 0);
  let shares: number[];
  try {
    // Index 0 is the organiser when they're in it; the rest follow the
    // order the participants were given in.
    shares = shareOut(input.totalMinorUnits, parts, input.shareMinorUnits);
  } catch (err) {
    if (err instanceof SplitMathError) {
      throw new BillSplitError(err.code, 400, err.message);
    }
    throw err;
  }
  const organiserShare = includeOrganiser ? shares[0] : 0;
  const participantShares = includeOrganiser ? shares.slice(1) : shares;

  const client = await pool.connect();
  try {
    await client.query("begin");
    const created = await client.query<SplitRow>(
      `insert into bill_splits
         (created_by_user_id, total_minor_units, organiser_share_minor_units, purpose, method)
       values ($1, $2, $3, $4, $5)
       returning *`,
      [
        input.userId,
        input.totalMinorUnits,
        organiserShare,
        input.purpose ?? null,
        input.shareMinorUnits ? "custom" : "even",
      ]
    );
    const row = created.rows[0];

    const requests: OwnPaymentRequestView[] = [];
    for (const [i, target] of targets.entries()) {
      requests.push(
        await createPaymentRequestWithClient(client, {
          userId: input.userId,
          toUserId: target.id,
          amountMinorUnits: participantShares[i],
          purpose: input.purpose ?? null,
          expiresInMinutes: input.expiresInMinutes,
          billSplitId: row.id,
          // 0 is the organiser's own share, so the people asked start at 1.
          splitShareIndex: i + 1,
        })
      );
    }

    // Belt and braces: the shares we just wrote must add up to the
    // total. A cross-row sum is beyond a CHECK constraint, so it is
    // asserted here, inside the transaction that could still be undone.
    const askedFor = requests.reduce((sum, r) => sum + r.amountMinorUnits, 0);
    if (askedFor + organiserShare !== input.totalMinorUnits) {
      throw new BillSplitError(
        "SHARES_DO_NOT_ADD_UP",
        500,
        "The shares didn't add up to the total, so nothing was created"
      );
    }

    await recordAuditEvent(client, {
      eventType: "BILL_SPLIT_CREATED",
      actorUserId: input.userId,
      metadata: {
        billSplitId: row.id,
        totalMinorUnits: input.totalMinorUnits,
        method: row.method,
        people: parts,
        paymentRequestIds: requests.map((r) => r.id),
      },
    });

    await client.query("commit");
    return toView(pool, row, input.userId, requests);
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Everyone named on a split may look at it: the organiser and the people asked. */
export async function getBillSplitForUser(
  pool: Pool,
  userId: string,
  id: string
): Promise<BillSplitView> {
  const row = await loadSplit(pool, id);
  if (!row) throw notFound();
  const requests = await listPaymentRequestsForSplit(pool, id);
  const isParticipant = await userIsInSplit(pool, id, userId);
  if (row.created_by_user_id !== userId && !isParticipant) throw notFound();
  return toView(pool, row, userId, requests);
}

async function userIsInSplit(q: Queryable, splitId: string, userId: string): Promise<boolean> {
  const result = await q.query<{ one: number }>(
    `select 1 as one from payment_requests
     where bill_split_id = $1 and target_user_id = $2
     limit 1`,
    [splitId, userId]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Splits this person organised, newest first. */
export async function listBillSplitsForUser(
  pool: Pool,
  userId: string,
  limit = 20
): Promise<BillSplitView[]> {
  const result = await pool.query<SplitRow>(
    `select * from bill_splits
     where created_by_user_id = $1
     order by created_at desc
     limit $2`,
    [userId, limit]
  );
  const views: BillSplitView[] = [];
  for (const row of result.rows) views.push(await toView(pool, row, userId));
  return views;
}

/**
 * Calls off a split. Shares nobody has answered are cancelled with it;
 * anything already paid stays paid, and stays on the ledger.
 */
export async function cancelBillSplit(
  pool: Pool,
  userId: string,
  id: string
): Promise<BillSplitView> {
  const row = await loadSplit(pool, id);
  if (!row || row.created_by_user_id !== userId) throw notFound();

  const client: PoolClient = await pool.connect();
  try {
    await client.query("begin");
    const updated = await client.query<SplitRow>(
      `update bill_splits
       set status = 'CANCELLED', cancelled_at = now(), updated_at = now()
       where id = $1 and status = 'OPEN'
       returning *`,
      [id]
    );
    if (updated.rowCount === 0) {
      throw new BillSplitError(
        "BILL_SPLIT_NOT_OPEN",
        409,
        "This split has already been cancelled"
      );
    }
    const cancelledShares = await cancelPaymentRequestsForSplit(client, id, userId);
    await recordAuditEvent(client, {
      eventType: "BILL_SPLIT_CANCELLED",
      actorUserId: userId,
      metadata: { billSplitId: id, cancelledShares },
    });
    await client.query("commit");
    return toView(pool, updated.rows[0], userId);
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
