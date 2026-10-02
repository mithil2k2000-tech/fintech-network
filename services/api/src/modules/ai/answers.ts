// What the assistant knows, and what it says about it. Pure: the facts
// arrive already gathered (see facts.ts), and every answer is a template
// plus a set of Figures — never a sentence with a number baked into it.
//
// These templates are also the fallback. If a model is put behind the
// AssistantModel port and its draft fails validation, the answer the
// person gets is the one written here, so the worst case is plainer
// prose rather than a wrong number.
import type { AssistantDraft, Figures, Intent, Suggestion } from "./assistant.js";

/**
 * Only the parts the intent needs are gathered, so a missing key means
 * "not looked up" and an explicit null means "looked, nothing there".
 * Money is minor units throughout.
 */
export interface AssistantFacts {
  balanceMinorUnits?: number;
  waiting?: {
    count: number;
    totalMinorUnits: number;
    first: { from: string; amountMinorUnits: number } | null;
  };
  spending?: {
    days: number;
    totalMinorUnits: number;
    payments: number;
  };
  cashback?: {
    totalEarnedMinorUnits: number;
    rewardedPayments: number;
    ratePercent: number;
    minimumSpendMinorUnits: number;
    stage: string;
  };
  lastPayment?: {
    amountMinorUnits: number;
    who: string;
    receiptId: string | null;
  } | null;
  flagged?: {
    amountMinorUnits: number;
    who: string;
    level: "LOW" | "MEDIUM" | "HIGH";
    reasons: string[];
  } | null;
}

/** Said on every answer, so no client has to remember to say it. */
export const ASSISTANT_DISCLAIMER =
  "Figures come from your account, not from me. This is a prototype: the money is simulated, and nothing here is financial advice.";

const NUMBER_WORDS: Record<number, string> = {
  7: "seven",
  14: "fourteen",
  30: "thirty",
  90: "ninety",
};

const LEVEL_WORDS: Record<string, string> = {
  LOW: "worth a look",
  MEDIUM: "worth checking",
  HIGH: "unusual",
};

/**
 * Every value this answer may quote, by name. Built once, before the
 * text exists, which is what lets validation prove that the text quotes
 * nothing else.
 */
export function figuresFor(facts: AssistantFacts): Figures {
  const figures: Figures = {};

  if (facts.balanceMinorUnits !== undefined) {
    figures.balance = { kind: "money", minorUnits: facts.balanceMinorUnits };
  }

  if (facts.waiting) {
    figures.waitingCount = { kind: "count", value: facts.waiting.count };
    figures.waitingTotal = { kind: "money", minorUnits: facts.waiting.totalMinorUnits };
    if (facts.waiting.first) {
      figures.asker = { kind: "words", value: facts.waiting.first.from };
      figures.askedFor = { kind: "money", minorUnits: facts.waiting.first.amountMinorUnits };
    }
  }

  if (facts.spending) {
    figures.spent = { kind: "money", minorUnits: facts.spending.totalMinorUnits };
    figures.spentPayments = { kind: "count", value: facts.spending.payments };
    figures.period = {
      kind: "words",
      value: `${NUMBER_WORDS[facts.spending.days] ?? String(facts.spending.days)} days`,
    };
  }

  if (facts.cashback) {
    figures.earned = { kind: "money", minorUnits: facts.cashback.totalEarnedMinorUnits };
    figures.rewardedPayments = { kind: "count", value: facts.cashback.rewardedPayments };
    figures.rate = { kind: "percent", value: facts.cashback.ratePercent };
    figures.minimumSpend = { kind: "money", minorUnits: facts.cashback.minimumSpendMinorUnits };
    figures.stage = { kind: "words", value: facts.cashback.stage };
  }

  if (facts.lastPayment) {
    figures.lastAmount = { kind: "money", minorUnits: facts.lastPayment.amountMinorUnits };
    figures.lastPayee = { kind: "words", value: facts.lastPayment.who };
  }

  if (facts.flagged) {
    figures.flaggedAmount = { kind: "money", minorUnits: facts.flagged.amountMinorUnits };
    figures.flaggedPayee = { kind: "words", value: facts.flagged.who };
    figures.flaggedLevel = {
      kind: "words",
      value: LEVEL_WORDS[facts.flagged.level] ?? "unusual",
    };
    figures.flaggedReasons = {
      kind: "words",
      value: facts.flagged.reasons.join("; "),
    };
  }

  return figures;
}

/**
 * When the fact an answer needs isn't there. It shouldn't happen —
 * gatherFacts reads what the intent needs — but an answer about money
 * is the wrong place to render a sentence with a hole in it, so every
 * template below checks, and this is what it falls back to.
 */
function unavailable(where: string, suggestions: Suggestion[] = []): AssistantDraft {
  return {
    text: `I couldn't read that just now. It's on your ${where} screen, which is the same figure I'd be quoting.`,
    suggestions,
  };
}

const SEE_ACTIVITY: Suggestion = { label: "See your activity", path: "/activity" };
const SEE_REQUESTS: Suggestion = { label: "Open your requests", path: "/requests" };
const SEE_REWARDS: Suggestion = { label: "See your rewards", path: "/rewards" };
const GO_TO_PAY: Suggestion = { label: "Go to the payment screen", path: "/pay" };

/**
 * The plain answer for an intent. Note what none of these do: none of
 * them tell the person what they ought to do with their money, and the
 * ones about paying always hand the decision back.
 */
export function deterministicDraft(intent: Intent, facts: AssistantFacts): AssistantDraft {
  switch (intent) {
    case "BALANCE": {
      if (facts.balanceMinorUnits === undefined) return unavailable("home");
      const waiting = facts.waiting;
      if (waiting && waiting.count > 0) {
        return {
          text:
            "You have {{balance}} available. " +
            (waiting.count === 1
              ? "One request is waiting for you, for {{waitingTotal}}, and that hasn't come out of your balance yet."
              : "{{waitingCount}} requests are waiting for you, {{waitingTotal}} in total, and none of that has come out of your balance yet."),
          suggestions: [SEE_REQUESTS, SEE_ACTIVITY],
        };
      }
      return {
        text: "You have {{balance}} available.",
        suggestions: [SEE_ACTIVITY],
      };
    }

    case "SPENDING": {
      const spending = facts.spending;
      if (!spending) return unavailable("activity", [SEE_ACTIVITY]);
      if (spending.payments === 0) {
        return {
          text: "You haven't sent any payments in the last {{period}}.",
          suggestions: [SEE_ACTIVITY],
        };
      }
      return {
        text:
          spending.payments === 1
            ? "You've sent {{spent}} in the last {{period}}, in a single payment."
            : "You've sent {{spent}} in the last {{period}}, across {{spentPayments}} payments.",
        suggestions: [SEE_ACTIVITY],
      };
    }

    case "CASHBACK": {
      const cashback = facts.cashback;
      if (!cashback) return unavailable("rewards", [SEE_REWARDS]);
      if (cashback.totalEarnedMinorUnits === 0) {
        return {
          text:
            "You haven't earned any cashback yet. It's {{rate}} back when you pay a registered shop, " +
            "on anything over {{minimumSpend}}.",
          suggestions: [SEE_REWARDS],
        };
      }
      return {
        text:
          "You've earned {{earned}} in cashback, from {{rewardedPayments}} shop payments. " +
          "Your tree is at the {{stage}} stage.",
        suggestions: [SEE_REWARDS],
      };
    }

    case "WAITING_REQUESTS": {
      const waiting = facts.waiting;
      if (!waiting) return unavailable("requests", [SEE_REQUESTS]);
      if (waiting.count === 0) {
        return {
          text: "Nobody is asking you for money right now.",
          suggestions: [SEE_REQUESTS],
        };
      }
      if (waiting.count === 1 && waiting.first) {
        return {
          text:
            "{{asker}} has asked you for {{askedFor}}. Whether to pay it is yours to decide — " +
            "I can't pay it, and nothing happens until you confirm it yourself.",
          suggestions: [SEE_REQUESTS],
        };
      }
      return {
        text:
          "{{waitingCount}} requests are waiting for you, {{waitingTotal}} in total. " +
          "You decide which of them to pay; I can't pay any of them.",
        suggestions: [SEE_REQUESTS],
      };
    }

    case "RECENT_ACTIVITY": {
      const last = facts.lastPayment;
      if (last === undefined) return unavailable("activity", [SEE_ACTIVITY]);
      if (!last) {
        return {
          text: "There's nothing in your activity yet.",
          suggestions: [SEE_ACTIVITY],
        };
      }
      return {
        text: "Your most recent payment was {{lastAmount}} to {{lastPayee}}.",
        suggestions: last.receiptId
          ? [{ label: "Open that receipt", path: `/receipts/${last.receiptId}` }, SEE_ACTIVITY]
          : [SEE_ACTIVITY],
      };
    }

    case "EXPLAIN_WARNING": {
      const flagged = facts.flagged;
      if (flagged === undefined) return unavailable("activity", [SEE_ACTIVITY]);
      if (!flagged) {
        return {
          text:
            "None of your recent payments were flagged. When one is, the review screen tells you " +
            "what the checks noticed, and I can go through it with you.",
          suggestions: [SEE_ACTIVITY],
        };
      }
      return {
        text:
          "Your {{flaggedAmount}} payment to {{flaggedPayee}} was flagged as {{flaggedLevel}}. " +
          "What the checks noticed: {{flaggedReasons}}. Those are fixed rules about the payment, " +
          "not a judgement about the person — and the decision to go ahead was yours, not the checks'.",
        suggestions: [SEE_ACTIVITY],
      };
    }

    case "SAFETY":
      return {
        text:
          "If someone is pressuring you to pay right now, the pressure is itself the warning sign — " +
          "nobody legitimate needs money in the next five minutes. Stop, check who you're paying using " +
          "a number or address you already had rather than one they sent you, and pay later if it turns " +
          "out to be real. A payment that has gone through can't be pulled back. I can't tell you whether " +
          "a particular person is genuine, and I'd only be guessing if I tried.",
        suggestions: [],
      };

    case "CAPABILITIES":
      return {
        text:
          "I can tell you what's in your account, what you've spent, what cashback you've earned, " +
          "who's asking you for money, and why a payment was flagged. I can't move money, change " +
          "anything, or give financial advice — paying is something you do yourself, on the payment " +
          "screen, where you see the amount and who it's going to before anything moves.",
        suggestions: [],
      };

    case "MOVE_MONEY_REFUSED":
      return {
        text:
          "I can't send, cancel or refund money, and that's deliberate rather than a gap. " +
          "You can do it on the payment screen, where you'll see the amount and who it's going to, " +
          "and nothing moves until you confirm it.",
        suggestions: [GO_TO_PAY],
      };

    case "ADVICE_REFUSED":
      return {
        text:
          "I can't give financial advice. I'm not a financial adviser, and this prototype isn't a " +
          "regulated service — for a decision like that you want someone qualified. What I can do is " +
          "tell you plainly what your own account shows.",
        suggestions: [],
      };

    case "OTHER_PERSON_REFUSED":
      return {
        text:
          "I can only see your own account. Nobody else's balance, payments or details are " +
          "available to me, whoever is asking.",
        suggestions: [],
      };

    case "UNKNOWN":
    default:
      return {
        text:
          "I don't know how to answer that one. I can help with your balance, what you've spent, " +
          "your cashback, requests waiting for you, and why a payment was flagged.",
        suggestions: [],
      };
  }
}
