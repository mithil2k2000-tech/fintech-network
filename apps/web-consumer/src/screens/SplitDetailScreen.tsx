import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { BillSplitDto } from "@fintech-network/shared-types";
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
  formatMoney,
  type BadgeTone,
} from "@fintech-network/design-system";
import { ApiError, api } from "../api/client";
import { REQUEST_STATUS_LABELS, dayLabel, timeLabel } from "../lib/format";
import { useAsync } from "../lib/useAsync";

// One split: what it came to, who owes what, and what's arrived so far.
// Open to everyone named on it — the organiser gets the cancel button.

const SHARE_TONE: Record<string, BadgeTone> = {
  OPEN: "neutral",
  PAID: "positive",
  DECLINED: "warning",
  CANCELLED: "neutral",
  EXPIRED: "warning",
};

export function SplitDetailScreen() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const split = useAsync(() => api.billSplit(id), [id]);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const data: BillSplitDto | undefined = split.data?.billSplit;
  const waiting = data?.status === "OPEN";

  // While anyone still owes, watch for their payment arriving.
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => split.reload(), 5_000);
    return () => clearInterval(timer);
  }, [waiting, split.reload]);

  async function cancel() {
    setCancelling(true);
    setError(null);
    try {
      await api.cancelBillSplit(id);
      split.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setCancelling(false);
    }
  }

  if (split.loading && !data) {
    return (
      <AppShell title="Split" back="/split">
        <PageLoader label="Loading this split" />
      </AppShell>
    );
  }

  if (split.error || !data) {
    const missing = split.error instanceof ApiError && split.error.status === 404;
    return (
      <AppShell title="Split" back="/split">
        <Card>
          <EmptyState icon="split" title={missing ? "We couldn't find that split" : "Something went wrong"}>
            {missing
              ? "It may have been removed, or it was never yours to see."
              : "Please try again in a moment."}
          </EmptyState>
        </Card>
        <Button block onClick={() => navigate("/split")}>
          Back to splits
        </Button>
      </AppShell>
    );
  }

  const people = data.shares.length + (data.organiserShareMinorUnits > 0 ? 1 : 0);

  return (
    <AppShell title={data.purpose ?? "Split"} back="/split">
      <AmountSummary
        minorUnits={data.totalMinorUnits}
        caption={`split ${people} ways`}
      />

      {data.status === "CANCELLED" ? (
        <Alert tone="warning" title="Cancelled">
          Shares nobody had paid were called off. Anything already paid stayed paid.
        </Alert>
      ) : data.status === "SETTLED" ? (
        <Alert tone="success" title="All settled">
          Everyone has answered. {formatMoney(data.collectedMinorUnits)} came back to you.
        </Alert>
      ) : null}

      <Card>
        <DetailList
          rows={[
            ...(data.organiser.isYou
              ? [{ label: "Your share", value: formatMoney(data.organiserShareMinorUnits) }]
              : [{ label: "Organised by", value: data.organiser.displayName, stacked: true }]),
            { label: "Collected", value: formatMoney(data.collectedMinorUnits) },
            { label: "Still owed", value: formatMoney(data.outstandingMinorUnits) },
          ]}
        />
      </Card>

      <div className="ds-stack">
        <h2 className="ds-section-title">Who owes what</h2>
        <Card flush>
          <ul className="ds-list">
            {data.shares.map((share) => {
              // Same shape as any other row in a list: when it opens a
              // receipt the link itself is the row, so it doesn't get
              // underlined like body text.
              const content = (
                <>
                  {/* The email is who they are until display names exist. */}
                  <div className="ds-txn__text">
                    <div className="ds-txn__title">{share.person.displayName}</div>
                    {share.paidAt ? (
                      <div className="ds-txn__subtitle">
                        Paid {dayLabel(share.paidAt)}, {timeLabel(share.paidAt)}
                      </div>
                    ) : null}
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontWeight: 650 }}>{formatMoney(share.amountMinorUnits)}</div>
                    <Badge tone={SHARE_TONE[share.status] ?? "neutral"}>
                      {REQUEST_STATUS_LABELS[share.status] ?? share.status}
                    </Badge>
                  </div>
                </>
              );
              return (
                <li key={share.paymentRequestId}>
                  {share.receiptId ? (
                    <Link to={`/receipts/${share.receiptId}`} className="ds-txn">
                      {content}
                    </Link>
                  ) : (
                    <div className="ds-txn">{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {data.organiser.isYou && data.status === "OPEN" ? (
        <Button block variant="secondary" onClick={cancel} loading={cancelling}>
          Cancel this split
        </Button>
      ) : null}

      <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
        Simulated funds — nothing real is charged.
      </p>
    </AppShell>
  );
}
