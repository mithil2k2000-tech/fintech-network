import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
  PageLoader,
  Skeleton,
  TextField,
  formatMoney,
  parseMoneyInput,
} from "@fintech-network/design-system";
import { REQUEST_STATUS_LABELS, expiresInLabel, useAsync } from "@fintech-network/app-kit";
import { api } from "../api/client";
import { brand, payLink } from "../config/brand";
import { useShop } from "../shop/ShopContext";

// Taking a payment: put an amount on the till, show the code, watch it
// get paid. The charge is an ordinary payment request made for the shop
// — the same thing a person makes to get paid — so the customer's app
// already knows what to do with it.

export function ChargeScreen() {
  const { id } = useParams();
  const { shop } = useShop();
  const [created, setCreated] = useState<OwnPaymentRequestDto | null>(null);

  // Opened from the till's "waiting to be paid" list.
  const existing = useAsync(async () => (id ? api.charge(id) : null), [id]);

  if (id) {
    if (existing.loading && !existing.data) {
      return (
        <AppShell title="Charge" back="/">
          <PageLoader label="Loading this charge" />
        </AppShell>
      );
    }
    if (!existing.data) {
      return (
        <AppShell title="Charge" back="/">
          <Alert tone="danger" title="We couldn't find that charge" />
          <ButtonLink to="/" block>
            Back to the till
          </ButtonLink>
        </AppShell>
      );
    }
    return <ShowCharge charge={existing.data.paymentRequest} />;
  }

  if (created) return <ShowCharge charge={created} />;
  return <NewCharge merchantId={shop!.id} suspended={shop!.status !== "active"} onCreated={setCreated} />;
}

function NewCharge({
  merchantId,
  suspended,
  onCreated,
}: {
  merchantId: string;
  suspended: boolean;
  onCreated: (charge: OwnPaymentRequestDto) => void;
}) {
  const [amount, setAmount] = useState("");
  const [purpose, setPurpose] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const money = parseMoneyInput(amount);
    if (!money.ok) {
      setAmountError(money.error);
      return;
    }
    if (money.minorUnits > brand.maxPaymentMinorUnits) {
      setAmountError(`The most you can charge at once is ${formatMoney(brand.maxPaymentMinorUnits)}`);
      return;
    }
    setAmountError(null);
    setError(null);
    setSubmitting(true);
    try {
      const { paymentRequest } = await api.createCharge({
        asMerchantId: merchantId,
        amountMinorUnits: money.minorUnits,
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
      });
      onCreated(paymentRequest);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell title="Take a payment" back="/">
      <form className="ds-stack ds-stack--lg" onSubmit={onSubmit} noValidate>
        <Card>
          <AmountField
            label="Amount to charge"
            value={amount}
            onChange={setAmount}
            error={amountError}
            currencySymbol={brand.currencySymbol}
          />
          <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
            You'll get a code for the customer to scan or type.
          </p>
        </Card>
        <TextField
          label="What's it for? (optional)"
          maxLength={140}
          placeholder="e.g. Flat white"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
        />
        {suspended ? (
          <Alert tone="warning">This shop can't take payments at the moment.</Alert>
        ) : null}
        {error ? <Alert tone="danger">{error}</Alert> : null}
        <Button type="submit" block loading={submitting} disabled={suspended}>
          Show the code
        </Button>
      </form>
    </AppShell>
  );
}

function ShowCharge({ charge }: { charge: OwnPaymentRequestDto }) {
  const navigate = useNavigate();
  const [live, setLive] = useState(charge);
  const [qr, setQr] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [cancelling, setCancelling] = useState(false);
  const link = useMemo(() => payLink(charge.token), [charge.token]);

  // The QR carries a link into the customer's app, not this one.
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

  // Watch for it being paid, and keep the countdown honest.
  useEffect(() => {
    if (live.status !== "OPEN") return;
    const timer = setInterval(async () => {
      setNow(new Date());
      try {
        const { paymentRequest } = await api.charge(charge.id);
        setLive(paymentRequest);
      } catch {
        // Keep showing the code; the next tick tries again.
      }
    }, 3_000);
    return () => clearInterval(timer);
  }, [charge.id, live.status]);

  async function cancel() {
    setCancelling(true);
    try {
      const { paymentRequest } = await api.cancelCharge(charge.id);
      setLive(paymentRequest);
    } finally {
      setCancelling(false);
    }
  }

  const paid = live.status === "PAID";

  return (
    <AppShell title={paid ? "Paid" : "Show this to the customer"} back="/">
      <AmountSummary minorUnits={live.amountMinorUnits} caption={live.purpose ?? "Scan to pay"} />

      {paid ? (
        <>
          <Alert tone="success" title="Payment received">
            {live.paidBy?.displayName} paid {formatMoney(live.amountMinorUnits)}.
          </Alert>
          {live.receiptId ? (
            <ButtonLink to={`/receipts/${live.receiptId}`} block variant="secondary">
              View receipt
            </ButtonLink>
          ) : null}
          <Button block onClick={() => navigate("/charge")}>
            Take another payment
          </Button>
        </>
      ) : live.status === "OPEN" ? (
        <>
          <Card>
            <div
              data-testid="charge-qr"
              style={{ display: "grid", placeItems: "center" }}
              // Generated in the browser from the link above.
              dangerouslySetInnerHTML={qr ? { __html: qr } : undefined}
            >
              {qr ? undefined : <Skeleton height={220} width={220} />}
            </div>
            <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
              No camera? They can type this code:
            </p>
            <p className="ds-mono" style={{ textAlign: "center", fontSize: 18, fontWeight: 700 }}>
              {live.code}
            </p>
          </Card>
          <DetailList
            rows={[
              { label: "Status", value: <Badge tone="neutral">Waiting for the customer</Badge> },
              { label: "Expires", value: expiresInLabel(live.expiresAt, now) },
            ]}
          />
          <Button block variant="secondary" onClick={cancel} loading={cancelling}>
            Cancel this charge
          </Button>
        </>
      ) : (
        <>
          <Alert tone="warning" title={REQUEST_STATUS_LABELS[live.status] ?? live.status}>
            This charge can't be paid any more.
          </Alert>
          <Button block onClick={() => navigate("/charge")}>
            Take another payment
          </Button>
        </>
      )}
      <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
        Simulated funds — nothing real is charged.
      </p>
    </AppShell>
  );
}
