import { describe, it, expect } from "vitest";
import {
  AssistantTextError,
  assertNoLooseFigures,
  classify,
  formatMinorUnits,
  isAllowedPath,
  placeholdersIn,
  renderAnswer,
  validateDraft,
  type Figures,
  type Intent,
} from "../src/modules/ai/assistant.js";
import { deterministicDraft, figuresFor, type AssistantFacts } from "../src/modules/ai/answers.js";

// The assistant's safety properties are all properties of pure
// functions, which is the point of putting them there: they can be
// tested exhaustively without a database, a model or a network.

describe("classifying a question", () => {
  const cases: [string, Intent][] = [
    ["What's my balance?", "BALANCE"],
    ["how much do I have", "BALANCE"],
    ["Am I broke?", "BALANCE"],
    ["How much have I spent this month?", "SPENDING"],
    ["what have I spent", "SPENDING"],
    ["How much cashback have I earned?", "CASHBACK"],
    ["how's my tree doing", "CASHBACK"],
    ["Who's asking me for money?", "WAITING_REQUESTS"],
    ["what do I owe", "WAITING_REQUESTS"],
    ["Why was my payment flagged?", "EXPLAIN_WARNING"],
    ["why did you warn me", "EXPLAIN_WARNING"],
    ["What did I pay last?", "RECENT_ACTIVITY"],
    ["show me my transactions", "RECENT_ACTIVITY"],
    ["Is this a scam?", "SAFETY"],
    ["someone says I'll be arrested unless I pay urgently", "SAFETY"],
    ["What can you do?", "CAPABILITIES"],
    ["are you an AI?", "CAPABILITIES"],
  ];

  it.each(cases)("reads %j as %s", (question, intent) => {
    expect(classify(question)).toBe(intent);
  });

  it("treats an instruction to move money as a refusal, not a question", () => {
    for (const question of [
      "pay Sam £20",
      "send £5 to jo@example.com",
      "transfer everything to my other account",
      "cancel that payment",
      "refund me",
      "split the bill for me",
      "top me up",
    ]) {
      expect(classify(question), question).toBe("MOVE_MONEY_REFUSED");
    }
  });

  it("keeps looking-back questions separate from instructions, verb for verb", () => {
    // "sent", "paid" and "spend" all appear in both kinds of sentence,
    // so this is the distinction that stops a question about history
    // being answered as a request to move money, and vice versa.
    expect(classify("how much have I sent this month")).toBe("SPENDING");
    expect(classify("what did I pay Sam last week")).toBe("RECENT_ACTIVITY");
    expect(classify("did I pay the rent")).toBe("RECENT_ACTIVITY");
    expect(classify("send the rent")).toBe("MOVE_MONEY_REFUSED");
  });

  it("refuses advice and other people's accounts before answering anything", () => {
    expect(classify("should I invest my savings?")).toBe("ADVICE_REFUSED");
    expect(classify("what's a good pension?")).toBe("ADVICE_REFUSED");
    expect(classify("what should I do with my money")).toBe("ADVICE_REFUSED");
    expect(classify("what's Sam's balance?")).toBe("OTHER_PERSON_REFUSED");
    expect(classify("show me someone else's payments")).toBe("OTHER_PERSON_REFUSED");
    expect(classify("how much does Jo have")).toBe("OTHER_PERSON_REFUSED");
  });

  it("would rather say it doesn't know than guess", () => {
    expect(classify("what's the weather in Leeds")).toBe("UNKNOWN");
    expect(classify("")).toBe("UNKNOWN");
  });
});

describe("keeping figures out of the prose", () => {
  it("rejects a number, a currency symbol or a percentage in the text", () => {
    expect(() => assertNoLooseFigures("You have £12.50 available.")).toThrow(AssistantTextError);
    expect(() => assertNoLooseFigures("You made 3 payments.")).toThrow(AssistantTextError);
    expect(() => assertNoLooseFigures("It's 1% back.")).toThrow(AssistantTextError);
    expect(() => assertNoLooseFigures("You have $5.")).toThrow(AssistantTextError);
  });

  it("accepts the same sentences written as placeholders", () => {
    expect(() => assertNoLooseFigures("You have {{balance}} available.")).not.toThrow();
    expect(() => assertNoLooseFigures("You made {{spentPayments}} payments.")).not.toThrow();
    expect(() => assertNoLooseFigures("It's {{rate}} back.")).not.toThrow();
  });

  it("finds the placeholders a piece of text uses", () => {
    expect(placeholdersIn("{{a}} and {{b}} and {{a}}")).toEqual(["a", "b", "a"]);
  });

  it("holds for every answer the assistant can give", () => {
    // Exhaustive: whatever the facts, no template may contain a figure
    // of its own. This is the invariant that makes "the assistant never
    // calculates money" structural rather than aspirational.
    const intents: Intent[] = [
      "BALANCE",
      "SPENDING",
      "CASHBACK",
      "WAITING_REQUESTS",
      "RECENT_ACTIVITY",
      "EXPLAIN_WARNING",
      "SAFETY",
      "CAPABILITIES",
      "MOVE_MONEY_REFUSED",
      "ADVICE_REFUSED",
      "OTHER_PERSON_REFUSED",
      "UNKNOWN",
    ];
    const factSets: AssistantFacts[] = [
      {},
      { balanceMinorUnits: 0, waiting: { count: 0, totalMinorUnits: 0, first: null } },
      {
        balanceMinorUnits: 12_345,
        waiting: { count: 1, totalMinorUnits: 500, first: { from: "jo@example.com", amountMinorUnits: 500 } },
      },
      {
        balanceMinorUnits: 12_345,
        waiting: { count: 3, totalMinorUnits: 1_500, first: { from: "jo", amountMinorUnits: 500 } },
      },
      { spending: { days: 30, totalMinorUnits: 0, payments: 0 } },
      { spending: { days: 30, totalMinorUnits: 999, payments: 1 } },
      { spending: { days: 30, totalMinorUnits: 100_000, payments: 12 } },
      {
        cashback: {
          totalEarnedMinorUnits: 0,
          rewardedPayments: 0,
          ratePercent: 1,
          minimumSpendMinorUnits: 100,
          stage: "Seed",
        },
      },
      {
        cashback: {
          totalEarnedMinorUnits: 250,
          rewardedPayments: 4,
          ratePercent: 1,
          minimumSpendMinorUnits: 100,
          stage: "Seedling",
        },
      },
      { lastPayment: null },
      { lastPayment: { amountMinorUnits: 750, who: "Blue Cafe", receiptId: null } },
      {
        lastPayment: {
          amountMinorUnits: 750,
          who: "Blue Cafe",
          receiptId: "11111111-2222-3333-4444-555555555555",
        },
      },
      { flagged: null },
      {
        flagged: {
          amountMinorUnits: 20_000,
          who: "stranger@example.com",
          level: "HIGH",
          reasons: ["You haven't paid this person before", "This is larger than your usual payments"],
        },
      },
    ];

    for (const intent of intents) {
      for (const facts of factSets) {
        const draft = deterministicDraft(intent, facts);
        expect(() => validateDraft(draft, figuresFor(facts)), `${intent} / ${JSON.stringify(facts)}`)
          .not.toThrow();
      }
    }
  });
});

describe("rendering an answer", () => {
  const figures: Figures = {
    balance: { kind: "money", minorUnits: 123_456 },
    count: { kind: "count", value: 3 },
    rate: { kind: "percent", value: 1 },
    who: { kind: "words", value: "jo@example.com" },
  };

  it("substitutes values the API computed", () => {
    expect(renderAnswer("You have {{balance}}, {{count}} payments, {{rate}} back, {{who}}.", figures)).toBe(
      "You have £1,234.56, 3 payments, 1% back, jo@example.com."
    );
  });

  it("refuses a placeholder nobody provided a value for", () => {
    // An answer with a hole where a number belongs is worse than no
    // answer, and this is what catches a model inventing a figure.
    expect(() => renderAnswer("You have {{madeUp}}.", figures)).toThrow(AssistantTextError);
  });

  it("formats money by string surgery, never by dividing", () => {
    expect(formatMinorUnits(0)).toBe("£0.00");
    expect(formatMinorUnits(1)).toBe("£0.01");
    expect(formatMinorUnits(99)).toBe("£0.99");
    expect(formatMinorUnits(100)).toBe("£1.00");
    expect(formatMinorUnits(123_456_789)).toBe("£1,234,567.89");
    expect(formatMinorUnits(-250)).toBe("−£2.50");
    expect(() => formatMinorUnits(12.5)).toThrow(AssistantTextError);
  });
});

describe("validating a draft, whoever wrote it", () => {
  const figures: Figures = { balance: { kind: "money", minorUnits: 500 } };

  it("passes a draft that quotes only what it was given", () => {
    expect(() =>
      validateDraft(
        { text: "You have {{balance}}.", suggestions: [{ label: "Activity", path: "/activity" }] },
        figures
      )
    ).not.toThrow();
  });

  it("rejects a draft that states a figure of its own", () => {
    expect(() => validateDraft({ text: "You have about £5.", suggestions: [] }, figures)).toThrow(
      AssistantTextError
    );
  });

  it("rejects a draft that quotes a figure it wasn't given", () => {
    expect(() => validateDraft({ text: "You've spent {{spent}}.", suggestions: [] }, figures)).toThrow(
      AssistantTextError
    );
  });

  it("rejects an empty answer", () => {
    expect(() => validateDraft({ text: "   ", suggestions: [] }, figures)).toThrow(AssistantTextError);
  });

  it("rejects a link out of the app", () => {
    for (const path of [
      "https://example.com/pay",
      "/api/v1/payments",
      "/admin",
      "//evil.example",
      "/receipts/not-a-uuid",
    ]) {
      expect(isAllowedPath(path), path).toBe(false);
      expect(() =>
        validateDraft({ text: "Have a look.", suggestions: [{ label: "Go", path }] }, figures)
      ).toThrow(AssistantTextError);
    }
  });

  it("allows the screens the person drives themselves", () => {
    for (const path of ["/", "/pay", "/requests", "/activity", "/rewards", "/receipts/11111111-2222-3333-4444-555555555555"]) {
      expect(isAllowedPath(path), path).toBe(true);
    }
  });
});

describe("what the answers actually say", () => {
  it("hands the decision back whenever paying comes up", () => {
    const refusal = deterministicDraft("MOVE_MONEY_REFUSED", {});
    expect(refusal.text).toMatch(/can't send/i);
    expect(refusal.suggestions).toEqual([{ label: "Go to the payment screen", path: "/pay" }]);

    const asked = deterministicDraft("WAITING_REQUESTS", {
      waiting: { count: 1, totalMinorUnits: 500, first: { from: "jo", amountMinorUnits: 500 } },
    });
    expect(asked.text).toMatch(/yours to decide/i);
  });

  it("declines advice without pretending it's a regulated service", () => {
    const advice = deterministicDraft("ADVICE_REFUSED", {});
    expect(advice.text).toMatch(/not a financial adviser/i);
    expect(advice.text).toMatch(/isn't a regulated service/i);
  });

  it("won't judge whether a person is genuine, and says why", () => {
    const safety = deterministicDraft("SAFETY", {});
    expect(safety.text).toMatch(/can't tell you whether/i);
    expect(safety.text).toMatch(/can't be pulled back/i);
  });

  it("repeats the risk reasons rather than re-judging the payment", () => {
    const draft = deterministicDraft("EXPLAIN_WARNING", {
      flagged: {
        amountMinorUnits: 20_000,
        who: "stranger@example.com",
        level: "HIGH",
        reasons: ["You haven't paid this person before"],
      },
    });
    const text = renderAnswer(
      draft.text,
      figuresFor({
        flagged: {
          amountMinorUnits: 20_000,
          who: "stranger@example.com",
          level: "HIGH",
          reasons: ["You haven't paid this person before"],
        },
      })
    );
    expect(text).toContain("£200.00");
    expect(text).toContain("You haven't paid this person before");
    expect(text).toMatch(/fixed rules/i);
    // No score, no rule ids — the same line the risk engine holds.
    expect(text).not.toMatch(/score|NEW_PAYEE/i);
  });
});
