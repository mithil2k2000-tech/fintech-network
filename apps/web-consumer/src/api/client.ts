// The one place this app names an API endpoint. Screens call these
// functions; they never build URLs or read tokens themselves, so a
// change to the API or the auth scheme means changing this file, not
// every screen. The HTTP machinery itself is shared with the merchant
// app (@fintech-network/app-kit).
import { createHttpClient } from "@fintech-network/app-kit";
import type {
  AccountDto,
  AssistantAnswerDto,
  AssistantCapabilitiesDto,
  ActivityPageDto,
  AuthResponse,
  BillSplitDto,
  CashbackSummaryDto,
  RewardsTreeDto,
  TreeStageDto,
  IncomingPaymentRequestDto,
  OwnPaymentRequestDto,
  PaymentDto,
  PublicPaymentRequestDto,
  ReceiptDto,
  UserDto,
} from "@fintech-network/shared-types";

export { ApiError } from "@fintech-network/app-kit";

export const http = createHttpClient("/api/v1", { sessionScope: "consumer" });
const request = http.request.bind(http);

export const api = {
  register: (email: string, password: string) =>
    request<AuthResponse>("POST", "/auth/register", { email, password }, { auth: false }),
  login: (email: string, password: string) =>
    request<AuthResponse>("POST", "/auth/login", { email, password }, { auth: false }),
  me: () => request<{ user: UserDto }>("GET", "/users/me"),
  // The session cookie is httpOnly, so only the server can drop it.
  logout: () => request<void>("POST", "/auth/logout", undefined, { auth: false }),
  account: () => request<{ account: AccountDto }>("GET", "/accounts/me"),

  createPayment: (input: { recipientEmail: string; amountMinorUnits: number; purpose?: string }) =>
    request<{ payment: PaymentDto }>("POST", "/payments", input),
  confirmPayment: (id: string, acknowledgeRisk: boolean) =>
    request<{ payment: PaymentDto }>(
      "POST",
      `/payments/${encodeURIComponent(id)}/confirm`,
      acknowledgeRisk ? { acknowledgeRisk: true } : {}
    ),
  cancelPayment: (id: string) =>
    request<{ payment: PaymentDto }>("POST", `/payments/${encodeURIComponent(id)}/cancel`),

  activity: (options: { limit?: number; cursor?: string | null } = {}) => {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.cursor) params.set("cursor", options.cursor);
    const qs = params.toString();
    return request<ActivityPageDto>("GET", `/transactions${qs ? `?${qs}` : ""}`);
  },
  createPaymentRequest: (input: {
    amountMinorUnits: number;
    purpose?: string;
    expiresInMinutes?: number;
    /** Given, the request goes to that person only; omitted, it's a QR. */
    toEmail?: string;
  }) => request<{ paymentRequest: OwnPaymentRequestDto }>("POST", "/payment-requests", input),
  paymentRequests: () =>
    request<{ paymentRequests: OwnPaymentRequestDto[] }>("GET", "/payment-requests"),
  incomingPaymentRequests: () =>
    request<{ paymentRequests: IncomingPaymentRequestDto[]; waitingCount: number }>(
      "GET",
      "/payment-requests/incoming"
    ),
  declinePaymentRequest: (id: string) =>
    request<{ paymentRequest: IncomingPaymentRequestDto }>(
      "POST",
      `/payment-requests/${encodeURIComponent(id)}/decline`
    ),
  paymentRequest: (id: string) =>
    request<{ paymentRequest: OwnPaymentRequestDto }>(
      "GET",
      `/payment-requests/${encodeURIComponent(id)}`
    ),
  cancelPaymentRequest: (id: string) =>
    request<{ paymentRequest: OwnPaymentRequestDto }>(
      "POST",
      `/payment-requests/${encodeURIComponent(id)}/cancel`
    ),
  resolvePaymentRequest: (key: string) =>
    request<{ paymentRequest: PublicPaymentRequestDto }>(
      "GET",
      `/payment-requests/resolve/${encodeURIComponent(key)}`
    ),
  payPaymentRequest: (id: string) =>
    request<{ payment: PaymentDto }>(
      "POST",
      `/payment-requests/${encodeURIComponent(id)}/pay`
    ),

  createBillSplit: (input: {
    totalMinorUnits: number;
    purpose?: string;
    participantEmails: string[];
    shareMinorUnits?: number[];
    includeOrganiser?: boolean;
  }) => request<{ billSplit: BillSplitDto }>("POST", "/bill-splits", input),
  billSplits: () => request<{ billSplits: BillSplitDto[] }>("GET", "/bill-splits"),
  billSplit: (id: string) =>
    request<{ billSplit: BillSplitDto }>("GET", `/bill-splits/${encodeURIComponent(id)}`),
  cancelBillSplit: (id: string) =>
    request<{ billSplit: BillSplitDto }>(
      "POST",
      `/bill-splits/${encodeURIComponent(id)}/cancel`
    ),

  cashback: () => request<{ cashback: CashbackSummaryDto }>("GET", "/rewards/cashback"),
  rewardsTree: () =>
    request<{ tree: RewardsTreeDto; stages: TreeStageDto[] }>("GET", "/rewards/tree"),

  // The assistant answers questions and nothing else — there is no
  // endpoint here that asks it to do something, because there isn't one
  // on the API either (spec §13).
  assistant: () => request<{ assistant: AssistantCapabilitiesDto }>("GET", "/assistant"),
  askAssistant: (question: string) =>
    request<{ assistant: AssistantAnswerDto }>("POST", "/assistant/ask", { question }),

  receipt: (id: string) =>
    request<{ receipt: ReceiptDto }>("GET", `/receipts/${encodeURIComponent(id)}`),
};
