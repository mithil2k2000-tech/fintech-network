// The seam a language model plugs into — and the shape of that seam is
// the whole safety argument, so it's worth reading before changing.
//
// An AssistantModel receives:
//   * the question,
//   * the intent, already decided by deterministic rules,
//   * the figures available for that intent, by name only.
//
// It returns prose with placeholders, plus links from a fixed allow-list.
// That is all it can return. It cannot return an amount, a decision, an
// action, or a database query, because none of those are in the type.
//
// So a model behind this port can be wrong about wording and nothing
// else. It cannot approve a payment (spec §12: risk stays deterministic
// and auditable), it cannot calculate money (§7), it cannot touch a
// balance or a ledger entry (§10), and it cannot choose what gets read
// out of the database, because the reading happened before it was asked.
//
// If one is ever wired in, two more things become mandatory and are not
// optional niceties: the figures and facts handed over are DATA, never
// instructions — a purpose line or display name someone else chose is
// untrusted input, and a model must not be allowed to act on text found
// in it — and the draft still goes through validateDraft, which rejects
// loose figures and unknown placeholders. The prototype ships with no
// model at all, and says so in its answers' provenance.
import type { AssistantDraft, Figures, Intent } from "./assistant.js";
import { deterministicDraft, type AssistantFacts } from "./answers.js";

export interface AssistantContext {
  /** Verbatim, for a model to read. Never stored (spec §26). */
  question: string;
  /** Decided by rules, before any model is consulted. */
  intent: Intent;
  /** The values that may be quoted, by name. */
  figures: Figures;
  /** The same values structured, for a model that wants the shape. */
  facts: AssistantFacts;
}

export interface AssistantModel {
  /** Recorded against each answer so support can tell who wrote it. */
  readonly name: string;
  draft(context: AssistantContext): Promise<AssistantDraft>;
}

/**
 * The default, and the only one in the prototype: fixed wording per
 * intent. Boring on purpose — nothing it says can drift, and an answer
 * about someone's money is a bad place for novelty.
 */
export class DeterministicAssistant implements AssistantModel {
  readonly name = "deterministic-v1";

  async draft(context: AssistantContext): Promise<AssistantDraft> {
    return deterministicDraft(context.intent, context.facts);
  }
}
