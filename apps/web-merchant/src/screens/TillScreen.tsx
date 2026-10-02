import { Link } from "react-router-dom";
import {
  Alert,
  AppShell,
  BalanceCard,
  Badge,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  SectionTitle,
  Skeleton,
  TransactionRow,
  formatMoney,
} from "@fintech-network/design-system";
import { REQUEST_STATUS_LABELS, dayLabel, timeLabel, useAsync } from "@fintech-network/app-kit";
import { api } from "../api/client";
import { useShop } from "../shop/ShopContext";
import { NAV_ITEMS } from "../nav";

// The screen a shop lives on: what's in the till, one button to take
// money, and what's come in today.

export function TillScreen() {
  const { shop, shops } = useShop();
  const shopId = shop!.id;
  const data = useAsync(async () => {
    const [account, activity, charges] = await Promise.all([
      api.merchantAccount(shopId),
      api.merchantActivity(shopId, { limit: 5 }),
      api.merchantCharges(shopId),
    ]);
    return {
      balance: account.account.balanceMinorUnits,
      items: activity.items,
      waiting: charges.paymentRequests.filter((c) => c.status === "OPEN"),
    };
  }, [shopId]);

  const waiting = data.data?.waiting ?? [];

  return (
    <AppShell
      nav={NAV_ITEMS}
      title={shop!.tradingName}
      headerAction={
        shops.length > 1 ? (
          <Link to="/shops" className="ds-small">
            Switch
          </Link>
        ) : null
      }
    >
      {shop!.status === "suspended" ? (
        <Alert tone="warning" title="This shop can't take payments">
          Charges are blocked while the shop is suspended. What it has already
          taken is still here.
        </Alert>
      ) : null}

      {data.error ? (
        <Alert tone="danger" title="We couldn't load the till">
          <Button variant="ghost" onClick={data.reload}>
            Try again
          </Button>
        </Alert>
      ) : null}

      <BalanceCard
        minorUnits={data.data?.balance ?? null}
        label="In the till"
        meta="Simulated funds · prototype"
      />

      <ButtonLink to="/charge" block>
        Take a payment
      </ButtonLink>

      {waiting.length > 0 ? (
        <div className="ds-stack">
          <SectionTitle>Waiting to be paid</SectionTitle>
          <Card flush>
            <ul className="ds-list">
              {waiting.map((c) => (
                <li key={c.id}>
                  <Link to={`/charge/${c.id}`} className="ds-txn">
                    <div className="ds-txn__text">
                      <div className="ds-txn__title">{formatMoney(c.amountMinorUnits)}</div>
                      <div className="ds-txn__subtitle">
                        {[c.purpose, `${dayLabel(c.createdAt)}, ${timeLabel(c.createdAt)}`]
                          .filter(Boolean)
                          .join(" · ")}
                      </div>
                    </div>
                    <Badge tone="neutral">{REQUEST_STATUS_LABELS[c.status] ?? c.status}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      ) : null}

      <div className="ds-stack">
        <SectionTitle action={{ to: "/takings", label: "See all" }}>Recent takings</SectionTitle>
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
                  to={item.receiptId ? `/receipts/${item.receiptId}` : undefined}
                />
              ))}
            </ul>
          ) : (
            <EmptyState title="Nothing taken yet">
              Take your first payment and it shows up here.
            </EmptyState>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
