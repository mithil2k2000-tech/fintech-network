// Display helpers. The date, countdown and status wording is shared
// with the merchant app (@fintech-network/app-kit) and re-exported here
// so screens keep importing from one place; what's below is particular
// to this app.
export {
  REQUEST_STATUS_LABELS,
  STATUS_LABELS,
  dateLabel,
  dateTimeLabel,
  dayLabel,
  expiresInLabel,
  firstNameFromEmail,
  groupByDay,
  timeLabel,
} from "@fintech-network/app-kit";

/** Plain-English explanations for failure codes the API can return. */
export function failureMessage(code: string | null | undefined): string {
  if (!code) return "The payment didn't go through.";
  if (code === "INSUFFICIENT_FUNDS") return "You don't have enough money for this payment.";
  if (code === "CANCELLED_BY_PAYER") return "You cancelled this payment.";
  if (code.startsWith("PROVIDER_DECLINED")) return "The payment was declined.";
  if (code === "RISK_EVALUATION_ERROR") return "We couldn't check this payment safely, so we stopped it.";
  if (code === "PAYMENT_REQUEST_ALREADY_PAID") return "This request had already been paid.";
  if (code === "PAYMENT_REQUEST_EXPIRED") return "This request expired before the payment went through.";
  if (code === "PAYMENT_REQUEST_CANCELLED") return "The person who created this request cancelled it.";
  if (code === "PAYMENT_REQUEST_DECLINED") return "This request was declined, so the payment was stopped.";
  if (code === "PAYMENT_REQUEST_MISMATCH") return "This request changed while you were paying, so we stopped the payment.";
  return "Something went wrong, so the payment didn't go through. No money was taken.";
}
