import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Alert, AppShell, Button, PageLoader } from "@fintech-network/design-system";
import { SessionProvider, useSession } from "./session/SessionContext";
import { ShopProvider, useShop } from "./shop/ShopContext";
import { WelcomeScreen } from "./screens/WelcomeScreen";
import { ShopsScreen } from "./screens/ShopsScreen";
import { TillScreen } from "./screens/TillScreen";
import { ChargeScreen } from "./screens/ChargeScreen";
import { TakingsScreen } from "./screens/TakingsScreen";
import { TeamScreen } from "./screens/TeamScreen";
import { ShopScreen } from "./screens/ShopScreen";
import { ReceiptScreen } from "./screens/ReceiptScreen";

// Two gates, in order: are you signed in, and are you working for a
// shop? Every screen past them can assume both, which is why they read
// `shop!` without checking.

function RequireSession({ children }: { children: ReactNode }) {
  const { status, retry } = useSession();
  const location = useLocation();
  if (status === "unavailable") {
    return (
      <AppShell title="Can't reach the server">
        <Alert tone="danger" title="We couldn't load your account">
          You're still signed in. Check your connection and try again.
        </Alert>
        <Button block onClick={retry}>
          Try again
        </Button>
      </AppShell>
    );
  }
  if (status === "loading") {
    return (
      <AppShell>
        <PageLoader />
      </AppShell>
    );
  }
  if (status === "signed-out") {
    return <Navigate to="/welcome" replace state={{ from: location.pathname }} />;
  }
  return <>{children}</>;
}

function RequireShop({ children }: { children: ReactNode }) {
  const { shop, loading } = useShop();
  if (loading && !shop) {
    return (
      <AppShell>
        <PageLoader label="Loading your shops" />
      </AppShell>
    );
  }
  // Nobody has a shop the first time. The shops screen is where they
  // register one, so that's where they land.
  if (!shop) return <Navigate to="/shops" replace />;
  return <>{children}</>;
}

const guarded = (el: ReactNode) => (
  <RequireSession>
    <RequireShop>{el}</RequireShop>
  </RequireSession>
);

export function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <ShopProvider>
          <Routes>
            <Route path="/welcome" element={<WelcomeScreen />} />
            {/* Reachable without a shop — it's where you get one. */}
            <Route
              path="/shops"
              element={
                <RequireSession>
                  <ShopsScreen />
                </RequireSession>
              }
            />
            <Route path="/" element={guarded(<TillScreen />)} />
            <Route path="/charge" element={guarded(<ChargeScreen />)} />
            <Route path="/charge/:id" element={guarded(<ChargeScreen />)} />
            <Route path="/takings" element={guarded(<TakingsScreen />)} />
            <Route path="/team" element={guarded(<TeamScreen />)} />
            <Route path="/shop" element={guarded(<ShopScreen />)} />
            <Route path="/receipts/:id" element={guarded(<ReceiptScreen />)} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </ShopProvider>
      </BrowserRouter>
    </SessionProvider>
  );
}
