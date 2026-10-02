import { useParams } from "react-router-dom";
import {
  Alert,
  AmountSummary,
  AppShell,
  Badge,
  Button,
  Card,
  DetailList,
  EmptyState,
  Icon,
  PageLoader,
  type BadgeTone,
} from "@fintech-network/design-system";
import { api, ApiError } from "../api/client";
import { dateTimeLabel, STATUS_LABELS } from "../lib/format";
import { useAsync } from "../lib/useAsync";

const STATUS_TONE: Record<string, BadgeTone> = {
  COMPLETED: "positive",
  REFUNDED: "warning",
  DISPUTED: "warning",
};

export function ReceiptScreen() {
  const { id = "" } = useParams();
  const { data, error, loading, reload } = useAsync(() => api.receipt(id), [id]);

  if (loading) {
    return (
      <AppShell title="Receipt" back={true}>
        <PageLoader label="Loading receipt" />
      </AppShell>
    );
  }

  if (error || !data) {
    const missing = error instanceof ApiError && (error.status === 404 || error.status === 400);
    return (
      <AppShell title="Receipt" back="/activity">
        {missing ? (
          <Card>
            <EmptyState icon="receipt" title="Receipt not found">
              It may belong to a different account.
            </EmptyState>
          </Card>
        ) : (
          <Alert tone="danger" title="We couldn't load this receipt">
            <Button variant="ghost" onClick={reload}>
              Try again
            </Button>
          </Alert>
        )}
      </AppShell>
    );
  }

  const r = data.receipt;
  const payer = r.role === "payer";
  return (
    <AppShell title="Receipt" back={true}>
      <AmountSummary
        minorUnits={r.amountMinorUnits}
        caption={
          <>
            {payer ? "Paid to " : "Received from "}
            <strong>{payer ? r.to : r.from}</strong>
          </>
        }
      />
      <div style={{ display: "flex", justifyContent: "center" }}>
        <Badge tone={STATUS_TONE[r.paymentStatus] ?? "neutral"}>
          {STATUS_LABELS[r.paymentStatus] ?? r.paymentStatus}
        </Badge>
      </div>

      <Card>
        <DetailList
          rows={[
            { label: "Receipt number", value: r.receiptNumber, mono: true },
            { label: "Date", value: dateTimeLabel(r.issuedAt) },
            { label: "From", value: r.from, stacked: true },
            { label: "To", value: r.to, stacked: true },
            { label: "For", value: r.purpose ?? "Not given" },
            { label: "Currency", value: r.currency },
          ]}
        />
      </Card>

      <Card>
        <div className="ds-row">
          <span className="ds-avatar ds-avatar--accent" aria-hidden="true">
            <Icon name="shield" size={22} />
          </span>
          <div>
            <div style={{ fontWeight: 650 }}>Payment Passport</div>
            <div className="ds-muted ds-small">
              {r.passport.available
                ? "Share proof of this payment without revealing anything else."
                : "Proof you can share for this one payment. Coming in a later version."}
            </div>
          </div>
        </div>
      </Card>

      <Button variant="secondary" block onClick={() => window.print()}>
        Print or save as PDF
      </Button>
      <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
        Simulated payment — prototype receipt, not a real financial record.
      </p>
    </AppShell>
  );
}
