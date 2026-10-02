import { useCallback, useEffect, useState } from "react";
import type { ActivityItemDto } from "@fintech-network/shared-types";
import {
  Alert,
  AppShell,
  Button,
  Card,
  EmptyState,
  Skeleton,
  TransactionRow,
} from "@fintech-network/design-system";
import { dayLabel, groupByDay, timeLabel } from "@fintech-network/app-kit";
import { api } from "../api/client";
import { useShop } from "../shop/ShopContext";
import { NAV_ITEMS } from "../nav";

// Everything the shop has taken, newest first, a page at a time — the
// same ledger-backed view as a person's activity, for the shop's own
// account.

const PAGE_SIZE = 20;

export function TakingsScreen() {
  const { shop } = useShop();
  const shopId = shop!.id;
  const [items, setItems] = useState<ActivityItemDto[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const loadFirstPage = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    api
      .merchantActivity(shopId, { limit: PAGE_SIZE })
      .then((page) => {
        if (cancelled) return;
        setItems(page.items);
        setCursor(page.nextCursor);
        setError(null);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [shopId]);

  useEffect(() => loadFirstPage(), [loadFirstPage]);

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const page = await api.merchantActivity(shopId, { limit: PAGE_SIZE, cursor });
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoadingMore(false);
    }
  }

  const groups = groupByDay(items, (item) => item.occurredAt);

  return (
    <AppShell title="Takings" nav={NAV_ITEMS}>
      {error ? (
        <Alert tone="danger" title="We couldn't load your takings">
          <Button variant="ghost" onClick={loadFirstPage}>
            Try again
          </Button>
        </Alert>
      ) : null}

      {loading && items.length === 0 ? (
        <Card flush>
          <div className="ds-stack" style={{ padding: 20 }}>
            <Skeleton height={20} />
            <Skeleton height={20} width="70%" />
          </div>
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState title="Nothing taken yet">
            Payments the shop takes show up here, with who paid and what for.
          </EmptyState>
        </Card>
      ) : (
        <>
          {groups.map((group) => (
            <div className="ds-stack" key={group.label}>
              <h2 className="ds-section-title">{group.label}</h2>
              <Card flush>
                <ul className="ds-list">
                  {group.items.map((item) => (
                    <TransactionRow
                      key={item.id}
                      title={item.title}
                      subtitle={[item.purpose, timeLabel(item.occurredAt)]
                        .filter(Boolean)
                        .join(" · ")}
                      minorUnits={item.amountMinorUnits}
                      direction={item.direction}
                      balanceAfterMinorUnits={item.balanceAfterMinorUnits}
                      to={item.receiptId ? `/receipts/${item.receiptId}` : undefined}
                    />
                  ))}
                </ul>
              </Card>
            </div>
          ))}
          {cursor ? (
            <Button block variant="secondary" onClick={loadMore} loading={loadingMore}>
              Show older
            </Button>
          ) : (
            <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
              That's everything since {dayLabel(items[items.length - 1].occurredAt)}.
            </p>
          )}
        </>
      )}
    </AppShell>
  );
}
