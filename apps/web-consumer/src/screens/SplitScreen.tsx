import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Alert,
  AmountField,
  AppShell,
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  Icon,
  Skeleton,
  TextField,
  formatMoney,
  parseMoneyInput,
  type BadgeTone,
} from "@fintech-network/design-system";
import { ApiError, api } from "../api/client";
import { brand } from "../config/brand";
import { dayLabel, timeLabel } from "../lib/format";
import { previewSplit } from "../lib/split";
import { useAsync } from "../lib/useAsync";
import { NAV_ITEMS } from "../nav";

// Splitting a bill: the total, who was there, and who owes what. Each
// person's share goes out as the same kind of request as Phase 7, so
// they pay it the way they already know.

const MAX_PEOPLE = 20;

const SPLIT_STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  OPEN: { label: "Waiting", tone: "neutral" },
  SETTLED: { label: "Settled", tone: "positive" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
};

export function SplitScreen() {
  const navigate = useNavigate();
  const [total, setTotal] = useState("");
  const [purpose, setPurpose] = useState("");
  const [emails, setEmails] = useState<string[]>([""]);
  const [includeMe, setIncludeMe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const recent = useAsync(() => api.billSplits());

  const filled = emails.map((e) => e.trim()).filter(Boolean);
  const money = parseMoneyInput(total);
  const preview = money.ok ? previewSplit(money.minorUnits, filled.length, includeMe) : null;

  function setEmailAt(index: number, value: string) {
    setEmails((current) => current.map((e, i) => (i === index ? value : e)));
  }

  function addPerson() {
    setEmails((current) => (current.length >= MAX_PEOPLE - 1 ? current : [...current, ""]));
  }

  function removePerson(index: number) {
    setEmails((current) =>
      current.length === 1 ? [""] : current.filter((_, i) => i !== index)
    );
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!money.ok) {
      setAmountError(money.error);
      return;
    }
    if (money.minorUnits > brand.maxPaymentMinorUnits) {
      setAmountError(`The most you can split at once is ${formatMoney(brand.maxPaymentMinorUnits)}`);
      return;
    }
    if (filled.length === 0) {
      setError("Add at least one other person to split with");
      return;
    }
    setAmountError(null);
    setError(null);
    setSubmitting(true);
    try {
      const { billSplit } = await api.createBillSplit({
        totalMinorUnits: money.minorUnits,
        ...(purpose.trim() ? { purpose: purpose.trim() } : {}),
        participantEmails: filled,
        includeOrganiser: includeMe,
      });
      navigate(`/splits/${billSplit.id}`);
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error ? err.message : "Something went wrong"
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell title="Split a bill" nav={NAV_ITEMS} back="/">
      <form className="ds-stack ds-stack--lg" onSubmit={onSubmit} noValidate>
        <Card>
          <AmountField
            label="Total to split"
            value={total}
            onChange={setTotal}
            error={amountError}
            currencySymbol={brand.currencySymbol}
          />
          <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
            Everyone gets their share as a request they can pay or decline.
          </p>
        </Card>

        <TextField
          label="What's it for? (optional)"
          maxLength={140}
          placeholder="e.g. Dinner at Luca's"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
        />

        <div className="ds-stack">
          <h2 className="ds-section-title">Who's in it?</h2>
          {emails.map((email, i) => (
            <div key={i} className="ds-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <TextField
                  label={`Person ${i + 1}`}
                  type="email"
                  inputMode="email"
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmailAt(i, e.target.value)}
                />
              </div>
              <button
                type="button"
                className="ds-icon-button"
                aria-label={`Remove person ${i + 1}`}
                onClick={() => removePerson(i)}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            onClick={addPerson}
            disabled={emails.length >= MAX_PEOPLE - 1}
          >
            Add another person
          </Button>
          <Checkbox checked={includeMe} onChange={setIncludeMe}>
            I'm paying a share too
          </Checkbox>
        </div>

        {preview ? (
          <Card>
            <div className="ds-stack" data-testid="split-preview">
              <div className="ds-row" style={{ justifyContent: "space-between" }}>
                <span>{includeMe ? "Your share" : "You're not in this one"}</span>
                <strong>{includeMe ? formatMoney(preview.yours) : "—"}</strong>
              </div>
              <div className="ds-row" style={{ justifyContent: "space-between" }}>
                <span>
                  Each of {preview.theirs.length}{" "}
                  {preview.theirs.length === 1 ? "person" : "people"}
                </span>
                <strong>
                  {preview.theirs.length > 0
                    ? preview.theirs.every((t) => t === preview.theirs[0])
                      ? formatMoney(preview.theirs[0])
                      : `${formatMoney(Math.min(...preview.theirs))}–${formatMoney(
                          Math.max(...preview.theirs)
                        )}`
                    : "—"}
                </strong>
              </div>
              <p className="ds-muted ds-small">
                Odd pennies go to your share, so it always adds up exactly.
              </p>
            </div>
          </Card>
        ) : null}

        {error ? <Alert tone="danger">{error}</Alert> : null}

        <Button type="submit" block loading={submitting}>
          {preview && filled.length > 0
            ? `Ask ${filled.length} ${filled.length === 1 ? "person" : "people"}`
            : "Split it"}
        </Button>
      </form>

      <div className="ds-stack">
        <h2 className="ds-section-title">Your recent splits</h2>
        <Card flush>
          {recent.loading && !recent.data ? (
            <div style={{ padding: 20 }}>
              <Skeleton height={20} />
            </div>
          ) : recent.data && recent.data.billSplits.length > 0 ? (
            <ul className="ds-list">
              {recent.data.billSplits.map((s) => {
                const status = SPLIT_STATUS[s.status] ?? { label: s.status, tone: "neutral" as const };
                return (
                  <li key={s.id}>
                    <Link to={`/splits/${s.id}`} className="ds-txn">
                      <div className="ds-txn__text">
                        <div className="ds-txn__title">{formatMoney(s.totalMinorUnits)}</div>
                        <div className="ds-txn__subtitle">
                          {[
                            s.purpose,
                            `${s.shares.length + (s.organiserShareMinorUnits > 0 ? 1 : 0)} people`,
                            `${dayLabel(s.createdAt)}, ${timeLabel(s.createdAt)}`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                      </div>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState icon="split" title="No splits yet">
              Split a bill and everyone gets their share to pay.
            </EmptyState>
          )}
        </Card>
      </div>

      <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
        Simulated funds — nothing real is charged.
      </p>
    </AppShell>
  );
}
