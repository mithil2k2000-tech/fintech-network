// Money on screen. Amounts arrive from the API as integer minor units
// (pence) and are turned into text with integer and string operations
// only — never by dividing into a float (spec §7). User input goes the
// other way with the same rule.

export interface FormatMoneyOptions {
  /** "auto": minus sign for negatives only. "always": + or − on everything. */
  sign?: "auto" | "always";
  currencySymbol?: string;
}

const MINUS = "−"; // typographic minus, reads better than a hyphen

export function formatMoney(
  minorUnits: number,
  { sign = "auto", currencySymbol = "£" }: FormatMoneyOptions = {}
): string {
  if (!Number.isSafeInteger(minorUnits)) {
    throw new Error(`formatMoney expects integer minor units, got ${minorUnits}`);
  }
  const negative = minorUnits < 0;
  const abs = Math.abs(minorUnits);
  const pounds = Math.trunc(abs / 100);
  const pence = abs % 100;
  const grouped = pounds.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const body = `${currencySymbol}${grouped}.${pence.toString().padStart(2, "0")}`;
  if (negative) return `${MINUS}${body}`;
  if (sign === "always" && minorUnits > 0) return `+${body}`;
  return body;
}

export type ParseMoneyResult =
  | { ok: true; minorUnits: number }
  | { ok: false; error: string };

// Up to £9,999,999.99 of typed input; the API applies its own, lower cap.
const AMOUNT_PATTERN = /^(\d{1,7})(?:\.(\d{0,2}))?$/;

/**
 * Turns what someone typed ("12", "12.5", "£1,250.00") into pence.
 * Rejects anything ambiguous rather than guessing (e.g. "12.505").
 */
export function parseMoneyInput(raw: string): ParseMoneyResult {
  const cleaned = raw.trim().replace(/^£/, "").replace(/,/g, "").trim();
  if (cleaned === "") return { ok: false, error: "Enter an amount" };
  if (cleaned.startsWith("-")) return { ok: false, error: "Amount can't be negative" };
  const match = AMOUNT_PATTERN.exec(cleaned);
  if (!match) {
    return /\.\d{3,}$/.test(cleaned)
      ? { ok: false, error: "Use at most 2 decimal places" }
      : { ok: false, error: "Enter a valid amount, like 12.50" };
  }
  const pounds = Number.parseInt(match[1], 10);
  const pence = Number.parseInt((match[2] ?? "").padEnd(2, "0"), 10);
  const minorUnits = pounds * 100 + pence;
  if (minorUnits === 0) return { ok: false, error: "Amount must be more than £0.00" };
  return { ok: true, minorUnits };
}
