// Branding lives here and only here (spec §3: the name isn't final).
// Set VITE_APP_NAME at build time to rebrand without touching screens.
export const brand = {
  name: import.meta.env.VITE_APP_NAME ?? "FinTech Network",
  currencySymbol: "£",
  /** Must match the API's per-payment cap (services/api payments routes). */
  maxPaymentMinorUnits: 1_000_000,
  /**
   * Where a scanned QR code takes the customer — the consumer app, not
   * this one. Set VITE_PAY_ORIGIN per environment; the default is the
   * consumer app's dev server.
   */
  payOrigin: import.meta.env.VITE_PAY_ORIGIN ?? "http://localhost:5173",
} as const;

/** The link a QR code carries, so any camera app opens the right place. */
export function payLink(token: string): string {
  return `${brand.payOrigin}/pay/r/${token}`;
}
