// Transaction history ("Activity", spec §16) — a read-only view that
// COMPOSES other modules rather than owning any data:
//   ledger   -> what moved, and the running balance (source of truth)
//   payments -> who it was with and what it was for
//   receipts -> the receipt to open
// Because it only calls those modules' exported functions, any of them
// can change internally without this file changing, and new kinds of
// money movement (refunds, cashback) show up here automatically once
// they post to the ledger.
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { MinorUnits } from "@fintech-network/shared-types";
import { authenticate } from "../modules/identity/middleware.js";
import {
  getOrCreateAccountForOwner,
  listAccountHistory,
  type HistoryCursor,
  type TransactionKind,
} from "../modules/ledger/index.js";
import {
  findPaymentsByTransactionIds,
  findPaymentsByTransactionIdsForMerchant,
  type PaymentView,
} from "../modules/payments/index.js";
import { MerchantError, requireMembership } from "../modules/merchants/index.js";
import { idParamsSchema, isUuid, parseLimit } from "../shared/validation.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export interface ActivityItem {
  id: string;
  transactionId: string;
  kind: TransactionKind;
  direction: "in" | "out";
  amountMinorUnits: MinorUnits;
  balanceAfterMinorUnits: MinorUnits;
  occurredAt: string;
  /** What the list shows as the main line: a person, or a plain label. */
  title: string;
  purpose: string | null;
  paymentId: string | null;
  receiptId: string | null;
}

const KIND_TITLES: Partial<Record<TransactionKind, string>> = {
  seed: "Starting balance",
  adjustment: "Balance adjustment",
  cashback: "Cashback",
};

// Cursors are opaque to clients: base64url of the last item's position.
export function encodeCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify([cursor.occurredAt, cursor.entryId])).toString(
    "base64url"
  );
}

export function decodeCursor(raw: string): HistoryCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [occurredAt, entryId] = parsed;
    if (typeof occurredAt !== "string" || Number.isNaN(Date.parse(occurredAt))) return null;
    if (!isUuid(entryId)) return null;
    return { occurredAt, entryId };
  } catch {
    return null;
  }
}

const querySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "string", pattern: "^[0-9]{1,3}$" },
    cursor: { type: "string", maxLength: 200 },
  },
} as const;

/**
 * One page of an account's history, whoever owns it. The only thing
 * that differs between a person's activity and a shop's takings is
 * which account is read and which payments the viewer may see, so both
 * are passed in and everything else is shared.
 */
async function buildActivityPage(
  pool: Pool,
  options: {
    accountId: string;
    limit: number;
    before?: HistoryCursor;
    lookupPayments: (transactionIds: string[]) => Promise<Map<string, PaymentView>>;
  }
): Promise<{ items: ActivityItem[]; nextCursor: string | null }> {
  // Fetch one extra to know whether there's another page.
  const entries = await listAccountHistory(pool, options.accountId, {
    limit: options.limit + 1,
    before: options.before,
  });
  const page = entries.slice(0, options.limit);
  const hasMore = entries.length > options.limit;

  const payments = await options.lookupPayments(page.map((e) => e.transactionId));

  const items: ActivityItem[] = page.map((entry) => {
    const payment = payments.get(entry.transactionId) ?? null;
    return {
      id: entry.entryId,
      transactionId: entry.transactionId,
      kind: entry.transactionKind,
      direction: entry.direction === "credit" ? "in" : "out",
      amountMinorUnits: entry.amountMinorUnits,
      balanceAfterMinorUnits: entry.balanceAfterMinorUnits,
      occurredAt: entry.occurredAt,
      // Never show raw ledger descriptions for payments; they hold ids.
      title:
        payment?.counterparty.displayName ??
        KIND_TITLES[entry.transactionKind] ??
        "Transaction",
      purpose: payment?.purpose ?? null,
      paymentId: payment?.id ?? null,
      receiptId: payment?.receiptId ?? null,
    };
  });

  const last = page[page.length - 1];
  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ occurredAt: last.occurredAt, entryId: last.entryId })
        : null,
  };
}

export async function transactionsRoutes(app: FastifyInstance, opts: { pool: Pool }) {
  const { pool } = opts;

  /** Reads limit and cursor, or returns the error reply for a bad cursor. */
  function readPaging(request: {
    query: unknown;
    id: string;
  }): { limit: number; before?: HistoryCursor } | { badCursor: true } {
    const query = request.query as { limit?: string; cursor?: string };
    const limit = parseLimit(query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    if (query.cursor === undefined) return { limit };
    const decoded = decodeCursor(query.cursor);
    if (!decoded) return { badCursor: true };
    return { limit, before: decoded };
  }

  const invalidCursor = (reply: import("fastify").FastifyReply, requestId: string) =>
    reply.status(400).send({
      code: "INVALID_CURSOR",
      message: "That page cursor isn't valid",
      requestId,
    });

  app.get(
    "/api/v1/transactions",
    { onRequest: authenticate, schema: { querystring: querySchema } },
    async (request, reply) => {
      const userId = request.user!.sub;
      const paging = readPaging(request);
      if ("badCursor" in paging) return invalidCursor(reply, request.id);

      const account = await getOrCreateAccountForOwner(pool, "user", userId);
      const page = await buildActivityPage(pool, {
        accountId: account.id,
        limit: paging.limit,
        before: paging.before,
        lookupPayments: (ids) => findPaymentsByTransactionIds(pool, userId, ids),
      });
      return reply.send(page);
    }
  );

  // A shop's takings: the same view of the same ledger, for the account
  // a merchant owns. Lives here rather than in the merchants module
  // because it composes ledger + payments + receipts and owns no data.
  app.get(
    "/api/v1/merchants/:id/activity",
    {
      onRequest: authenticate,
      schema: { params: idParamsSchema, querystring: querySchema },
    },
    async (request, reply) => {
      const { id: merchantId } = request.params as { id: string };
      const userId = request.user!.sub;
      const paging = readPaging(request);
      if ("badCursor" in paging) return invalidCursor(reply, request.id);

      try {
        await requireMembership(pool, merchantId, userId);
      } catch (err) {
        if (err instanceof MerchantError) {
          return reply.status(err.httpStatus).send({
            code: err.code,
            message: err.message,
            requestId: request.id,
          });
        }
        throw err;
      }

      const account = await getOrCreateAccountForOwner(pool, "merchant", merchantId);
      const page = await buildActivityPage(pool, {
        accountId: account.id,
        limit: paging.limit,
        before: paging.before,
        lookupPayments: (ids) =>
          findPaymentsByTransactionIdsForMerchant(pool, merchantId, ids),
      });
      return reply.send(page);
    }
  );
}
