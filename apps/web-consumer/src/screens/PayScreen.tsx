import { useState, type FormEvent } from "react";
import type { PaymentDto } from "@fintech-network/shared-types";
import {
  Alert,
  AmountField,
  AppShell,
  Button,
  Card,
  TextField,
  formatMoney,
  parseMoneyInput,
} from "@fintech-network/design-system";
import { api, ApiError } from "../api/client";
import { brand } from "../config/brand";
import { useAsync } from "../lib/useAsync";
import { NAV_ITEMS } from "../nav";
import { ResultStep, ReviewStep } from "./pay/steps";

// The spec §9 flow as three steps: details -> review (risk shown, nothing
// moved yet) -> result. The server enforces every rule again; the checks
// here are only there to give fast, friendly feedback.

type Step =
  | { name: "details" }
  | { name: "review"; payment: PaymentDto }
  | { name: "result"; payment: PaymentDto };

export function PayScreen() {
  const [step, setStep] = useState<Step>({ name: "details" });
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");

  const reset = () => {
    setStep({ name: "details" });
    setAmount("");
    setPurpose("");
  };

  if (step.name === "review") {
    return (
      <ReviewStep
        payment={step.payment}
        onDone={(payment) => setStep({ name: "result", payment })}
        onCancelled={() => setStep({ name: "details" })}
      />
    );
  }
  if (step.name === "result") {
    return <ResultStep payment={step.payment} onAgain={reset} />;
  }
  return (
    <DetailsStep
      recipient={recipient}
      amount={amount}
      purpose={purpose}
      onRecipient={setRecipient}
      onAmount={setAmount}
      onPurpose={setPurpose}
      onReview={(payment) => setStep({ name: "review", payment })}
    />
  );
}

function DetailsStep(props: {
  recipient: string;
  amount: string;
  purpose: string;
  onRecipient: (v: string) => void;
  onAmount: (v: string) => void;
  onPurpose: (v: string) => void;
  onReview: (payment: PaymentDto) => void;
}) {
  const account = useAsync(() => api.account());
  const balance = account.data?.account.balanceMinorUnits ?? null;
  const [errors, setErrors] = useState<{ recipient?: string; amount?: string; form?: string }>({});
  const [submitting, setSubmitting] = useState(false);

  const parsed = props.amount ? parseMoneyInput(props.amount) : null;
  const overBalance =
    parsed?.ok && balance !== null && parsed.minorUnits > balance ? balance : null;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    const email = props.recipient.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) next.recipient = "Enter the recipient's email address";
    const money = parseMoneyInput(props.amount);
    if (!money.ok) next.amount = money.error;
    else if (money.minorUnits > brand.maxPaymentMinorUnits)
      next.amount = `The most you can send at once is ${formatMoney(brand.maxPaymentMinorUnits)}`;
    setErrors(next);
    if (Object.keys(next).length > 0 || !money.ok) return;

    setSubmitting(true);
    try {
      const { payment } = await api.createPayment({
        recipientEmail: email,
        amountMinorUnits: money.minorUnits,
        ...(props.purpose.trim() ? { purpose: props.purpose.trim() } : {}),
      });
      props.onReview(payment);
    } catch (err) {
      if (err instanceof ApiError && err.code === "RECIPIENT_NOT_FOUND") {
        setErrors({ recipient: "There's no account with that email" });
      } else if (err instanceof ApiError && err.code === "SELF_PAYMENT") {
        setErrors({ recipient: "You can't send money to yourself" });
      } else {
        setErrors({ form: err instanceof Error ? err.message : "Something went wrong" });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell title="Pay" nav={NAV_ITEMS}>
      <form className="ds-stack ds-stack--lg" onSubmit={onSubmit} noValidate>
        <Card>
          <AmountField
            label="Amount"
            value={props.amount}
            onChange={props.onAmount}
            error={errors.amount}
            currencySymbol={brand.currencySymbol}
          />
          <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
            {balance === null ? " " : `Available: ${formatMoney(balance)}`}
          </p>
        </Card>
        {overBalance !== null ? (
          <Alert tone="warning">
            This is more than your available balance of {formatMoney(overBalance)}, so it won't go through.
          </Alert>
        ) : null}
        <TextField
          label="To"
          type="email"
          inputMode="email"
          autoComplete="off"
          placeholder="name@example.com"
          hint="The email address of the person you're paying"
          value={props.recipient}
          onChange={(e) => props.onRecipient(e.target.value)}
          error={errors.recipient}
        />
        <TextField
          label="What's it for? (optional)"
          maxLength={140}
          placeholder="e.g. Dinner"
          value={props.purpose}
          onChange={(e) => props.onPurpose(e.target.value)}
        />
        {errors.form ? <Alert tone="danger">{errors.form}</Alert> : null}
        <Button type="submit" block loading={submitting}>
          Review payment
        </Button>
      </form>
    </AppShell>
  );
}

