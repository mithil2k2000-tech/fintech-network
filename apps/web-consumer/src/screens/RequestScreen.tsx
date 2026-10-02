import { useEffect, useMemo, useState, type FormEvent } from "react";
import QRCode from "qrcode";
import type { OwnPaymentRequestDto } from "@fintech-network/shared-types";
import {
  Alert,
  AmountField,
  AmountSummary,
  AppShell,
  Badge,
  Button,
  ButtonLink,
  Card,
  DetailList,
  EmptyState,
  SegmentedControl,
  Skeleton,
  TextField,
  formatMoney,
  parseMoneyInput,
  type BadgeTone,
} from "@fintech-network/design-system";
import { ApiError, api } from "../api/client";
import { brand } from "../config/brand";
import {
  REQUEST_STATUS_LABELS,
  dayLabel,
  expiresInLabel,
  firstNameFromEmail,
  timeLabel,
} from "../lib/format";
import { requestLink } from "../lib/scanning";
import { useAsync } from "../lib/useAsync";
import { NAV_ITEMS } from "../nav";

// "Get paid": one request, two ways to send it — a QR code for whoever is
// standing in front of you, or straight to someone by name. Both make the
// same kind of request; only `toEmail` differs.

const STATUS_TONE: Record<string, BadgeTone> = {
  OPEN: "neutral",
  PAID: "positive",
  CANCELLED: "neutral",
  DECLINED: "warning",
  EXPIRED: "warning",
};

type Mode = "qr" | "person";

export function RequestScreen() {
  const [created, setCreated] = useState<OwnPaymentRequestDto | null>(null);
  if (created) {
    return created.channel === "direct" ? (
      <RequestSent request={created} onDone={() => setCreated(null)} />
    ) : (
      <RequestQr request={created} onDone={() => setCreated(null)} />
    );
  }
  return <RequestForm onCreated={setCreated} />;
}

function RequestForm({ onCreated }: { onCreated: (r: OwnPaymentRequestDto) => void }) {
  const [mode, setMode] = useState<Mode>("qr");
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [toEmail, setToEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recipientError, setRecipientError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const recent = useAsync(() => api.paymentRequests());

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const money = parseMoneyInput(amount);
    if (!money.ok) {
      setError(money.error);
      return;
    }
    if (money.minorUnits > brand.maxPaymentMinorUnits) {
      setError(`The most you can request at once is ${formatMoney(brand.maxPaymentMinorUnits)}`);
      return;
    }
    const recipient = toEmail.trim();
    if (mode === "person" && !recipient) {
      setRecipientError("Enter the email address of the person you're asking");
      return;
    }
    setError(null);
    setRecipientError(null);
    setSubmitting(true);
    try {
      const { paymentRequest } = await api.createPaymentRequest({
        amountMinorUnits: money.minorUnits,
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        ...(mode === "person" ? { toEmail: recipient } : {}),
      });
      onCreated(paymentRequest);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      if (mode === "person" && err instanceof ApiError && err.status === 400) {
        setRecipientError(message);
      } else {
        setError(message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell title="Request" nav={NAV_ITEMS}>
      <form className="ds-stack ds-stack--lg" onSubmit={onSubmit} noValidate>
        <SegmentedControl
          label="How to send this request"
          value={mode}
          onChange={(next) => {
            setMode(next);
            setRecipientError(null);
          }}
          options={[
            { value: "qr", label: "Show a QR" },
            { value: "person", label: "Ask a person" },
          ]}
        />
        <Card>
          <AmountField
            label="Amount to request"
            value={amount}
            onChange={setAmount}
            error={error}
            currencySymbol={brand.currencySymbol}
          />
          <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
            {mode === "person"
              ? "They'll see it in their requests and can pay or decline."
              : "You'll get a QR code for someone to scan."}
          </p>
        </Card>
        {mode === "person" ? (
          <TextField
            label="Who are you asking?"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="name@example.com"
            value={toEmail}
            error={recipientError ?? undefined}
            onChange={(e) => setToEmail(e.target.value)}
          />
        ) : null}
        <TextField
          label="What's it for? (optional)"
          maxLength={140}
          placeholder={mode === "person" ? "e.g. Taxi home" : "e.g. Flat white"}
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
        />
        <Button type="submit" block loading={submitting}>
          {mode === "person" ? "Send request" : "Create QR code"}
        </Button>
      </form>

      <div className="ds-stack">
        <h2 className="ds-section-title">Your recent requests</h2>
        <Card flush>
          {recent.loading ? (
            <div style={{ padding: 20 }}>
              <Skeleton height={20} />
            </div>
          ) : recent.data && recent.data.paymentRequests.length > 0 ? (
            <ul className="ds-list">
              {recent.data.paymentRequests.map((r) => (
                <li key={r.id}>
                  <div className="ds-txn">
                    <div className="ds-txn__text">
                      <div className="ds-txn__title">{formatMoney(r.amountMinorUnits)}</div>
                      <div className="ds-txn__subtitle">
                        {[
                          r.sentTo ? `To ${r.sentTo.displayName}` : "QR code",
                          r.purpose,
                          `${dayLabel(r.createdAt)}, ${timeLabel(r.createdAt)}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <Badge tone={STATUS_TONE[r.status] ?? "neutral"}>
                      {REQUEST_STATUS_LABELS[r.status] ?? r.status}
                    </Badge>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="request" title="No requests yet">
              Show a QR code, or ask someone directly, to get paid.
            </EmptyState>
          )}
        </Card>
      </div>
    </AppShell>
  );
}

/**
 * Keeps one of your own requests up to date while you're looking at it,
 * and lets you call it off. Shared by the QR view and the sent-to-a-person
 * view, which differ only in what they draw.
 */
function useLiveRequest(request: OwnPaymentRequestDto) {
  const [live, setLive] = useState(request);
  const [cancelling, setCancelling] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    if (live.status !== "OPEN") return;
    const timer = setInterval(async () => {
      setNow(new Date());
      try {
        const { paymentRequest } = await api.paymentRequest(request.id);
        setLive(paymentRequest);
      } catch {
        // Keep showing what we have; the next tick tries again.
      }
    }, 3_000);
    return () => clearInterval(timer);
  }, [request.id, live.status]);

  async function cancel() {
    setCancelling(true);
    try {
      const { paymentRequest } = await api.cancelPaymentRequest(request.id);
      setLive(paymentRequest);
    } finally {
      setCancelling(false);
    }
  }

  return { live, now, cancel, cancelling };
}

function PaidNotice({
  request,
  onDone,
}: {
  request: OwnPaymentRequestDto;
  onDone: () => void;
}) {
  return (
    <>
      <Alert tone="success" title="Payment received">
        {request.paidBy?.displayName} paid you {formatMoney(request.amountMinorUnits)}.
      </Alert>
      {request.receiptId ? (
        <ButtonLink to={`/receipts/${request.receiptId}`} block>
          View receipt
        </ButtonLink>
      ) : null}
      <Button block variant="secondary" onClick={onDone}>
        Done
      </Button>
    </>
  );
}

function RequestSent({ request, onDone }: { request: OwnPaymentRequestDto; onDone: () => void }) {
  const { live, now, cancel, cancelling } = useLiveRequest(request);
  const to = live.sentTo?.displayName ?? "them";
  // A badge has one line to work with, so it gets the short form.
  const shortName = live.sentTo ? firstNameFromEmail(live.sentTo.displayName) : "them";

  return (
    <AppShell
      title={live.status === "OPEN" ? "Request sent" : REQUEST_STATUS_LABELS[live.status] ?? "Request"}
      back="/request"
    >
      <AmountSummary
        minorUnits={live.amountMinorUnits}
        caption={
          <>
            asked of <strong>{to}</strong>
          </>
        }
      />
      {live.status === "PAID" ? (
        <PaidNotice request={live} onDone={onDone} />
      ) : live.status === "OPEN" ? (
        <>
          <Alert tone="success" title="We've asked them">
            {to} will see this in their requests. Nothing moves until they pay it.
          </Alert>
          <DetailList
            rows={[
              { label: "For", value: live.purpose ?? "Not given" },
              { label: "Reference", value: live.code, mono: true },
              { label: "Status", value: <Badge tone="neutral">Waiting for {shortName}</Badge> },
              { label: "Expires", value: expiresInLabel(live.expiresAt, now) },
            ]}
          />
          <Button block variant="secondary" onClick={cancel} loading={cancelling}>
            Cancel request
          </Button>
          <Button block variant="ghost" onClick={onDone}>
            Done
          </Button>
        </>
      ) : (
        <>
          <Alert
            tone={live.status === "DECLINED" ? "warning" : "info"}
            title={REQUEST_STATUS_LABELS[live.status] ?? live.status}
          >
            {live.status === "DECLINED"
              ? `${to} declined this request. Nothing was charged.`
              : "This request can't be paid any more."}
          </Alert>
          <Button block onClick={onDone}>
            Create another
          </Button>
        </>
      )}
      <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
        Simulated funds — nothing real is charged.
      </p>
    </AppShell>
  );
}

function RequestQr({ request, onDone }: { request: OwnPaymentRequestDto; onDone: () => void }) {
  const { live, now, cancel, cancelling } = useLiveRequest(request);
  const [qr, setQr] = useState<string | null>(null);
  const link = useMemo(() => requestLink(request.token), [request.token]);

  // Draw the QR from the link, so any camera app can open it too.
  useEffect(() => {
    let cancelled = false;
    QRCode.toString(link, { type: "svg", margin: 1, errorCorrectionLevel: "M" })
      .then((svg) => {
        if (!cancelled) setQr(svg);
      })
      .catch(() => {
        if (!cancelled) setQr(null);
      });
    return () => {
      cancelled = true;
    };
  }, [link]);

  const paid = live.status === "PAID";
  return (
    <AppShell title={paid ? "Paid" : "Show this to get paid"} back="/request">
      <AmountSummary
        minorUnits={live.amountMinorUnits}
        caption={live.purpose ?? "Scan to pay"}
      />

      {paid ? (
        <PaidNotice request={live} onDone={onDone} />
      ) : live.status === "OPEN" ? (
        <>
          <Card>
            <div
              data-testid="request-qr"
              style={{ display: "grid", placeItems: "center" }}
              // The QR is generated in the browser from the link above.
              dangerouslySetInnerHTML={qr ? { __html: qr } : undefined}
            >
              {qr ? undefined : <Skeleton height={220} width={220} />}
            </div>
            <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
              Can't scan? Enter this code in the app:
            </p>
            <p className="ds-mono" style={{ textAlign: "center", fontSize: 18, fontWeight: 700 }}>
              {live.code}
            </p>
          </Card>
          <DetailList
            rows={[
              { label: "Status", value: <Badge tone="neutral">Waiting to be paid</Badge> },
              { label: "Expires", value: expiresInLabel(live.expiresAt, now) },
            ]}
          />
          <Button block variant="secondary" onClick={cancel} loading={cancelling}>
            Cancel request
          </Button>
        </>
      ) : (
        <>
          <Alert tone="warning" title={REQUEST_STATUS_LABELS[live.status] ?? live.status}>
            This request can't be paid any more.
          </Alert>
          <Button block onClick={onDone}>
            Create another
          </Button>
        </>
      )}
      <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
        Simulated funds — nothing real is charged.
      </p>
    </AppShell>
  );
}
