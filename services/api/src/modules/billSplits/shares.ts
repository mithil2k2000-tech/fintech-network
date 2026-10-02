// The arithmetic of splitting a bill. Pure functions, whole pence, no
// floating point anywhere — and nothing here talks to the database, so
// it can be reasoned about and tested on its own. Every rule a person
// would argue about (who gets the odd penny, what must add up) is
// decided here, once.

/** A prototype guard-rail, not a product rule. */
export const MAX_SPLIT_PARTS = 20;

export class SplitMathError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "SplitMathError";
  }
}

function assertWholePositive(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SplitMathError("INVALID_AMOUNT", `${what} must be a whole number of pence above zero`);
  }
}

/**
 * Splits a total into `parts` shares that add up exactly.
 *
 * £10 between 3 gives 334, 333, 333 — never 3.33 each with a penny
 * missing. The odd pennies go to the earliest shares, which is
 * arbitrary but fixed, so the same bill always splits the same way and
 * the organiser (who is first) absorbs them rather than a guest.
 */
export function splitEvenly(totalMinorUnits: number, parts: number): number[] {
  assertWholePositive(totalMinorUnits, "The total");
  if (!Number.isSafeInteger(parts) || parts < 2) {
    throw new SplitMathError("TOO_FEW_PARTS", "A split needs at least two people");
  }
  if (parts > MAX_SPLIT_PARTS) {
    throw new SplitMathError(
      "TOO_MANY_PARTS",
      `A split can include at most ${MAX_SPLIT_PARTS} people`
    );
  }
  if (totalMinorUnits < parts) {
    throw new SplitMathError(
      "TOTAL_TOO_SMALL",
      "The total is too small to give everyone at least a penny"
    );
  }
  const base = Math.floor(totalMinorUnits / parts);
  const remainder = totalMinorUnits - base * parts;
  return Array.from({ length: parts }, (_, i) => (i < remainder ? base + 1 : base));
}

/**
 * Checks shares someone typed in themselves. They must each be whole
 * and positive, and add up to the total to the penny — we never quietly
 * adjust one to make the sum work.
 */
export function checkCustomShares(totalMinorUnits: number, shares: number[]): number[] {
  assertWholePositive(totalMinorUnits, "The total");
  if (shares.length < 2) {
    throw new SplitMathError("TOO_FEW_PARTS", "A split needs at least two people");
  }
  if (shares.length > MAX_SPLIT_PARTS) {
    throw new SplitMathError(
      "TOO_MANY_PARTS",
      `A split can include at most ${MAX_SPLIT_PARTS} people`
    );
  }
  shares.forEach((share) => assertWholePositive(share, "Each share"));
  const sum = shares.reduce((a, b) => a + b, 0);
  if (sum !== totalMinorUnits) {
    throw new SplitMathError(
      "SHARES_DO_NOT_ADD_UP",
      "The shares have to add up to the total exactly"
    );
  }
  return [...shares];
}

/**
 * The one entry point the module uses. `amounts` given → those are
 * checked; omitted → an even split. Index 0 is always the organiser's
 * own share, and what comes back always sums to the total.
 */
export function shareOut(
  totalMinorUnits: number,
  parts: number,
  amounts?: number[]
): number[] {
  if (!amounts) return splitEvenly(totalMinorUnits, parts);
  if (amounts.length !== parts) {
    throw new SplitMathError(
      "SHARES_DO_NOT_MATCH_PEOPLE",
      "Give an amount for everyone in the split, or none at all"
    );
  }
  return checkCustomShares(totalMinorUnits, amounts);
}
