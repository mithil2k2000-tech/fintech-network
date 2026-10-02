// Domain module: rewards — cashback, for now.
//
// The only writer to `cashback_grants`. It moves money the way every
// other module does: by asking the ledger to post a balanced
// transaction, funded from a `cashback_reserve` system account, so the
// books still balance and cashback never appears from nowhere.
//
// It hangs off the payments completion hook built in Phase 6, which
// means it runs inside the transaction that completes the payment and
// nothing about the payment flow had to change to make room for it.
//
// One rule above all: **a reward must never cost someone a payment.**
// The hook therefore does its work inside a SAVEPOINT and, if anything
// at all goes wrong, rolls back to it and lets the payment finish
// without cashback, leaving an audit event behind. A bug in a perk is
// not allowed to fail a person's money.
import type { Pool, PoolClient } from "pg";
import type { MinorUnits } from "@fintech-network/shared-types";
import type { Queryable } from "../../db.js";
import { recordAuditEvent } from "../audit/index.js";
import {
  getOrCreateAccountForOwner,
  getOrCreateSystemAccount,
  postTransactionWithClient,
} from "../ledger/index.js";
import type { PaymentCompletionHook } from "../payments/index.js";
import { CASHBACK_V1, cashbackFor, type CashbackRule } from "./rules.js";
import { growTree, type RewardsTree } from "./tree.js";

export const MODULE_NAME = "rewards" as const;
export { CASHBACK_V1, cashbackFor } from "./rules.js";
export type { CashbackAward, CashbackInput, CashbackRule } from "./rules.js";
export { MAX_LEAVES, TREE_STAGES, growTree } from "./tree.js";
export type { RewardsTree, TreeStage } from "./tree.js";

/** Where cashback is funded from. Its balance goes negative: that is the cost. */
export const CASHBACK_RESERVE_ACCOUNT = "cashback_reserve";

interface GrantRow {
  id: string;
  payment_id: string;
  user_id: string;
  transaction_id: string;
  amount_minor_units: string;
  spend_minor_units: string;
  rate_basis_points: number;
  rule: string;
  created_at: Date;
}

export interface CashbackGrantView {
  id: string;
  paymentId: string;
  amountMinorUnits: MinorUnits;
  spendMinorUnits: MinorUnits;
  ratePercent: number;
  rule: string;
  earnedAt: string;
}

export interface CashbackSummaryView {
  totalEarnedMinorUnits: MinorUnits;
  currency: "GBP";
  grants: CashbackGrantView[];
  /** What's on offer right now, so the app never hard-codes the rate. */
  offer: {
    ratePercent: number;
    minimumSpendMinorUnits: MinorUnits;
    maximumAwardMinorUnits: MinorUnits;
    appliesTo: "merchant_payments";
  };
}

function toView(row: GrantRow): CashbackGrantView {
  return {
    id: row.id,
    paymentId: row.payment_id,
    amountMinorUnits: Number(row.amount_minor_units),
    spendMinorUnits: Number(row.spend_minor_units),
    ratePercent: row.rate_basis_points / 100,
    rule: row.rule,
    earnedAt: row.created_at.toISOString(),
  };
}

/**
 * Grants the cashback a completed payment earned, inside the payment's
 * own transaction. Returns what was granted, or null when the rule says
 * nothing is owed. Throws only if the caller's transaction is already
 * broken — see `grantCashback`, which is what actually runs in the hook
 * and never lets an error escape.
 */
export async function grantCashbackWithClient(
  client: PoolClient,
  payment: {
    paymentId: string;
    payerUserId: string;
    payeeOwnerType: "user" | "merchant";
    amountMinorUnits: MinorUnits;
  },
  rule: CashbackRule = CASHBACK_V1
): Promise<CashbackGrantView | null> {
  const award = cashbackFor(
    { amountMinorUnits: payment.amountMinorUnits, payeeOwnerType: payment.payeeOwnerType },
    rule
  );
  if (!award) return null;

  const reserve = await getOrCreateSystemAccount(client, CASHBACK_RESERVE_ACCOUNT);
  const earner = await getOrCreateAccountForOwner(client, "user", payment.payerUserId);

  const posted = await postTransactionWithClient(client, {
    description: `Cashback for payment ${payment.paymentId}`,
    kind: "cashback",
    entries: [
      { accountId: reserve.id, direction: "debit", amountMinorUnits: award.amountMinorUnits },
      { accountId: earner.id, direction: "credit", amountMinorUnits: award.amountMinorUnits },
    ],
  });

  const inserted = await client.query<GrantRow>(
    `insert into cashback_grants
       (payment_id, user_id, transaction_id, amount_minor_units,
        spend_minor_units, rate_basis_points, rule)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning *`,
    [
      payment.paymentId,
      payment.payerUserId,
      posted.transactionId,
      award.amountMinorUnits,
      payment.amountMinorUnits,
      award.rateBasisPoints,
      award.rule,
    ]
  );

  await recordAuditEvent(client, {
    eventType: "CASHBACK_GRANTED",
    actorUserId: payment.payerUserId,
    metadata: {
      paymentId: payment.paymentId,
      amountMinorUnits: award.amountMinorUnits,
      rule: award.rule,
    },
  });

  return toView(inserted.rows[0]);
}

/**
 * The completion hook. Registered in `buildApp` alongside the payment
 * request hook, so cashback needed no change to the payment flow.
 *
 * Everything it does happens between a SAVEPOINT and its release. If
 * anything fails — a bad rule, a constraint, a reserve problem — it
 * rolls back to the savepoint and returns quietly, so the payment
 * completes exactly as it would have without cashback. The failure is
 * audited rather than swallowed, because someone is owed an explanation
 * (and possibly a penny).
 */
export const grantCashback: PaymentCompletionHook = async (client, payment) => {
  await client.query("savepoint cashback");
  try {
    await grantCashbackWithClient(client, {
      paymentId: payment.paymentId,
      payerUserId: payment.payerUserId,
      payeeOwnerType: payment.payeeOwnerType,
      amountMinorUnits: payment.amountMinorUnits,
    });
    await client.query("release savepoint cashback");
  } catch (err) {
    await client.query("rollback to savepoint cashback");
    // The payment is still fine; only the reward was lost.
    await recordAuditEvent(client, {
      eventType: "CASHBACK_FAILED",
      actorUserId: payment.payerUserId,
      metadata: {
        paymentId: payment.paymentId,
        reason: err instanceof Error ? err.message : "unknown",
      },
    }).catch(() => undefined);
  }
};

export async function getCashbackSummary(
  q: Queryable,
  userId: string,
  limit = 20
): Promise<CashbackSummaryView> {
  const total = await q.query<{ total: string }>(
    `select coalesce(sum(amount_minor_units), 0)::text as total
     from cashback_grants where user_id = $1`,
    [userId]
  );
  const grants = await q.query<GrantRow>(
    `select * from cashback_grants
     where user_id = $1
     order by created_at desc
     limit $2`,
    [userId, limit]
  );
  return {
    totalEarnedMinorUnits: Number(total.rows[0].total),
    currency: "GBP",
    grants: grants.rows.map(toView),
    offer: {
      ratePercent: CASHBACK_V1.rateBasisPoints / 100,
      minimumSpendMinorUnits: CASHBACK_V1.minimumSpendMinorUnits,
      maximumAwardMinorUnits: CASHBACK_V1.maximumAwardMinorUnits,
      appliesTo: "merchant_payments",
    },
  };
}

export interface RewardsTreeView extends RewardsTree {
  currency: "GBP";
  /** Said here, not in the app, so every client repeats the same thing. */
  disclaimer: string;
}

/**
 * The tree, grown from what's already in `cashback_grants`. Nothing is
 * stored: totals are counted at read time, so the tree and the ledger
 * can never disagree.
 */
export async function getRewardsTree(
  q: Queryable,
  userId: string
): Promise<RewardsTreeView> {
  const result = await q.query<{ total: string; payments: string }>(
    `select coalesce(sum(amount_minor_units), 0)::text as total,
            count(*)::text as payments
     from cashback_grants where user_id = $1`,
    [userId]
  );
  const tree = growTree({
    totalEarnedMinorUnits: Number(result.rows[0].total),
    rewardedPayments: Number(result.rows[0].payments),
  });
  return {
    ...tree,
    currency: "GBP",
    disclaimer:
      "Your tree is a picture of the cashback you've earned. No real tree is planted.",
  };
}

/** For tests and admin tooling: what the reserve has paid out. */
export async function getCashbackPaidOut(pool: Pool): Promise<MinorUnits> {
  const result = await pool.query<{ total: string }>(
    `select coalesce(sum(amount_minor_units), 0)::text as total from cashback_grants`
  );
  return Number(result.rows[0].total);
}
