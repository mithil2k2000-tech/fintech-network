// Preview maths for the Split screen, so you can see what everyone will
// owe before you send anything.
//
// The server decides the real shares (services/api …/billSplits/shares.ts)
// and its answer is what the app shows afterwards. This mirrors that rule
// — floor the even share, give the odd pennies to the earliest shares,
// organiser first — and is tested against the same examples, so the
// preview and the result agree. It is never sent to the server.

/** Same rule as the server: whole pence, nothing lost, nothing invented. */
export function previewShares(totalMinorUnits: number, people: number): number[] {
  if (!Number.isSafeInteger(totalMinorUnits) || totalMinorUnits <= 0) return [];
  if (!Number.isSafeInteger(people) || people < 2) return [];
  if (totalMinorUnits < people) return [];
  const base = Math.floor(totalMinorUnits / people);
  const remainder = totalMinorUnits - base * people;
  return Array.from({ length: people }, (_, i) => (i < remainder ? base + 1 : base));
}

/**
 * What the organiser keeps and what each other person is asked for.
 * Returns null when there isn't enough to show a sensible preview yet.
 */
export function previewSplit(
  totalMinorUnits: number,
  participants: number,
  includeOrganiser = true
): { yours: number; theirs: number[] } | null {
  const people = participants + (includeOrganiser ? 1 : 0);
  const shares = previewShares(totalMinorUnits, people);
  if (shares.length === 0) return null;
  return includeOrganiser
    ? { yours: shares[0], theirs: shares.slice(1) }
    : { yours: 0, theirs: shares };
}
