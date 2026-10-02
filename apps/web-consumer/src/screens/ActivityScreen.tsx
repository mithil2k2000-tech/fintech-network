import { useState } from "react";
import type { ActivityItemDto } from "@fintech-network/shared-types";
import {
  Alert,
  AppShell,
  Button,
  ButtonLink,
  Card,
  EmptyState,
  PageLoader,
  TransactionRow,
} from "@fintech-network/design-system";
import { api } from "../api/client";
import { groupByDay, timeLabel } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { NAV_ITEMS } from "../nav";

const PAGE_SIZE = 20;

export function ActivityScreen() {
  const first = useAsync(() => api.activity({ limit: PAGE_SIZE }));
  const [more, setMore] = useState<ActivityItemDto[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const items = [...(first.data?.items ?? []), ...more];
  const nextCursor = cursor === undefined ? first.data?.nextCursor ?? null : cursor;

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const page = await api.activity({ limit: PAGE_SIZE, cursor: nextCursor });
      setMore((m) => [...m, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      setMoreError(err instanceof Error ? err.message : "Couldn't load more");
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <AppShell title="Activity" nav={NAV_ITEMS}>
      {first.loading ? <PageLoader label="Loading activity" /> : null}
      {first.error ? (
        <Alert tone="danger" title="We couldn't load your activity">
          <Button variant="ghost" onClick={first.reload}>
            Try again
          </Button>
        </Alert>
      ) : null}

      {first.data && items.length === 0 ? (
        <Card>
          <EmptyState title="No activity yet">
            <div className="ds-stack">
              <span>Money you send and receive will show up here.</span>
              <ButtonLink to="/pay">Make a payment</ButtonLink>
            </div>
          </EmptyState>
        </Card>
      ) : null}

      {items.length > 0 ? (
        <Card flush>
          {groupByDay(items, (i) => i.occurredAt).map((group) => (
            <section key={group.label} aria-label={group.label}>
              <h2 className="ds-list-group__label">{group.label}</h2>
              <ul className="ds-list">
                {group.items.map((item) => (
                  <TransactionRow
                    key={item.id}
                    title={item.title}
                    subtitle={[item.purpose, timeLabel(item.occurredAt)].filter(Boolean).join(" · ")}
                    minorUnits={item.amountMinorUnits}
                    direction={item.direction}
                    balanceAfterMinorUnits={item.balanceAfterMinorUnits}
                    accent={item.kind !== "payment"}
                    to={item.receiptId ? `/receipts/${item.receiptId}` : undefined}
                  />
                ))}
              </ul>
            </section>
          ))}
        </Card>
      ) : null}

      {moreError ? <Alert tone="danger">{moreError}</Alert> : null}
      {nextCursor ? (
        <Button variant="secondary" block onClick={loadMore} loading={loadingMore}>
          Show older activity
        </Button>
      ) : null}
    </AppShell>
  );
}
