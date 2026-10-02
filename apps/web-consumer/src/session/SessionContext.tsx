import { createSession } from "@fintech-network/app-kit";
import { api, http } from "../api/client";

// Signing in and staying signed in is the same job in every app in this
// network, so the machinery lives in @fintech-network/app-kit. What's
// local is which API this app talks to. Since Phase 14 the session
// itself is an httpOnly cookie the API sets, so there is nothing to
// keep here — which app a cookie belongs to is settled by the session
// scope this app's HTTP client sends (see api/client.ts).
const { SessionProvider, useSession } = createSession({ http, auth: api, hintKey: "fn.session.hint" });

export { SessionProvider, useSession };
export type { SessionValue, SessionStatus } from "@fintech-network/app-kit";
