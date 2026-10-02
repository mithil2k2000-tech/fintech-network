import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { PaymentDto, PublicPaymentRequestDto } from "@fintech-network/shared-types";
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
} from "@fintech-network/design-system";
import { api, ApiError } from "../api/client";
import { REQUEST_STATUS_LABELS, expiresInLabel } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { ResultStep, ReviewStep } from "./pay/steps";

// Paying a request — one scanned from a QR code, or one someone sent you
// by name. The amount and who's being paid come from the server, never
// from the scanned text, so a doctored QR can't change them.

/** A request id means it was opened from the inbox, not a camera. */
const FROM_INBOX = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;

export function PayRequestScreen() {
  const { key = "" } = useParams();
  const navigate = useNavigate();
  const back = FROM_INBOX.test(key) ? "/requests" : "/scan";
  const [payment, setPayment] = useState<PaymentDto | null>(null);
  const [done, setDone] = useState<PaymentDto | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolved = useAsync(() => api.resolvePaymentRequest(key), [key]);

  if (done) {
    return (
      <ResultStep
        payment={done}
        onAgain={() => navigate(back)}
        againLabel={back === "/requests" ? "Back to requests" : "Scan again"}
      />
    );
  }
  if (payment) {
    return (
      <ReviewStep
        payment={payment}
        title="Confirm this payment"
        extraRows={[
          {
            label: "From",
            value: (
              <Badge tone="neutral">
                {back === "/requests" ? "A request sent to you" : "Scanned QR code"}
              </Badge>
            ),
          },
        ]}
        onDone={setDone}
        onCancelled={() => setPayment(null)}
      />
    );
  }

  if (resolved.loading) {
    return (
      <AppShell title="Payment request" back={back}>
        <PageLoader label="Looking up that request" />
      </AppShell>
    );
  }

  if (resolved.error || !resolved.data) {
    const missing = resolved.error instanceof ApiError && resolved.error.status === 404;
    return (
      <AppShell title="Payment request" back={back}>
        <Card>
          <EmptyState
            icon={back === "/requests" ? "request" : "scan"}
            title={missing ? "We couldn't find that request" : "Something went wrong"}
          >
            {missing
              ? "It may have been withdrawn, or it was never meant for you."
              : "Please try again in a moment."}
          </EmptyState>
        </Card>
        <Button block onClick={() => navigate(back)}>
          {back === "/requests" ? "Back to your requests" : "Back to scanning"}
        </Button>
      </AppShell>
    );
  }

  const request: PublicPaymentRequestDto = resolved.data.paymentRequest;
  const payable = request.status === "OPEN" && request.isForYou;
  const isShop = request.requester.type === "merchant";

  async function start() {
    setStarting(true);
    setError(null);
    try {
      const { payment } = await api.payPaymentRequest(request.id);
      setPayment(payment);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? err.message
          : err instanceof Error
            ? err.message
            : "Something went wrong"
      );
      resolved.reload();
    } finally {
      setStarting(false);
    }
  }

  return (
    <AppShell title="Payment request" back={back}>
      <AmountSummary
        minorUnits={request.amountMinorUnits}
        caption={
          <>
            to <strong>{request.requester.displayName}</strong>
          </>
        }
      />
      <Card>
        <DetailList
          rows={[
            {
              label: isShop ? "Paying" : "Requested by",
              value: request.requester.displayName,
              stacked: true,
            },
            {
              label: "Recipient",
              value: (
                <Badge tone="neutral">
                  {isShop ? "Registered shop" : "Registered account"}
                </Badge>
              ),
            },
            { label: "For", value: request.purpose ?? "Not given" },
            { label: "Reference", value: request.code, mono: true },
            {
              label: "Status",
              value:
                request.status === "OPEN"
                  ? expiresInLabel(request.expiresAt)
                  : REQUEST_STATUS_LABELS[request.status] ?? request.status,
            },
          ]}
        />
      </Card>

      {/* Why it can't be paid comes first; whose it is, second. */}
      {request.status !== "OPEN" ? (
        <Alert tone="warning" title={REQUEST_STATUS_LABELS[request.status] ?? request.status}>
          This request can't be paid any more.{" "}
          {request.channel === "direct" ? "Ask them to send a new one." : "Ask for a new QR code."}
        </Alert>
      ) : null}
      {request.isOwn ? (
        <Alert tone="info">
          {request.channel === "direct"
            ? "This is your own request — you'll see it here once they've paid."
            : "This is your own request — show it to someone else to get paid."}
        </Alert>
      ) : null}

      {/* Never let "registered" read as "checked out and trustworthy". */}
      {isShop ? (
        <Alert tone="info" title="About this shop">
          {request.requester.displayName} has an account on this network. We haven't
          checked the business itself, so only pay if you know who you're paying.
        </Alert>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Button block onClick={start} loading={starting} disabled={!payable}>
        Continue to pay {formatMoney(request.amountMinorUnits)}
      </Button>
      <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
        You'll see the full details before anything is sent.
      </p>
    </AppShell>
  );
}
