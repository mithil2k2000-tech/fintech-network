import { useState } from "react";
import { Link } from "react-router-dom";
import type { IncomingPaymentRequestDto } from "@fintech-network/shared-types";
import {
  Alert,
  AppShell,
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  PageLoader,
  formatMoney,
  type BadgeTone,
} from "@fintech-network/design-system";
import { api } from "../api/client";
import { REQUEST_STATUS_LABELS, dayLabel, expiresInLabel, timeLabel } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { NAV_ITEMS } from "../nav";

// Requests other people have sent you. Paying one goes through the same
// review-and-confirm screen as a scanned QR — this screen never moves
// money itself, it only hands over the request.

const STATUS_TONE: Record<string, BadgeTone> = {
  PAID: "positive",
  CANCELLED: "neutral",
  DECLINED: "warning",
  EXPIRED: "warning",
};

export function RequestsInboxScreen() {
  const incoming = useAsync(() => api.incomingPaymentRequests());
  const [declining, setDeclining] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decline(id: string) {
    setDeclining(id);
    setError(null);
    try {
      await api.declinePaymentRequest(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setDeclining(null);
      incoming.reload();
    }
  }

  const requests = incoming.data?.paymentRequests ?? [];
  const waiting = requests.filter((r) => r.status === "OPEN");
  const answered = requests.filter((r) => r.status !== "OPEN");

  return (
    <AppShell title="Requests for you" nav={NAV_ITEMS} back="/">
      {incoming.error ? (
        <Alert tone="danger" title="We couldn't load your requests">
          <Button variant="ghost" onClick={incoming.reload}>
            Try again
          </Button>
        </Alert>
      ) : null}
      {error ? <Alert tone="danger">{error}</Alert> : null}

      {incoming.loading && !incoming.data ? (
        <PageLoader label="Loading your requests" />
      ) : requests.length === 0 ? (
        <Card>
          <EmptyState icon="request" title="Nothing to pay">
            When someone asks you for money, it shows up here.
          </EmptyState>
        </Card>
      ) : (
        <>
          {waiting.map((r) => (
            <WaitingRequest
              key={r.id}
              request={r}
              declining={declining === r.id}
              disabled={declining !== null}
              onDecline={() => decline(r.id)}
            />
          ))}

          {answered.length > 0 ? (
            <div className="ds-stack">
              <h2 className="ds-section-title">Earlier</h2>
              <Card flush>
                <ul className="ds-list">
                  {answered.map((r) => (
                    <li key={r.id}>
                      <AnsweredRequest request={r} />
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          ) : null}
        </>
      )}

      <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
        Simulated funds — nothing real is charged.
      </p>
    </AppShell>
  );
}

function WaitingRequest({
  request,
  declining,
  disabled,
  onDecline,
}: {
  request: IncomingPaymentRequestDto;
  declining: boolean;
  disabled: boolean;
  onDecline: () => void;
}) {
  return (
    <Card>
      <div className="ds-stack">
        <div>
          <div style={{ fontWeight: 650 }}>
            {request.requester.displayName} asked you for
            {request.billSplitId ? " your share of" : ""}
          </div>
          <div className="ds-figure" data-testid="incoming-amount">
            {formatMoney(request.amountMinorUnits)}
          </div>
          <div className="ds-muted ds-small">
            {[
              request.billSplitId ? "Split bill" : null,
              request.purpose,
              expiresInLabel(request.expiresAt),
            ]
              .filter(Boolean)
              .join(" · ")}
          </div>
        </div>
        {request.billSplitId ? (
          <Link to={`/splits/${request.billSplitId}`} className="ds-small">
            See the whole bill
          </Link>
        ) : null}
        <ButtonLink to={`/pay/r/${request.id}`} block>
          Review and pay
        </ButtonLink>
        <Button block variant="secondary" onClick={onDecline} loading={declining} disabled={disabled}>
          Decline
        </Button>
      </div>
    </Card>
  );
}

function AnsweredRequest({ request }: { request: IncomingPaymentRequestDto }) {
  // The link is the row, so an answered request doesn't read as body text.
  const content = (
    <>
      <div className="ds-txn__text">
        <div className="ds-txn__title">{formatMoney(request.amountMinorUnits)}</div>
        <div className="ds-txn__subtitle">
          {[
            request.requester.displayName,
            request.purpose,
            `${dayLabel(request.createdAt)}, ${timeLabel(request.createdAt)}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      <Badge tone={STATUS_TONE[request.status] ?? "neutral"}>
        {REQUEST_STATUS_LABELS[request.status] ?? request.status}
      </Badge>
    </>
  );
  const to = request.receiptId
    ? `/receipts/${request.receiptId}`
    : request.billSplitId
      ? `/splits/${request.billSplitId}`
      : null;
  return to ? (
    <Link to={to} className="ds-txn">
      {content}
    </Link>
  ) : (
    <div className="ds-txn">{content}</div>
  );
}
