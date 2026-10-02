// Where the assistant's figures come from: the domain modules, through
// their own exported functions, always scoped to the person asking.
//
// Two properties of this file matter more than what it does:
//
//   * It is read-only. There is no import here that writes anything —
//     no postTransaction, no createPayment, no ledger client. The
//     assistant cannot move money because nothing it can reach does.
//   * It gathers by intent. The deterministic classifier decides which
//     question was asked, and only the facts that question needs are
//     read (spec §26 data minimisation). A model behind the port never
//     gets to widen the lookup, because by then the reading is done.
import type { Pool } from "pg";
import { getOrCreateAccountForOwner, getBalanceMinorUnits } from "../ledger/index.js";
import { listIncomingPaymentRequests } from "../paymentRequests/index.js";
import {
  findLastFlaggedPayment,
  findLastOutgoingPayment,
  sumOutgoingPaymentsSince,
} from "../payments/index.js";
import { getCashbackSummary, getRewardsTree } from "../rewards/index.js";
import type { Intent } from "./assistant.js";
import type { AssistantFacts } from "./answers.js";

/** The window "how much have I spent lately?" means. */
export const SPENDING_WINDOW_DAYS = 30;

async function balanceFor(pool: Pool, userId: string): Promise<number> {
  const account = await getOrCreateAccountForOwner(pool, "user", userId);
  return getBalanceMinorUnits(pool, account.id);
}

async function waitingFor(pool: Pool, userId: string): Promise<AssistantFacts["waiting"]> {
  const incoming = await listIncomingPaymentRequests(pool, userId);
  // OPEN is the stored status; a request past its expiry reads as
  // EXPIRED, so this is "still actually waiting on an answer".
  const open = incoming.filter((r) => r.status === "OPEN");
  const total = open.reduce((sum, r) => sum + r.amountMinorUnits, 0);
  return {
    count: open.length,
    totalMinorUnits: total,
    first: open[0]
      ? { from: open[0].requester.displayName, amountMinorUnits: open[0].amountMinorUnits }
      : null,
  };
}

function payeeName(who: string | null): string {
  return who ?? "someone no longer on the network";
}

/**
 * Everything the given intent needs, and nothing else. An intent that
 * needs no facts at all (a refusal, a safety answer) reads nothing.
 */
export async function gatherFacts(
  pool: Pool,
  userId: string,
  intent: Intent
): Promise<AssistantFacts> {
  switch (intent) {
    case "BALANCE": {
      // The balance alone would be misleading while someone is waiting
      // to be paid, so the requests waiting on them come with it.
      const [balanceMinorUnits, waiting] = await Promise.all([
        balanceFor(pool, userId),
        waitingFor(pool, userId),
      ]);
      return { balanceMinorUnits, waiting };
    }

    case "SPENDING": {
      const spending = await sumOutgoingPaymentsSince(pool, userId, SPENDING_WINDOW_DAYS);
      return {
        spending: {
          days: SPENDING_WINDOW_DAYS,
          totalMinorUnits: spending.totalMinorUnits,
          payments: spending.payments,
        },
      };
    }

    case "CASHBACK": {
      const [summary, tree] = await Promise.all([
        getCashbackSummary(pool, userId),
        getRewardsTree(pool, userId),
      ]);
      return {
        cashback: {
          totalEarnedMinorUnits: summary.totalEarnedMinorUnits,
          rewardedPayments: tree.rewardedPayments,
          ratePercent: summary.offer.ratePercent,
          minimumSpendMinorUnits: summary.offer.minimumSpendMinorUnits,
          stage: tree.stage.name,
        },
      };
    }

    case "WAITING_REQUESTS":
      return { waiting: await waitingFor(pool, userId) };

    case "RECENT_ACTIVITY": {
      const last = await findLastOutgoingPayment(pool, userId);
      return {
        lastPayment: last
          ? {
              amountMinorUnits: last.amountMinorUnits,
              who: payeeName(last.counterparty.displayName),
              receiptId: last.receiptId,
            }
          : null,
      };
    }

    case "EXPLAIN_WARNING": {
      const flagged = await findLastFlaggedPayment(pool, userId);
      return {
        flagged:
          flagged && flagged.risk.level
            ? {
                amountMinorUnits: flagged.amountMinorUnits,
                who: payeeName(flagged.counterparty.displayName),
                level: flagged.risk.level,
                // The reasons are the ones the payer was shown at the
                // time, stored on the payment. The assistant repeats
                // them; it doesn't re-judge the payment.
                reasons: flagged.risk.reasons,
              }
            : null,
      };
    }

    case "SAFETY":
    case "CAPABILITIES":
    case "MOVE_MONEY_REFUSED":
    case "ADVICE_REFUSED":
    case "OTHER_PERSON_REFUSED":
    case "UNKNOWN":
    default:
      return {};
  }
}
