import { createSession } from "@fintech-network/app-kit";
import { api, http } from "../api/client";

// The same sign-in as the other two apps, with its own cookie scope and
// its own hint key so all three can be open at once on one machine.
// There is no registration path here: an admin account has never been
// creatable from a public endpoint.
const { SessionProvider, useSession } = createSession({
  http,
  auth: api,
  hintKey: "fn.admin.session.hint",
});

export { SessionProvider, useSession };
