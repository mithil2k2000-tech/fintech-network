// Dates, countdowns and the words for a status — the same in every app,
// so they live here rather than being written twice. Pure functions,
// unit tested. Money formatting lives in the design system, next to the
// components that show it.

const timeFmt = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" });
const fullFmt = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today", "Yesterday" or "17 September 2026". */
export function dayLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return dayFmt.format(d);
}

export function timeLabel(iso: string): string {
  return timeFmt.format(new Date(iso));
}

export function dateLabel(iso: string): string {
  return dayFmt.format(new Date(iso));
}

export function dateTimeLabel(iso: string): string {
  return fullFmt.format(new Date(iso));
}

/** Groups items by calendar day, keeping their order. */
export function groupByDay<T>(items: T[], getDate: (item: T) => string, now?: Date) {
  const groups: { label: string; items: T[] }[] = [];
  for (const item of items) {
    const label = dayLabel(getDate(item), now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

/** Counts down to an expiry, e.g. "Expires in 4 min" or "Expires in 6 days". */
export function expiresInLabel(iso: string, now: Date = new Date()): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (ms <= 0) return "Expired";
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 2 * 24 * 60) return `Expires in ${Math.round(minutes / (24 * 60))} days`;
  if (minutes >= 120) return `Expires in ${Math.round(minutes / 60)} hours`;
  if (minutes >= 1) return `Expires in ${minutes} min`;
  return `Expires in ${Math.max(1, Math.ceil(ms / 1000))} sec`;
}

export const REQUEST_STATUS_LABELS: Record<string, string> = {
  OPEN: "Waiting to be paid",
  PAID: "Paid",
  CANCELLED: "Cancelled",
  DECLINED: "Declined",
  EXPIRED: "Expired",
};

export const STATUS_LABELS: Record<string, string> = {
  COMPLETED: "Completed",
  FAILED: "Failed",
  REFUNDED: "Refunded",
  DISPUTED: "Disputed",
  PROCESSING: "Processing",
  APPROVED: "Awaiting confirmation",
};

/** "alex.smith@example.com" -> "Alex" */
export function firstNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const first = local.split(/[._\-+0-9]/).find(Boolean) ?? local;
  return first ? first.charAt(0).toUpperCase() + first.slice(1).toLowerCase() : "there";
}
