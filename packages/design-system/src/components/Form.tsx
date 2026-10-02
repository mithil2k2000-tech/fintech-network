import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

/**
 * A labelled input with hint and error wired up for assistive tech.
 * Forwards its ref, so a screen can put the caret back where the person
 * was (the assistant returns focus to the question box after an answer).
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, hint, error, ...input },
  ref
) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");
  return (
    <div className="ds-field">
      <label className="ds-field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        ref={ref}
        className="ds-input"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy || undefined}
        {...input}
      />
      {hint ? (
        <div id={hintId} className="ds-field__hint">
          {hint}
        </div>
      ) : null}
      {error ? (
        <div id={errorId} className="ds-field__error">
          {error}
        </div>
      ) : null}
    </div>
  );
});

export interface AmountFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  currencySymbol?: string;
  autoFocus?: boolean;
}

/** Large amount entry. Emits the raw text; parse it with parseMoneyInput. */
export function AmountField({
  label,
  value,
  onChange,
  error,
  currencySymbol = "£",
  autoFocus,
}: AmountFieldProps) {
  const id = useId();
  return (
    <div className="ds-field">
      <label className="ds-visually-hidden" htmlFor={id}>
        {label}
      </label>
      <div className="ds-amount">
        <span className="ds-amount__symbol" aria-hidden="true">
          {currencySymbol}
        </span>
        <input
          id={id}
          className="ds-amount__input"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={value}
          autoFocus={autoFocus}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(e) => onChange(e.target.value)}
          size={Math.max(value.length, 4)}
        />
      </div>
      {error ? (
        <div id={`${id}-error`} className="ds-field__error" style={{ textAlign: "center" }}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="ds-checkbox">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="ds-segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
