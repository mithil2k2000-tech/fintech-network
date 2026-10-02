// Domain module: ai — the assistant (spec §13).
//
// It answers questions about the person's own account. It explains what
// the risk checks noticed. It points at screens. It does not decide
// anything, move anything, or add anything up.
//
// The order of operations in `askAssistant` is the design:
//
//   classify (rules)  ->  gather (read-only, scoped to the asker)
//                     ->  draft (words only)
//                     ->  validate (no loose figures, no invented names)
//                     ->  render (values substituted by us)
//                     ->  audit (intent only, never the question)
//
// Each step can only narrow what the next one is able to do.
import type { Pool } from "pg";
import { recordAuditEvent } from "../audit/index.js";
import {
  ASSISTANT_RULES_VERSION,
  AssistantTextError,
  MAX_QUESTION_LENGTH,
  classify,
  placeholdersIn,
  renderAnswer,
  validateDraft,
  type Figures,
  type Intent,
  type Suggestion,
} from "./assistant.js";
import { ASSISTANT_DISCLAIMER, deterministicDraft, figuresFor } from "./answers.js";
import { gatherFacts, SPENDING_WINDOW_DAYS } from "./facts.js";
import { DeterministicAssistant, type AssistantModel } from "./model.js";

export const MODULE_NAME = "ai" as const;

export { ASSISTANT_RULES_VERSION, MAX_QUESTION_LENGTH } from "./assistant.js";
export { SPENDING_WINDOW_DAYS } from "./facts.js";
export { ASSISTANT_DISCLAIMER } from "./answers.js";
export { DeterministicAssistant } from "./model.js";
export type { AssistantModel, AssistantContext } from "./model.js";
export type { AssistantFacts } from "./answers.js";
export type { Intent, Figure, Figures, Suggestion } from "./assistant.js";

/** What the person gets back. */
export interface AssistantAnswer {
  /** The rendered text. Every figure in it was substituted by the API. */
  answer: string;
  /** Which question the rules decided this was. */
  intent: Intent;
  /**
   * The figures quoted, with the value and how it was displayed, so a
   * client (or a person reading the logs) can check the text against
   * the numbers rather than trusting the sentence.
   */
  figures: { name: string; display: string; minorUnits?: number }[];
  /** Screens the person can go to. Nothing here happens on its own. */
  suggestions: Suggestion[];
  /** Said every time. */
  disclaimer: string;
  /** Which model wrote the words, and which rule set classified. */
  provenance: { model: string; rules: string };
}

export interface AssistantDeps {
  pool: Pool;
  model?: AssistantModel;
}

export interface AskAssistantInput {
  userId: string;
  question: string;
}

export class AssistantQuestionError extends Error {}

function quotedNames(text: string): string[] {
  return [...new Set(placeholdersIn(text))];
}

function quotedFigures(text: string, figures: Figures): AssistantAnswer["figures"] {
  return quotedNames(text).map((name) => {
    const figure = figures[name];
    return {
      name,
      display: renderAnswer(`{{${name}}}`, figures),
      ...(figure.kind === "money" ? { minorUnits: figure.minorUnits } : {}),
    };
  });
}

export async function askAssistant(
  deps: AssistantDeps,
  input: AskAssistantInput
): Promise<AssistantAnswer> {
  const question = input.question.trim();
  if (question.length === 0) {
    throw new AssistantQuestionError("Ask a question.");
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    throw new AssistantQuestionError("That question is too long.");
  }

  const model = deps.model ?? new DeterministicAssistant();
  const intent = classify(question);
  const facts = await gatherFacts(deps.pool, input.userId, intent);
  const figures = figuresFor(facts);

  let draft = await model.draft({ question, intent, figures, facts });
  let modelName = model.name;
  try {
    validateDraft(draft, figures);
  } catch (err) {
    if (!(err instanceof AssistantTextError)) throw err;
    // A draft that quotes a figure we didn't give it, or writes a
    // number of its own, is not shown to anyone. The plain answer goes
    // out instead, and the rejection is on file.
    draft = deterministicDraft(intent, facts);
    modelName = `${model.name} (rejected, fell back)`;
    await recordAuditEvent(deps.pool, {
      eventType: "ASSISTANT_DRAFT_REJECTED",
      actorUserId: input.userId,
      metadata: { intent, model: model.name, reason: err.message },
    }).catch(() => undefined);
    validateDraft(draft, figures);
  }

  const answer = renderAnswer(draft.text, figures);

  // What's recorded: that a question of this kind was asked, and which
  // figures went into the answer. Not the question, not the answer —
  // a transcript of what someone asked about their own money is data
  // nobody needs to keep, so this prototype doesn't keep it (§26).
  await recordAuditEvent(deps.pool, {
    eventType: "ASSISTANT_QUERY",
    actorUserId: input.userId,
    metadata: {
      intent,
      model: modelName,
      rules: ASSISTANT_RULES_VERSION,
      figuresQuoted: quotedNames(draft.text),
    },
  }).catch(() => undefined);

  return {
    answer,
    intent,
    figures: quotedFigures(draft.text, figures),
    suggestions: draft.suggestions,
    disclaimer: ASSISTANT_DISCLAIMER,
    provenance: { model: modelName, rules: ASSISTANT_RULES_VERSION },
  };
}

/**
 * What the assistant will and won't do, in its own words, for the app to
 * show before anyone has asked anything. The examples double as the
 * suggested questions on the screen, so what's offered is always
 * something the classifier actually recognises.
 */
export function assistantCapabilities() {
  return {
    can: [
      "Tell you your balance and what's waiting for you",
      `Add up what you've sent over the last ${SPENDING_WINDOW_DAYS} days`,
      "Tell you what cashback you've earned",
      "Explain why a payment was flagged",
      "Talk through whether something looks like a scam",
    ],
    cannot: [
      "Send, cancel or refund money — only you can do that",
      "Give financial advice",
      "See anyone else's account",
      "Change anything at all",
    ],
    examples: [
      "What's my balance?",
      "How much have I spent recently?",
      "How much cashback have I earned?",
      "Who's asking me for money?",
      "Why was my payment flagged?",
    ],
    disclaimer: ASSISTANT_DISCLAIMER,
  };
}
