import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { PaymentDto, RiskLevel } from "@fintech-network/shared-types";
import {
  Alert,
  AmountSummary,
  AppShell,
  Badge,
  Button,
  ButtonLink,
  Card,
  Checkbox,
  DetailList,
  ResultIcon,
  formatMoney,
  type BadgeTone,
} from "@fintech-network/design-system";
import { api } from "../../api/client";
import { failureMessage } from "../../lib/format";

// The last two steps of any payment — typed in by hand, or started from a
// QR code. Shared so both routes show the payer exactly the same review
// and result screens (spec §9).

const RISK_BADGE: Record<RiskLevel, { tone: BadgeTone; label: string }> = {
  LOW: { tone: "positive", label: "Low risk" },
  MEDIUM: { tone: "warning", label: "Medium risk" },
  HIGH: { tone: "danger", label: "High risk" },
};

export function ReviewStep({
  payment,
  onDone,
  onCancelled,
  title = "Check the details",
  extraRows = [],
}: {
  payment: PaymentDto;
  onDone: (payment: PaymentDto) => void;
  onCancelled: () => void;
  title?: string;
  extraRows?: { label: string; value: React.ReactNode }[];
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState<"confirm" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const risk = payment.risk.level ? RISK_BADGE[payment.risk.level] : null;
  const high = payment.risk.level === "HIGH";

  async function confirm() {
    setBusy("confirm");
    setError(null);
    try {
      const result = await api.confirmPayment(payment.id, high && acknowledged);
      onDone(result.payment);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    setBusy("cancel");
    setError(null);
    try {
      await api.cancelPayment(payment.id);
      onCancelled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setBusy(null);
    }
  }

  return (
    <AppShell title={title}>
      <AmountSummary
        minorUnits={payment.amountMinorUnits}
        caption={<>to <strong>{payment.counterparty.displayName}</strong></>}
      />
      <Card>
        <DetailList
          rows={[
            { label: "Recipient", value: <Badge tone="neutral">Registered account</Badge> },
            { label: "For", value: payment.purpose ?? "Not given" },
            ...extraRows,
            {
              label: "Safety check",
              value: risk ? <Badge tone={risk.tone}>{risk.label}</Badge> : "Not checked",
            },
          ]}
        />
        {payment.risk.reasons.length > 0 ? (
          <ul className="ds-small ds-muted" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            {payment.risk.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
      </Card>

      {high ? (
        <div className="ds-stack">
          <Alert tone="danger" title="This payment looks unusual">
            Scammers often ask for urgent payments to new people. Only continue if you know and trust
            who you're paying.
          </Alert>
          <Checkbox checked={acknowledged} onChange={setAcknowledged}>
            I've read the warning and want to make this payment
          </Checkbox>
        </div>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="ds-stack">
        <Button
          block
          onClick={confirm}
          loading={busy === "confirm"}
          disabled={busy !== null || (high && !acknowledged)}
        >
          Pay {formatMoney(payment.amountMinorUnits)}
        </Button>
        <Button block variant="secondary" onClick={cancel} loading={busy === "cancel"} disabled={busy !== null}>
          Cancel
        </Button>
      </div>
      <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
        Nothing has been sent yet.
      </p>
    </AppShell>
  );
}

export function ResultStep({
  payment,
  onAgain,
  againLabel = "Try again",
}: {
  payment: PaymentDto;
  onAgain?: () => void;
  againLabel?: string;
}) {
  const navigate = useNavigate();
  const ok = payment.status === "COMPLETED";
  return (
    <AppShell>
      <div className="ds-summary" style={{ paddingTop: 48 }}>
        <ResultIcon tone={ok ? "success" : "danger"} />
        <h1 className="ds-lead" style={{ marginTop: 12 }}>
          {ok ? "Payment sent" : "Payment didn't go through"}
        </h1>
        <p className="ds-summary__caption">
          {ok ? (
            <>
              {formatMoney(payment.amountMinorUnits)} to <strong>{payment.counterparty.displayName}</strong>
            </>
          ) : (
            failureMessage(payment.failureReason)
          )}
        </p>
      </div>
      {!ok ? <Alert tone="info">No money has left your account.</Alert> : null}
      <div className="ds-stack">
        {ok && payment.receiptId ? (
          <ButtonLink to={`/receipts/${payment.receiptId}`} block>
            View receipt
          </ButtonLink>
        ) : null}
        {ok ? (
          <Button block variant="secondary" onClick={() => navigate("/")}>
            Done
          </Button>
        ) : (
          <>
            {onAgain ? (
              <Button block onClick={onAgain}>
                {againLabel}
              </Button>
            ) : null}
            <Button block variant="secondary" onClick={() => navigate("/")}>
              Back to home
            </Button>
          </>
        )}
      </div>
    </AppShell>
  );
}
