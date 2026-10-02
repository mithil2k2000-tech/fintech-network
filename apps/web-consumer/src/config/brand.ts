// Branding lives here and only here (spec §3: the name isn't final).
// Set VITE_APP_NAME at build time to rebrand without touching screens.
export const brand = {
  name: import.meta.env.VITE_APP_NAME ?? "FinTech Network",
  currencySymbol: "£",
  /** Must match the API's per-payment cap (services/api payments routes). */
  maxPaymentMinorUnits: 1_000_000,
} as const;
