import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Link } from "react-router-dom";
import { Spinner } from "./Feedback";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface CommonProps {
  variant?: ButtonVariant;
  block?: boolean;
  children: ReactNode;
}

function classes(variant: ButtonVariant, block?: boolean) {
  return ["ds-button", `ds-button--${variant}`, block ? "ds-button--block" : ""]
    .filter(Boolean)
    .join(" ");
}

export interface ButtonProps
  extends CommonProps,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  loading?: boolean;
}

export function Button({
  variant = "primary",
  block,
  loading,
  disabled,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={classes(variant, block)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner label="Working" /> : null}
      {children}
    </button>
  );
}

export interface ButtonLinkProps extends CommonProps {
  to: string;
}

export function ButtonLink({ variant = "primary", block, to, children }: ButtonLinkProps) {
  return (
    <Link to={to} className={classes(variant, block)}>
      {children}
    </Link>
  );
}
