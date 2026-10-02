import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Alert, AppShell, Button, PageLoader } from "@fintech-network/design-system";
import { SessionProvider, useSession } from "./session/SessionContext";
import { WelcomeScreen } from "./screens/WelcomeScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { PayScreen } from "./screens/PayScreen";
import { ActivityScreen } from "./screens/ActivityScreen";
import { RequestScreen } from "./screens/RequestScreen";
import { RequestsInboxScreen } from "./screens/RequestsInboxScreen";
import { RewardsScreen } from "./screens/RewardsScreen";
import { SplitScreen } from "./screens/SplitScreen";
import { SplitDetailScreen } from "./screens/SplitDetailScreen";
import { ScanScreen } from "./screens/ScanScreen";
import { PayRequestScreen } from "./screens/PayRequestScreen";
import { ReceiptScreen } from "./screens/ReceiptScreen";
import { ProfileScreen } from "./screens/ProfileScreen";
import { AssistantScreen } from "./screens/AssistantScreen";
import { NotFoundScreen } from "./screens/NotFoundScreen";

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

const guarded = (el: ReactNode) => <RequireSession>{el}</RequireSession>;

export function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/welcome" element={<WelcomeScreen />} />
          <Route path="/" element={guarded(<HomeScreen />)} />
          <Route path="/pay" element={guarded(<PayScreen />)} />
          <Route path="/request" element={guarded(<RequestScreen />)} />
          <Route path="/requests" element={guarded(<RequestsInboxScreen />)} />
          <Route path="/rewards" element={guarded(<RewardsScreen />)} />
          <Route path="/split" element={guarded(<SplitScreen />)} />
          <Route path="/splits/:id" element={guarded(<SplitDetailScreen />)} />
          <Route path="/scan" element={guarded(<ScanScreen />)} />
          {/* Where a scanned QR code lands (and where its link points), and
              where a request sent to you by name is opened. */}
          <Route path="/pay/r/:key" element={guarded(<PayRequestScreen />)} />
          <Route path="/activity" element={guarded(<ActivityScreen />)} />
          <Route path="/receipts/:id" element={guarded(<ReceiptScreen />)} />
          <Route path="/assistant" element={guarded(<AssistantScreen />)} />
          <Route path="/profile" element={guarded(<ProfileScreen />)} />
          <Route path="*" element={<NotFoundScreen />} />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}
