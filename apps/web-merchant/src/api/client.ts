// The one place this app names an API endpoint. The HTTP machinery is
// shared with the consumer app (@fintech-network/app-kit); what's here
// is only which endpoints a till needs.
import { createHttpClient } from "@fintech-network/app-kit";
import type {
  AccountDto,
  ActivityPageDto,
  AuthResponse,
  MerchantDto,
  MerchantMemberDto,
  OwnPaymentRequestDto,
  ReceiptDto,
  UserDto,
} from "@fintech-network/shared-types";

export { ApiError } from "@fintech-network/app-kit";

export const http = createHttpClient("/api/v1", { sessionScope: "merchant" });
const request = http.request.bind(http);

export const api = {
  register: (email: string, password: string) =>
    request<AuthResponse>("POST", "/auth/register", { email, password }, { auth: false }),
  login: (email: string, password: string) =>
    request<AuthResponse>("POST", "/auth/login", { email, password }, { auth: false }),
  me: () => request<{ user: UserDto }>("GET", "/users/me"),
  // The session cookie is httpOnly, so only the server can drop it.
  logout: () => request<void>("POST", "/auth/logout", undefined, { auth: false }),

  merchants: () => request<{ merchants: MerchantDto[] }>("GET", "/merchants"),
  merchant: (id: string) =>
    request<{ merchant: MerchantDto }>("GET", `/merchants/${encodeURIComponent(id)}`),
  createMerchant: (input: {
    legalName: string;
    tradingName: string;
    contactEmail: string;
  }) => request<{ merchant: MerchantDto }>("POST", "/merchants", input),

  merchantAccount: (id: string) =>
    request<{ account: AccountDto }>("GET", `/merchants/${encodeURIComponent(id)}/account`),
  merchantActivity: (id: string, options: { limit?: number; cursor?: string | null } = {}) => {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const qs = params.toString();
    return request<ActivityPageDto>(
      "GET",
      `/merchants/${encodeURIComponent(id)}/activity${qs ? `?${qs}` : ""}`
    );
  },
  merchantCharges: (id: string) =>
    request<{ paymentRequests: OwnPaymentRequestDto[] }>(
      "GET",
      `/merchants/${encodeURIComponent(id)}/payment-requests`
    ),
  merchantMembers: (id: string) =>
    request<{ members: MerchantMemberDto[] }>(
      "GET",
      `/merchants/${encodeURIComponent(id)}/members`
    ),
  addMerchantMember: (id: string, input: { email: string; role: "owner" | "staff" }) =>
    request<{ member: MerchantMemberDto }>(
      "POST",
      `/merchants/${encodeURIComponent(id)}/members`,
      input
    ),

  /** A charge on the till: the same payment request a person makes, taken for the shop. */
  createCharge: (input: {
    asMerchantId: string;
    amountMinorUnits: number;
    purpose?: string;
    expiresInMinutes?: number;
  }) => request<{ paymentRequest: OwnPaymentRequestDto }>("POST", "/payment-requests", input),
  charge: (id: string) =>
    request<{ paymentRequest: OwnPaymentRequestDto }>(
      "GET",
      `/payment-requests/${encodeURIComponent(id)}`
    ),
  cancelCharge: (id: string) =>
    request<{ paymentRequest: OwnPaymentRequestDto }>(
      "POST",
      `/payment-requests/${encodeURIComponent(id)}/cancel`
    ),

  /** Open to both sides of a payment: the customer, and the shop's team. */
  receipt: (id: string) =>
    request<{ receipt: ReceiptDto }>("GET", `/receipts/${encodeURIComponent(id)}`),
};
