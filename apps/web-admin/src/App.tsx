import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Alert, AppShell, Button, PageLoader } from "@fintech-network/design-system";
import { SessionProvider, useSession } from "./session/SessionContext";
import { SignInScreen } from "./screens/SignInScreen";
import { OverviewScreen } from "./screens/OverviewScreen";

// The admin app: an operations view, and nothing that changes anything.
// It was a placeholder shell from Phase 1 until Phase 15, which is when
// there was finally something worth putting in it — the numbers nobody
// could see: what the cashback reserve has cost, what the risk engine
// decides, and whether the books still balance.

function RequireAdmin({ children }: { children: ReactNode }) {
  const { status, user, retry, signOut } = useSession();
  if (status === "unavailable") {
    return (
      <AppShell title="Can't reach the server">
        <Alert tone="danger" title="We couldn't load your account">
          Check the API and try again.
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
  if (status === "signed-out") return <Navigate to="/signin" replace />;
  // A consumer who signs in here gets told plainly rather than shown a
  // screen full of 403s. The API is the thing enforcing this; the app
  // only avoids pretending otherwise.
  if (user && user.role !== "admin") {
    return (
      <AppShell title="Not an admin account">
        <Alert tone="danger" title="This account can't see the admin app">
          You're signed in as {user.email}, which isn't an administrator.
        </Alert>
        <Button block variant="danger" onClick={signOut}>
          Sign out
        </Button>
      </AppShell>
    );
  }
  return <>{children}</>;
}

export function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/signin" element={<SignInScreen />} />
          <Route
            path="/"
            element={
              <RequireAdmin>
                <OverviewScreen />
              </RequireAdmin>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}
