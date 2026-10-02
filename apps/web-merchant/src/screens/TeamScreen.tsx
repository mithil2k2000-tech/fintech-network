import { useState, type FormEvent } from "react";
import {
  Alert,
  AppShell,
  Badge,
  Button,
  Card,
  PageLoader,
  SegmentedControl,
  TextField,
} from "@fintech-network/design-system";
import { dateLabel, useAsync } from "@fintech-network/app-kit";
import { ApiError, api } from "../api/client";
import { useShop } from "../shop/ShopContext";
import { NAV_ITEMS } from "../nav";

// Who can work the till. Owners can bring people in; staff can see the
// team but not change it — which is what the API enforces, so this
// screen only has to be honest about it.

type Role = "owner" | "staff";

export function TeamScreen() {
  const { shop } = useShop();
  const shopId = shop!.id;
  const isOwner = shop!.yourRole === "owner";
  const members = useAsync(() => api.merchantMembers(shopId), [shopId]);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("staff");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function addMember(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await api.addMerchantMember(shopId, { email: email.trim(), role });
      setEmail("");
      members.reload();
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : "Something went wrong"
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppShell title="Team" nav={NAV_ITEMS}>
      {members.loading && !members.data ? (
        <PageLoader label="Loading the team" />
      ) : members.data ? (
        <Card flush>
          <ul className="ds-list">
            {members.data.members.map((member) => (
              <li key={member.userId}>
                <div className="ds-txn">
                  <div className="ds-txn__text">
                    <div className="ds-txn__title">
                      {member.displayName}
                      {member.isYou ? " (you)" : ""}
                    </div>
                    <div className="ds-txn__subtitle">Added {dateLabel(member.addedAt)}</div>
                  </div>
                  <Badge tone={member.role === "owner" ? "positive" : "neutral"}>
                    {member.role === "owner" ? "Owner" : "Staff"}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : (
        <Alert tone="danger" title="We couldn't load the team">
          <Button variant="ghost" onClick={members.reload}>
            Try again
          </Button>
        </Alert>
      )}

      {isOwner ? (
        <form className="ds-stack ds-stack--lg" onSubmit={addMember} noValidate>
          <h2 className="ds-section-title">Add someone</h2>
          <TextField
            label="Their email"
            hint="They need an account on this network already"
            type="email"
            inputMode="email"
            placeholder="name@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <SegmentedControl<Role>
            label="What they can do"
            value={role}
            onChange={setRole}
            options={[
              { value: "staff", label: "Staff" },
              { value: "owner", label: "Owner" },
            ]}
          />
          <p className="ds-muted ds-small">
            Staff can take payments and see the takings. Owners can also add
            and remove people.
          </p>
          {error ? <Alert tone="danger">{error}</Alert> : null}
          <Button type="submit" block loading={submitting} disabled={!email.trim()}>
            Add to the team
          </Button>
        </form>
      ) : (
        <Alert tone="info">Only an owner of this shop can add people.</Alert>
      )}

      <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
        Taking someone off the team isn't built yet.
      </p>
    </AppShell>
  );
}
