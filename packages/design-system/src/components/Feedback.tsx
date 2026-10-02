import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

export function Spinner({ label = "Loading" }: { label?: string }) {
  return (
    <span className="ds-spinner" role="status">
      <span className="ds-visually-hidden">{label}</span>
    </span>
  );
}

export function PageLoader({ label = "Loading" }: { label?: string }) {
  return (
    <div className="ds-loader">
      <Spinner label={label} />
    </div>
  );
}

export function Skeleton({ height = 16, width = "100%" }: { height?: number; width?: number | string }) {
  return <div className="ds-skeleton" style={{ height, width }} aria-hidden="true" />;
}

export type Tone = "info" | "success" | "warning" | "danger";

const toneIcon: Record<Tone, IconName> = {
  info: "info",
  success: "check",
  warning: "alert",
  danger: "alert",
};

export interface AlertProps {
  tone?: Tone;
  title?: string;
  children?: ReactNode;
}

/** Errors and warnings are announced to screen readers as they appear. */
export function Alert({ tone = "info", title, children }: AlertProps) {
  const urgent = tone === "danger" || tone === "warning";
  return (
    <div className={`ds-alert ds-alert--${tone}`} role={urgent ? "alert" : "status"}>
      <Icon name={toneIcon[tone]} size={20} />
      <div>
        {title ? <div className="ds-alert__title">{title}</div> : null}
        {children ? <div className="ds-alert__body">{children}</div> : null}
      </div>
    </div>
  );
}

export type BadgeTone = "neutral" | "positive" | "warning" | "danger";

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`ds-badge ds-badge--${tone}`}>{children}</span>;
}

export function EmptyState({
  icon = "activity",
  title,
  children,
}: {
  icon?: IconName;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="ds-empty">
      <Icon name={icon} size={32} />
      <div className="ds-empty__title">{title}</div>
      {children ? <div>{children}</div> : null}
    </div>
  );
}

export function ResultIcon({ tone }: { tone: "success" | "danger" }) {
  return (
    <div className={`ds-result-icon ds-result-icon--${tone}`}>
      <Icon name={tone === "success" ? "check" : "close"} size={36} />
    </div>
  );
}
