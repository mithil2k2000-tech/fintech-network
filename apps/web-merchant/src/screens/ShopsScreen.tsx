import { useState, type FormEvent } from "react";
import type { MerchantDto } from "@fintech-network/shared-types";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  AppShell,
  Badge,
  Button,
  Card,
  EmptyState,
  Icon,
  PageLoader,
  TextField,
} from "@fintech-network/design-system";
import { ApiError, api } from "../api/client";
import { useSession } from "../session/SessionContext";
import { useShop } from "../shop/ShopContext";

// Which shop am I working for? And, the first time, registering one.
// Nothing here is a verification step — see the notice at the bottom.

export function ShopsScreen() {
  const navigate = useNavigate();
  const { user } = useSession();
  const { shops, shop, loading, error, select, add, reload } = useShop();
  const [adding, setAdding] = useState(false);

  if (loading && shops.length === 0) {
    return (
      <AppShell title="Your shops">
        <PageLoader label="Loading your shops" />
      </AppShell>
    );
  }

  if (error && shops.length === 0) {
    return (
      <AppShell title="Your shops">
        <Alert tone="danger" title="We couldn't load your shops">
          <Button variant="ghost" onClick={reload}>
            Try again
          </Button>
        </Alert>
      </AppShell>
    );
  }

  const showForm = adding || shops.length === 0;

  return (
    <AppShell title="Your shops" back={shops.length > 0 ? "/" : undefined}>
      {shops.length > 0 ? (
        <Card flush>
          <ul className="ds-list">
            {shops.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="ds-txn"
                  style={{ width: "100%", background: "none", border: 0, cursor: "pointer" }}
                  onClick={() => {
                    select(s.id);
                    navigate("/");
                  }}
                >
                  <span className="ds-avatar ds-avatar--accent" aria-hidden="true">
                    <Icon name="receipt" size={20} />
                  </span>
                  <div className="ds-txn__text" style={{ textAlign: "left" }}>
                    <div className="ds-txn__title">{s.tradingName}</div>
                    <div className="ds-txn__subtitle">
                      {s.yourRole === "owner" ? "Owner" : "Staff"}
                      {s.status === "suspended" ? " · Suspended" : ""}
                    </div>
                  </div>
                  {s.id === shop?.id ? <Badge tone="positive">Open</Badge> : null}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {showForm ? (
        <RegisterShopForm
          contactDefault={user?.email ?? ""}
          onRegistered={(shop) => {
            add(shop);
            setAdding(false);
            navigate("/");
          }}
        />
      ) : (
        <Button block variant="secondary" onClick={() => setAdding(true)}>
          Register another shop
        </Button>
      )}

      <Alert tone="info" title="We don't check businesses">
        Registering a shop here proves nothing about it. There's no company
        check, no documents and no screening in this prototype, and customers
        are told as much before they pay.
      </Alert>
    </AppShell>
  );
}

function RegisterShopForm({
  contactDefault,
  onRegistered,
}: {
  contactDefault: string;
  onRegistered: (shop: MerchantDto) => void;
}) {
  const [legalName, setLegalName] = useState("");
  const [tradingName, setTradingName] = useState("");
  const [contactEmail, setContactEmail] = useState(contactDefault);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNameError(null);
    setSubmitting(true);
    try {
      const { merchant } = await api.createMerchant({
        legalName: legalName.trim(),
        tradingName: tradingName.trim(),
        contactEmail: contactEmail.trim(),
      });
      onRegistered(merchant);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Something went wrong";
      if (err instanceof ApiError && err.code === "MERCHANT_NAME_TAKEN") setNameError(message);
      else setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="ds-stack ds-stack--lg" onSubmit={onSubmit} noValidate>
      <Card>
        <EmptyState icon="receipt" title="Register your shop">
          Customers see your trading name when they pay, so use the name above
          your door.
        </EmptyState>
      </Card>
      <TextField
        label="Trading name"
        hint="What customers see"
        maxLength={80}
        placeholder="e.g. Corner Coffee"
        value={tradingName}
        error={nameError ?? undefined}
        onChange={(e) => setTradingName(e.target.value)}
      />
      <TextField
        label="Registered name"
        hint="The name on your paperwork"
        maxLength={140}
        placeholder="e.g. Corner Coffee Ltd"
        value={legalName}
        onChange={(e) => setLegalName(e.target.value)}
      />
      <TextField
        label="Contact email"
        type="email"
        inputMode="email"
        maxLength={255}
        value={contactEmail}
        onChange={(e) => setContactEmail(e.target.value)}
      />
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Button
        type="submit"
        block
        loading={submitting}
        disabled={!tradingName.trim() || !legalName.trim() || !contactEmail.trim()}
      >
        Register shop
      </Button>
    </form>
  );
}
