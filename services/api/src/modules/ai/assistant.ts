// The assistant's deterministic core (spec §13 AI Assistant).
//
// Three rules shape every line of this file, and they come straight from
// the engineering constraints:
//
//   1. The assistant never decides whether money moves. It has no code
//      path that writes anything; the most it can do is point at a screen
//      where the person does it themselves.
//   2. The assistant never calculates money. Every figure in an answer is
//      an integer of minor units that came from a domain module, carried
//      here as a Figure and substituted into the text at the very end.
//   3. Therefore the text itself must contain no figures. A template that
//      mentions a number or a currency symbol outside a placeholder is a
//      bug, and `assertNoLooseFigures` makes it a loud one.
//
// Rule 3 is what makes rule 2 hold even if a language model is put behind
// the AssistantModel port later: a model can choose words and which
// figures to refer to, but the values the person reads are substituted by
// this file from numbers the model never touched.
//
// Everything here is pure. No database, no clock, no I/O.

/** Bumped when wording or classification changes, for the audit trail. */
export const ASSISTANT_RULES_VERSION = "assistant-rules-v1";

export const MAX_QUESTION_LENGTH = 280;

export type Intent =
  | "BALANCE"
  | "SPENDING"
  | "CASHBACK"
  | "WAITING_REQUESTS"
  | "RECENT_ACTIVITY"
  | "EXPLAIN_WARNING"
  | "SAFETY"
  | "CAPABILITIES"
  | "MOVE_MONEY_REFUSED"
  | "ADVICE_REFUSED"
  | "OTHER_PERSON_REFUSED"
  | "UNKNOWN";

/**
 * A value the assistant may quote. Money is always minor units, so the
 * assistant cannot be the thing that divides by a hundred.
 */
export type Figure =
  | { kind: "money"; minorUnits: number }
  | { kind: "count"; value: number }
  | { kind: "percent"; value: number }
  | { kind: "words"; value: string };

export type Figures = Record<string, Figure>;

/** Somewhere in the app the person can go to do the thing themselves. */
export interface Suggestion {
  label: string;
  path: string;
}

/**
 * What an AssistantModel returns: prose with placeholders, and links.
 * Never values, never actions.
 */
export interface AssistantDraft {
  text: string;
  suggestions: Suggestion[];
}

/**
 * The only paths a suggestion may point at: screens of the consumer app
 * that the person drives themselves. Nothing here moves money on
 * arrival — /pay opens an empty form, and a receipt is read-only.
 */
const ALLOWED_PATHS = [
  "/",
  "/pay",
  "/request",
  "/requests",
  "/activity",
  "/rewards",
  "/split",
  "/scan",
  "/profile",
  "/assistant",
] as const;

const RECEIPT_PATH = /^\/receipts\/[0-9a-fA-F-]{36}$/;

export function isAllowedPath(path: string): boolean {
  return (ALLOWED_PATHS as readonly string[]).includes(path) || RECEIPT_PATH.test(path);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface IntentRule {
  intent: Intent;
  any: RegExp[];
  unless?: RegExp[];
}

/**
 * Asking about the past ("how much have I sent?") is a question; asking
 * for something to happen ("send Sam a tenner") is an instruction. The
 * same verbs appear in both, so the instruction rules below exclude
 * anything that reads as a question about what already happened.
 */
const LOOKING_BACK =
  /\b(how much|how many|what did|what have|did i|have i|do i|was i|last|recent|history|total)\b/;

/**
 * First match wins, so the order is the policy.
 *
 * Safety comes first. Someone describing pressure to pay — "he says
 * I'll be arrested unless I pay now" — is not asking for a payment to
 * be made, and answering that with "I can't send money" would miss the
 * only thing that mattered about the message.
 *
 * Refusals come next, ahead of every topic, because "pay Sam £20" must
 * never be read as a question about payments.
 */
const RULES: IntentRule[] = [
  {
    intent: "SAFETY",
    any: [
      /\b(scam|scammed|scammer|fraud|fraudulent|phish|phishing|hacked|stolen|blackmail|threaten)\b/,
      /\b(suspicious|dodgy|too good to be true)\b/,
      /\b(is|are) (this|they|he|she|it) (a scam|genuine|real|legit|safe)\b/,
      // Pressure, in either order: "pay right now", "unless I pay
      // urgently". Urgency plus a payment is the oldest signal there is.
      /\b(pay|paying|transfer|send)\b[^?]*\b(urgent|urgently|right now|immediately|straight away|within the hour|in \w+ minutes)\b/,
      /\b(urgent|urgently|right now|immediately|straight away)\b[^?]*\b(pay|paying|transfer|send)\b/,
      // Threats used to make someone pay before they think.
      /\b(arrest|arrested|police|court|bailiff|warrant|deported|prosecut\w+|suspend\w+|locked out)\b[^?]*\b(pay|paying|transfer|send|fee|fine)\b/,
    ],
  },
  {
    intent: "OTHER_PERSON_REFUSED",
    any: [
      /\b(someone|somebody|anyone|another (user|person|account)|other people)(?:'s)?\b[^?]*\b(balance|account|money|spend|spending|payments|transactions|details)\b/,
      /\b\w+'s (balance|account|money|spending|payments|transactions|details)\b/,
      /\bhow much (does|has) \w+\b/,
    ],
    unless: [/\bmy own\b/],
  },
  {
    // Verbs that are only ever an instruction here. "Cancel my last
    // payment" is an instruction even though it mentions the past, so
    // these get a narrower guard than the ambiguous verbs below.
    intent: "MOVE_MONEY_REFUSED",
    any: [
      /\b(cancel|refund|decline|transfer|approve|authorise|authorize)\b/,
      /\btop (me )?up\b/,
    ],
    unless: [/\b(did|have|has) i\b/, /\bcan i\b/, /\bhow do i\b/, /\bwhere do i\b/],
  },
  {
    // Verbs that read as either an instruction or a question about the
    // past, depending on the sentence.
    intent: "MOVE_MONEY_REFUSED",
    any: [/\b(pay|send|give|move|split)\b/],
    unless: [LOOKING_BACK, /\bcan i\b/, /\bhow do i\b/, /\bwhere do i\b/],
  },
  {
    intent: "ADVICE_REFUSED",
    any: [
      /\b(invest|investing|investment|stocks|shares|crypto|bitcoin|pension|mortgage|loan|interest rate|financial advice|advise me)\b/,
      /\bshould i (buy|sell|save|borrow|switch)\b/,
      /\bwhat should i do with (my )?(money|savings)\b/,
    ],
  },
  {
    intent: "EXPLAIN_WARNING",
    any: [
      /\b(warn|warned|warning|flag|flagged|unusual|risky|risk|blocked|why did (you|it))\b/,
    ],
  },
  {
    intent: "CASHBACK",
    any: [/\b(cashback|cash back|reward|rewards|tree|earned back)\b/],
  },
  {
    intent: "WAITING_REQUESTS",
    any: [
      /\b(owe|owed|owing|waiting|asking me|asked me|requests?|inbox|chasing)\b/,
      /\bwho (do|does) i\b/,
    ],
  },
  {
    intent: "SPENDING",
    any: [
      /\b(spend|spent|spending|outgoing|outgoings)\b/,
      /\bhow much have i (paid|sent)\b/,
    ],
  },
  {
    intent: "BALANCE",
    any: [
      /\b(balance|available|left|in my account|how much (do|have) i (have|got))\b/,
      /\bam i (broke|overdrawn)\b/,
    ],
  },
  {
    intent: "RECENT_ACTIVITY",
    any: [
      /\b(activity|transactions?|history|statement)\b/,
      /\blast (payment|thing)\b/,
      /\bwhat did i (pay|buy)\b/,
      // "did I pay the rent?" is a question about the past, so the
      // instruction rule above has already stepped aside for it.
      /\b(did|have) i (pay|paid|send|sent)\b/,
    ],
  },
  {
    intent: "CAPABILITIES",
    any: [
      /\bwhat can you\b/,
      /\bwhat do you do\b/,
      /\b(who|what) are you\b/,
      /\bhelp\b/,
      /\bare you (an? )?(ai|robot|bot|human)\b/,
    ],
  },
];

/**
 * Which question was asked, decided by fixed rules rather than by a
 * model. This matters for more than predictability: the intent decides
 * which facts get read out of the database, so a model behind the port
 * can never widen what gets looked up (spec §26 data minimisation).
 */
export function classify(question: string): Intent {
  const q = question.toLowerCase();
  for (const rule of RULES) {
    if (rule.unless?.some((re) => re.test(q))) continue;
    if (rule.any.some((re) => re.test(q))) return rule.intent;
  }
  return "UNKNOWN";
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;

export class AssistantTextError extends Error {}

/**
 * Enforces rule 3: prose carries no numbers of its own. Placeholders are
 * removed first, then a single digit or currency symbol left anywhere in
 * what remains is an error — including a spelled-out amount like
 * "£12.50", a percentage, or "3 payments".
 *
 * Counts and rates therefore have to travel as Figures too, which is the
 * point: anything the person might act on is a value the API computed.
 */
export function assertNoLooseFigures(text: string): void {
  const withoutPlaceholders = text.replace(PLACEHOLDER, "");
  const offender = withoutPlaceholders.match(/[\d£$€%]/);
  if (offender) {
    throw new AssistantTextError(
      `assistant text may not contain figures outside a placeholder (found "${offender[0]}")`
    );
  }
}

/** Placeholder names used by a piece of text, in order of appearance. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]);
}

/**
 * Pence to pounds by string surgery — the same rule as the frontend's
 * formatMoney and for the same reason: no floating-point arithmetic ever
 * touches a monetary value (spec §7). Kept local rather than imported
 * from the design system so the API doesn't depend on a UI package.
 */
export function formatMinorUnits(minorUnits: number): string {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new AssistantTextError("money figures must be safe integers of minor units");
  }
  const negative = minorUnits < 0;
  const digits = Math.abs(minorUnits).toString().padStart(3, "0");
  const pounds = digits.slice(0, -2);
  const pence = digits.slice(-2);
  const grouped = pounds.replace(/\B(?=(\d{3})+$)/g, ",");
  return `${negative ? "−" : ""}£${grouped}.${pence}`;
}

export function formatFigure(figure: Figure): string {
  switch (figure.kind) {
    case "money":
      return formatMinorUnits(figure.minorUnits);
    case "count":
      return String(figure.value);
    case "percent":
      return `${figure.value}%`;
    case "words":
      return figure.value;
  }
}

/**
 * Substitutes the values in. An unknown placeholder is an error, not an
 * empty string: an answer with a hole where a number should be is worse
 * than no answer, and a model inventing a figure name is exactly what
 * this catches.
 */
export function renderAnswer(text: string, figures: Figures): string {
  return text.replace(PLACEHOLDER, (_match, name: string) => {
    const figure = figures[name];
    if (!figure) {
      throw new AssistantTextError(`no figure named "${name}" was provided`);
    }
    return formatFigure(figure);
  });
}

/**
 * Checks a draft before anything is rendered: no loose figures, no
 * invented figure names, and no link to a screen outside the allow-list.
 * Callers treat a failure as "use the deterministic answer instead" —
 * the assistant fails back to something safe rather than guessing.
 */
export function validateDraft(draft: AssistantDraft, figures: Figures): void {
  if (draft.text.trim().length === 0) {
    throw new AssistantTextError("assistant text is empty");
  }
  assertNoLooseFigures(draft.text);
  for (const name of placeholdersIn(draft.text)) {
    if (!figures[name]) {
      throw new AssistantTextError(`no figure named "${name}" was provided`);
    }
  }
  for (const suggestion of draft.suggestions) {
    if (!isAllowedPath(suggestion.path)) {
      throw new AssistantTextError(`suggestion points outside the app: ${suggestion.path}`);
    }
  }
}
