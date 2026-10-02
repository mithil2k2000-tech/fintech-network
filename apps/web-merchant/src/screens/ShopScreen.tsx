import { useNavigate } from "react-router-dom";
import {
  Alert,
  AppShell,
  Badge,
  Button,
  ButtonLink,
  Card,
  DetailList,
} from "@fintech-network/design-system";
import { dateLabel } from "@fintech-network/app-kit";
import { brand } from "../config/brand";
import { useSession } from "../session/SessionContext";
import { useShop } from "../shop/ShopContext";
import { NAV_ITEMS } from "../nav";

// The shop's own details, and the honest notice about what registering
// here does and doesn't prove.

export function ShopScreen() {
  const navigate = useNavigate();
  const { user, signOut } = useSession();
  const { shop, shops } = useShop();

  return (
    <AppShell title="Shop" nav={NAV_ITEMS}>
      <Card>
        <DetailList
          rows={[
            { label: "Trading name", value: shop!.tradingName, stacked: true },
            { label: "Registered name", value: shop!.legalName, stacked: true },
            { label: "Contact", value: shop!.contactEmail, stacked: true },
            {
              label: "Status",
              value: (
                <Badge tone={shop!.status === "active" ? "positive" : "warning"}>
                  {shop!.status === "active" ? "Taking payments" : "Suspended"}
                </Badge>
              ),
            },
            { label: "Your role", value: shop!.yourRole === "owner" ? "Owner" : "Staff" },
            { label: "Registered", value: dateLabel(shop!.createdAt) },
          ]}
        />
      </Card>

      <Alert tone="info" title="Not a verified business">
        Having an account here says a person registered this shop — nothing
        more. No company check, no documents, no screening. Customers see the
        same thing before they pay.
      </Alert>

      <Card>
        <DetailList
          rows={[
            { label: "Signed in as", value: user?.email ?? "—", stacked: true },
            { label: "App", value: `${brand.name} for business` },
          ]}
        />
      </Card>

      {shops.length > 1 ? (
        <ButtonLink to="/shops" block variant="secondary">
          Switch shop
        </ButtonLink>
      ) : (
        <ButtonLink to="/shops" block variant="secondary">
          Register another shop
        </ButtonLink>
      )}

      <Button
        block
        variant="ghost"
        onClick={() => {
          signOut();
          navigate("/welcome");
        }}
      >
        Sign out
      </Button>

      <p className="ds-muted ds-small" style={{ textAlign: "center" }}>
        Prototype — simulated financial infrastructure, no real money.
      </p>
    </AppShell>
  );
}
