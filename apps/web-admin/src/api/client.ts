// The one place this app names an API endpoint. The HTTP machinery and
// the session are shared with the other two apps
// (@fintech-network/app-kit); what's here is the handful of endpoints
// an operations view needs — all of them reads.
import { createHttpClient } from "@fintech-network/app-kit";
import type {
  AuthResponse,
  OperationsOverviewDto,
  UserDto,
} from "@fintech-network/shared-types";

export { ApiError } from "@fintech-network/app-kit";

export const http = createHttpClient("/api/v1", { sessionScope: "admin" });
const request = http.request.bind(http);

export const api = {
  login: (email: string, password: string) =>
    request<AuthResponse>("POST", "/auth/login", { email, password }, { auth: false }),
  // There is no registration here, by design: an admin account has
  // never been creatable from a public endpoint, and this app is not
  // going to be the first one to offer it.
  register: (): Promise<never> => {
    throw new Error("Admin accounts are not created from the app");
  },
  me: () => request<{ user: UserDto }>("GET", "/users/me"),
  logout: () => request<void>("POST", "/auth/logout", undefined, { auth: false }),

  overview: (windowHours: number) =>
    request<{ overview: OperationsOverviewDto; maxWindowHours: number }>(
      "GET",
      `/admin/overview?windowHours=${encodeURIComponent(String(windowHours))}`
    ),
};
