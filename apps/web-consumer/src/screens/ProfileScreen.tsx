import { Link } from "react-router-dom";
import { Alert, AppShell, Avatar, Button, Card, DetailList, Icon } from "@fintech-network/design-system";
import { brand } from "../config/brand";
import { dateLabel } from "../lib/format";
import { useSession } from "../session/SessionContext";
import { NAV_ITEMS } from "../nav";

const ROLE_LABELS = { consumer: "Personal", merchant: "Business", admin: "Administrator" } as const;

export function ProfileScreen() {
  const { user, signOut } = useSession();
  if (!user) return null;
  return (
    <AppShell title="Profile" nav={NAV_ITEMS}>
      <div className="ds-summary">
        <Avatar name={user.email} accent large />
        <div style={{ fontWeight: 700, overflowWrap: "anywhere" }}>{user.email}</div>
      </div>
      <Card>
        <DetailList
          rows={[
            { label: "Account type", value: ROLE_LABELS[user.role] },
            { label: "Member since", value: dateLabel(user.createdAt) },
          ]}
        />
      </Card>
      <Link to="/assistant" className="ds-prompt">
        <span className="ds-avatar ds-avatar--accent" aria-hidden="true">
          <Icon name="ask" size={22} />
        </span>
        <span>
          <span style={{ fontWeight: 650 }}>Ask about your money</span>
          <span className="ds-muted ds-small" style={{ display: "block" }}>
            Questions about your own account, answered from your own account.
          </span>
        </span>
        <Icon name="chevron" size={20} aria-hidden="true" />
      </Link>
      <Alert tone="info" title={`About ${brand.name}`}>
        This is a prototype. Balances and payments are simulated, no real money
        moves, and it isn't an authorised financial service.
      </Alert>
      <Button variant="danger" block onClick={signOut}>
        <Icon name="logout" size={20} />
        Sign out
      </Button>
    </AppShell>
  );
}
