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
  PageLoader,
  type BadgeTone,
} from "@fintech-network/design-system";
import { STATUS_LABELS, dateTimeLabel, useAsync } from "@fintech-network/app-kit";
import { ApiError, api } from "../api/client";

// The shop's side of a receipt. The same record the customer holds —
// issued once, never edited — framed as money received.

const STATUS_TONE: Record<string, BadgeTone> = {
  COMPLETED: "positive",
  REFUNDED: "warning",
  DISPUTED: "warning",
};

export function ReceiptScreen() {
  const { id = "" } = useParams();
  const { data, error, loading, reload } = useAsync(() => api.receipt(id), [id]);

  if (loading && !data) {
    return (
      <AppShell title="Receipt" back={true}>
        <PageLoader label="Loading receipt" />
      </AppShell>
    );
  }

  if (error || !data) {
    const missing = error instanceof ApiError && (error.status === 404 || error.status === 400);
    return (
      <AppShell title="Receipt" back="/takings">
        {missing ? (
          <Card>
            <EmptyState icon="receipt" title="Receipt not found">
              It may belong to a different shop.
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
  return (
    <AppShell title="Receipt" back={true}>
      <AmountSummary
        minorUnits={r.amountMinorUnits}
        caption={
          <>
            received from <strong>{r.from}</strong>
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

      <Button variant="secondary" block onClick={() => window.print()}>
        Print or save as PDF
      </Button>
      <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
        Simulated payment — prototype receipt, not a real financial record.
      </p>
    </AppShell>
  );
}
