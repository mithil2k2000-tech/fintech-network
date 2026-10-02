import { Link } from "react-router-dom";
import {
  ActionTiles,
  Alert,
  AppShell,
  BalanceCard,
  Button,
  Card,
  EmptyState,
  Icon,
  SectionTitle,
  Skeleton,
  TransactionRow,
  formatMoney,
} from "@fintech-network/design-system";
import { api } from "../api/client";
import { useAsync } from "../lib/useAsync";
import { firstNameFromEmail, dayLabel, timeLabel } from "../lib/format";
import { useSession } from "../session/SessionContext";
import { HOME_ACTIONS, NAV_ITEMS } from "../nav";

export function HomeScreen() {
  const { user } = useSession();
  const data = useAsync(async () => {
    const [account, activity, incoming, cashback] = await Promise.all([
      api.account(),
      api.activity({ limit: 5 }),
      // A request waiting on you is the one thing here worth interrupting
      // for, so it's fetched with the balance rather than on its own screen.
      api.incomingPaymentRequests(),
      api.cashback(),
    ]);
    return {
      balance: account.account.balanceMinorUnits,
      items: activity.items,
      waiting: incoming.paymentRequests.filter((r) => r.status === "OPEN"),
      cashback: cashback.cashback,
    };
  });
  const waiting = data.data?.waiting ?? [];
  const cashback = data.data?.cashback;

  return (
    <AppShell nav={NAV_ITEMS} title={`Hello, ${firstNameFromEmail(user?.email ?? "")}`}>
      {data.error ? (
        <Alert tone="danger" title="We couldn't load your account">
          <Button variant="ghost" onClick={data.reload}>
            Try again
          </Button>
        </Alert>
      ) : null}

      <BalanceCard
        minorUnits={data.data?.balance ?? null}
        meta="Simulated funds · prototype"
      />

      {waiting.length > 0 ? (
        <Link to="/requests" className="ds-prompt" data-testid="waiting-requests">
          <span className="ds-avatar ds-avatar--accent" aria-hidden="true">
            <Icon name="request" size={22} />
          </span>
          <span>
            <span style={{ fontWeight: 650 }}>
              {waiting.length === 1
                ? `${waiting[0].requester.displayName} asked you for ${formatMoney(
                    waiting[0].amountMinorUnits
                  )}`
                : `${waiting.length} requests are waiting for you`}
            </span>
            <span className="ds-muted ds-small" style={{ display: "block" }}>
              Tap to pay or decline.
            </span>
          </span>
          <Icon name="chevron" size={20} aria-hidden="true" />
        </Link>
      ) : null}

      <ActionTiles actions={HOME_ACTIONS} />

      {/* The assistant explains and looks things up; it can't move money,
          so this is a link to a screen and not a shortcut to an action. */}
      <Link to="/assistant" className="ds-prompt" data-testid="ask-prompt">
        <span className="ds-avatar ds-avatar--accent" aria-hidden="true">
          <Icon name="ask" size={22} />
        </span>
        <span>
          <span style={{ fontWeight: 650 }}>Ask about your money</span>
          <span className="ds-muted ds-small" style={{ display: "block" }}>
            Your balance, your spending, or why a payment was flagged.
          </span>
        </span>
        <Icon name="chevron" size={20} aria-hidden="true" />
      </Link>

      <div className="ds-stack">
        <SectionTitle action={{ to: "/activity", label: "See all" }}>Recent activity</SectionTitle>
        <Card flush>
          {data.loading && !data.data ? (
            <div className="ds-stack" style={{ padding: 20 }}>
              <Skeleton height={20} />
              <Skeleton height={20} width="70%" />
            </div>
          ) : data.data && data.data.items.length > 0 ? (
            <ul className="ds-list">
              {data.data.items.map((item) => (
                <TransactionRow
                  key={item.id}
                  title={item.title}
                  subtitle={[item.purpose, `${dayLabel(item.occurredAt)}, ${timeLabel(item.occurredAt)}`]
                    .filter(Boolean)
                    .join(" · ")}
                  minorUnits={item.amountMinorUnits}
                  direction={item.direction}
                  accent={item.kind !== "payment"}
                  to={item.receiptId ? `/receipts/${item.receiptId}` : undefined}
                />
              ))}
            </ul>
          ) : (
            <EmptyState title="No activity yet">Payments you send and receive show up here.</EmptyState>
          )}
        </Card>
      </div>

      {/* The rate comes from the server, so this card can't promise
          something the rule doesn't actually give. */}
      <Card>
        <div className="ds-row">
          <span className="ds-avatar ds-avatar--accent" aria-hidden="true">
            <Icon name="leaf" size={22} />
          </span>
          <div>
            <div style={{ fontWeight: 650 }}>
              {cashback && cashback.totalEarnedMinorUnits > 0
                ? `You've earned ${formatMoney(cashback.totalEarnedMinorUnits)} back`
                : "Cashback on every shop"}
            </div>
            <div className="ds-muted ds-small">
              {cashback
                ? `${cashback.offer.ratePercent}% back when you pay a shop, on anything over ${formatMoney(
                    cashback.offer.minimumSpendMinorUnits
                  )}.`
                : "Cashback comes back to you when you pay a registered shop."}{" "}
              <Link to="/rewards">See your tree</Link>
            </div>
          </div>
        </div>
      </Card>
    </AppShell>
  );
}
