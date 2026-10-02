import { Link } from "react-router-dom";
import {
  Alert,
  AppShell,
  Badge,
  Button,
  Card,
  EmptyState,
  PageLoader,
  formatMoney,
} from "@fintech-network/design-system";
import { dayLabel, timeLabel, useAsync } from "@fintech-network/app-kit";
import { api } from "../api/client";
import { NAV_ITEMS } from "../nav";
import { RewardTree } from "./rewards/RewardTree";

// Rewards: what you've earned, and the tree it has grown. Everything on
// this screen is worked out by the server from cashback already granted
// — including the rate and the thresholds — so the app can't promise
// something the rules don't give.

export function RewardsScreen() {
  const data = useAsync(async () => {
    const [tree, cashback] = await Promise.all([api.rewardsTree(), api.cashback()]);
    return { ...tree, cashback: cashback.cashback };
  });

  if (data.loading && !data.data) {
    return (
      <AppShell title="Rewards" nav={NAV_ITEMS}>
        <PageLoader label="Loading your rewards" />
      </AppShell>
    );
  }

  if (data.error || !data.data) {
    return (
      <AppShell title="Rewards" nav={NAV_ITEMS}>
        <Alert tone="danger" title="We couldn't load your rewards">
          <Button variant="ghost" onClick={data.reload}>
            Try again
          </Button>
        </Alert>
      </AppShell>
    );
  }

  const { tree, stages, cashback } = data.data;
  const earnedNothingYet = tree.totalEarnedMinorUnits === 0;

  return (
    <AppShell title="Rewards" nav={NAV_ITEMS}>
      <Card>
        <div className="ds-stack">
          <RewardTree level={tree.stage.level} leaves={tree.leaves} label={tree.stage.name} />
          <div style={{ textAlign: "center" }}>
            <div className="ds-figure" data-testid="cashback-total">
              {formatMoney(tree.totalEarnedMinorUnits)}
            </div>
            <div className="ds-muted ds-small">earned back so far</div>
          </div>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <Badge tone="positive">{tree.stage.name}</Badge>
          </div>
        </div>
      </Card>

      {tree.nextStage ? (
        <Card>
          <div className="ds-stack">
            <div className="ds-row" style={{ justifyContent: "space-between" }}>
              <span>Next: {tree.nextStage.name}</span>
              <strong>{formatMoney(tree.toNextStageMinorUnits)} to go</strong>
            </div>
            {/* A plain, honest bar: the server's percentage, nothing invented. */}
            <div
              className="ds-progress"
              role="progressbar"
              aria-valuenow={tree.progressPercent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`Progress to ${tree.nextStage.name}`}
            >
              <div className="ds-progress__fill" style={{ width: `${tree.progressPercent}%` }} />
            </div>
            <p className="ds-muted ds-small">
              {tree.progressPercent}% of the way there. Earn{" "}
              {cashback.offer.ratePercent}% back every time you pay a shop.
            </p>
          </div>
        </Card>
      ) : (
        <Alert tone="success" title="Fully grown">
          Your tree has reached {tree.stage.name}. Cashback keeps arriving all
          the same.
        </Alert>
      )}

      <div className="ds-stack">
        <h2 className="ds-section-title">How it grows</h2>
        <Card flush>
          <ul className="ds-list">
            {stages.map((stage) => {
              const reached = stage.level <= tree.stage.level;
              return (
                <li key={stage.level}>
                  <div className="ds-txn">
                    <div className="ds-txn__text">
                      <div className="ds-txn__title" style={{ opacity: reached ? 1 : 0.55 }}>
                        {stage.name}
                      </div>
                      <div className="ds-txn__subtitle">
                        {stage.fromMinorUnits === 0
                          ? "Where everyone starts"
                          : `${formatMoney(stage.fromMinorUnits)} earned back`}
                      </div>
                    </div>
                    {reached ? <Badge tone="positive">Reached</Badge> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <div className="ds-stack">
        <h2 className="ds-section-title">Cashback you've earned</h2>
        <Card flush>
          {earnedNothingYet ? (
            <EmptyState icon="leaf" title="Nothing yet">
              Pay a shop and {cashback.offer.ratePercent}% comes back to you, on
              anything over {formatMoney(cashback.offer.minimumSpendMinorUnits)}.
            </EmptyState>
          ) : (
            <ul className="ds-list">
              {cashback.grants.map((grant) => (
                <li key={grant.id}>
                  <div className="ds-txn">
                    <div className="ds-txn__text">
                      <div className="ds-txn__title">
                        {formatMoney(grant.amountMinorUnits)} back
                      </div>
                      <div className="ds-txn__subtitle">
                        {grant.ratePercent}% of {formatMoney(grant.spendMinorUnits)} ·{" "}
                        {dayLabel(grant.earnedAt)}, {timeLabel(grant.earnedAt)}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* The wording comes from the server, so no client can soften it. */}
      <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
        {tree.disclaimer}
      </p>
      <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
        <Link to="/activity">See cashback in your activity</Link>
      </p>
    </AppShell>
  );
}
