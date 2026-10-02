import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatMoney } from "../money";

export function Avatar({ name, accent, large }: { name: string; accent?: boolean; large?: boolean }) {
  const initial = name.trim().charAt(0) || "?";
  return (
    <span
      className={`ds-avatar${accent ? " ds-avatar--accent" : ""}${large ? " ds-avatar--lg" : ""}`}
      aria-hidden="true"
    >
      {initial}
    </span>
  );
}

export function BalanceCard({
  label = "Available balance",
  minorUnits,
  meta,
}: {
  label?: string;
  minorUnits: number | null;
  meta?: ReactNode;
}) {
  return (
    <section className="ds-hero" aria-label={label}>
      <div className="ds-hero__label">{label}</div>
      <div className="ds-hero__amount">{minorUnits === null ? "—" : formatMoney(minorUnits)}</div>
      {meta ? <div className="ds-hero__meta">{meta}</div> : null}
    </section>
  );
}

export interface TransactionRowProps {
  title: string;
  subtitle?: string;
  minorUnits: number;
  direction: "in" | "out";
  balanceAfterMinorUnits?: number;
  to?: string;
  accent?: boolean;
}

/** One line in an activity list. Money in is green with a +; out is plain with a −. */
export function TransactionRow({
  title,
  subtitle,
  minorUnits,
  direction,
  balanceAfterMinorUnits,
  to,
  accent,
}: TransactionRowProps) {
  const signed = direction === "in" ? minorUnits : -minorUnits;
  const amountText = formatMoney(signed, { sign: "always" });
  const content = (
    <>
      <Avatar name={title} accent={accent} />
      <div className="ds-txn__text">
        <div className="ds-txn__title">{title}</div>
        {subtitle ? <div className="ds-txn__subtitle">{subtitle}</div> : null}
      </div>
      <div className="ds-txn__amount">
        <div className={direction === "in" ? "ds-txn__amount--in" : undefined}>
          <span className="ds-visually-hidden">{direction === "in" ? "Received " : "Sent "}</span>
          {amountText}
        </div>
        {balanceAfterMinorUnits !== undefined ? (
          <div className="ds-txn__balance">
            <span className="ds-visually-hidden">Balance after: </span>
            {formatMoney(balanceAfterMinorUnits)}
          </div>
        ) : null}
      </div>
    </>
  );
  return (
    <li>
      {to ? (
        <Link to={to} className="ds-txn">
          {content}
        </Link>
      ) : (
        <div className="ds-txn">{content}</div>
      )}
    </li>
  );
}

export interface DetailRow {
  label: string;
  value: ReactNode;
  mono?: boolean;
  /** Put the value under the label — for long values such as email addresses. */
  stacked?: boolean;
}

export function DetailList({ rows }: { rows: DetailRow[] }) {
  return (
    <dl className="ds-details">
      {rows.map((r) => (
        <div key={r.label} className={`ds-details__row${r.stacked ? " ds-details__row--stacked" : ""}`}>
          <dt>{r.label}</dt>
          <dd className={r.mono ? "ds-mono" : undefined}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AmountSummary({ minorUnits, caption }: { minorUnits: number; caption?: ReactNode }) {
  return (
    <div className="ds-summary">
      <div className="ds-summary__amount">{formatMoney(minorUnits)}</div>
      {caption ? <div className="ds-summary__caption">{caption}</div> : null}
    </div>
  );
}
