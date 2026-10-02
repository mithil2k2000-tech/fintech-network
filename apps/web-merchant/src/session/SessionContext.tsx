import { createSession } from "@fintech-network/app-kit";
import { api, http } from "../api/client";

// The same sign-in as the consumer app, because it is the same person:
// nobody signs in "as a shop". Its session cookie is scoped to this app
// (see api/client.ts), so both apps can be open in one browser without
// treading on each other.
const { SessionProvider, useSession } = createSession({ http, auth: api, hintKey: "fn.merchant.session.hint" });

export { SessionProvider, useSession };
