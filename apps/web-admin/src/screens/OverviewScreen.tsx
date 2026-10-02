import { useState } from "react";
import {
  Alert,
  AppShell,
  Badge,
  Button,
  Card,
  DetailList,
  EmptyState,
  PageLoader,
  SectionTitle,
  SegmentedControl,
  formatMoney,
} from "@fintech-network/design-system";
import { useAsync } from "@fintech-network/app-kit";
import { api } from "../api/client";
import { useSession } from "../session/SessionContext";

const APP_NAME = import.meta.env.VITE_APP_NAME ?? "FinTech Network";

const WINDOWS = [
  { value: "24", label: "24 hours" },
  { value: "168", label: "7 days" },
  { value: "720", label: "30 days" },
];

// What the network is doing and what it's costing. Everything on this
// screen is read live from the database, so "the books balance" means
// they balance now, not that they balanced when something last wrote a
// number down.

function CountTable({
  rows,
  empty,
}: {
  rows: { label: string; value: string }[];
  empty: string;
}) {
  if (rows.length === 0) {
    return <EmptyState title={empty}>Nothing in this window.</EmptyState>;
  }
  return (
    <DetailList rows={rows.map((row) => ({ label: row.label, value: row.value }))} />
  );
}

export function OverviewScreen() {
  const { user, signOut } = useSession();
  const [windowHours, setWindowHours] = useState("24");
  const data = useAsync(async () => (await api.overview(Number(windowHours))).overview, [
    windowHours,
  ]);

  if (data.loading && !data.data) {
    return (
      <AppShell title="Operations">
        <PageLoader label="Loading the overview" />
      </AppShell>
    );
  }

  if (data.error || !data.data) {
    return (
      <AppShell title="Operations">
        <Alert tone="danger" title="We couldn't load the overview">
          {data.error instanceof Error ? data.error.message : null}
          <Button variant="ghost" onClick={data.reload}>
            Try again
          </Button>
        </Alert>
        <Button variant="danger" block onClick={signOut}>
          Sign out
        </Button>
      </AppShell>
    );
  }

  const overview = data.data;
  const payments = overview.payments.byStatus;
  const completed = payments.find((p) => p.status === "COMPLETED");

  return (
    <AppShell title={`${APP_NAME} Admin`}>
      <div className="ds-row" style={{ justifyContent: "space-between" }}>
        <span className="ds-muted ds-small">{user?.email}</span>
        <Button variant="ghost" onClick={signOut}>
          Sign out
        </Button>
      </div>

      <SegmentedControl
        label="Window"
        options={WINDOWS}
        value={windowHours}
        onChange={setWindowHours}
      />

      {/* The one thing on this screen that is a yes or a no. */}
      <Card>
        <div className="ds-row" style={{ justifyContent: "space-between" }}>
          <div>
            <div style={{ fontWeight: 650 }}>The books</div>
            <div className="ds-muted ds-small">
              {overview.ledger.entries.toLocaleString()} entries, checked just now
            </div>
          </div>
          <Badge tone={overview.ledger.balanced ? "positive" : "danger"}>
            {overview.ledger.balanced ? "Balanced" : "Out of balance"}
          </Badge>
        </div>
        {!overview.ledger.balanced ? (
          <Alert tone="danger" title="Stop and look at this">
            {overview.ledger.unbalancedTransactions} unbalanced transactions,{" "}
            {overview.ledger.negativeOwnerAccounts} accounts below zero.
          </Alert>
        ) : null}
      </Card>

      <div className="ds-stack">
        <SectionTitle>Cashback</SectionTitle>
        <Card>
          <DetailList
            rows={[
              {
                label: "Paid out, ever",
                value: formatMoney(overview.rewards.paidOutMinorUnits),
              },
              {
                label: "Reserve balance",
                value: formatMoney(overview.rewards.reserveBalanceMinorUnits),
              },
            ]}
          />
          {/* Said plainly, because the number alone looks like a bug. */}
          <p className="ds-muted ds-small">
            The reserve is funded by nothing, so its balance is negative and gets
            more so. That figure is what the offer has cost.
          </p>
        </Card>
      </div>

      <div className="ds-stack">
        <SectionTitle>Payments</SectionTitle>
        <Card>
          <CountTable
            empty="No payments"
            rows={payments.map((row) => ({
              label: row.status,
              value: `${row.count} · ${formatMoney(row.totalMinorUnits)}`,
            }))}
          />
          {completed ? (
            <p className="ds-muted ds-small">
              {completed.count} completed, {formatMoney(completed.totalMinorUnits)} moved.
            </p>
          ) : null}
        </Card>
        {overview.payments.failuresByReason.length > 0 ? (
          <Card>
            <CountTable
              empty="No failures"
              rows={overview.payments.failuresByReason.map((row) => ({
                label: row.reason,
                value: String(row.count),
              }))}
            />
          </Card>
        ) : null}
      </div>

      <div className="ds-stack">
        <SectionTitle>Risk</SectionTitle>
        <Card>
          <CountTable
            empty="No assessments"
            rows={overview.risk.byLevel.map((row) => ({
              label: row.level,
              value: String(row.count),
            }))}
          />
          <p className="ds-muted ds-small">
            Which rules fired — a rule that never appears here is doing nothing,
            and one that appears on everything is saying nothing.
          </p>
          <CountTable
            empty="No rules fired"
            rows={overview.risk.firedRules.map((row) => ({
              label: row.rule,
              value: String(row.count),
            }))}
          />
        </Card>
      </div>

      <div className="ds-stack">
        <SectionTitle>Security</SectionTitle>
        <Card>
          <CountTable
            empty="Nothing to report"
            rows={overview.security.map((row) => ({
              label: row.eventType,
              value: String(row.count),
            }))}
          />
        </Card>
      </div>

      <Alert tone="info">
        Prototype only — simulated financial infrastructure, no real money.
      </Alert>
    </AppShell>
  );
}
