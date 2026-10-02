import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { openPhoneFor } from "./people";

// Spec §44 Success Scenario 2: a request is created, shown as a QR, scanned
// by someone else, checked, confirmed, and the money arrives.
// The camera can't run in this browser, so the scan goes through the photo
// fallback with a real picture of the QR, decoded by the same code a phone
// camera frame would use — and through the typed code.

const run = `${Date.now()}`;
const PASSWORD = "correct-horse-battery";

async function registerViaApi(request: APIRequestContext, email: string) {
  const res = await request.post("/api/v1/auth/register", {
    data: { email, password: PASSWORD },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { user: { id: string }; token: string };
}

async function signIn(page: Page, email: string) {
  await page.goto("/welcome");
  await page.getByRole("button", { name: "Sign in" }).first().click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Hello");
}

async function createRequestViaUi(page: Page, amount: string, purpose: string) {
  await page.goto("/request");
  await page.getByLabel("Amount to request").fill(amount);
  await page.getByLabel("What's it for? (optional)").fill(purpose);
  await page.getByRole("button", { name: "Create QR code" }).click();
  await expect(page.getByRole("heading", { name: "Show this to get paid" })).toBeVisible();
  const code = await page.locator(".ds-mono").innerText();
  return code.trim();
}

async function expectBalance(page: Page, amount: string) {
  await page.goto("/");
  // Wait for the balance to load rather than reading the placeholder.
  await expect(page.getByRole("region", { name: "Available balance" })).toContainText(amount);
}

test("a QR code is created, scanned from a photo, paid, and shows as paid to both sides", async ({
  page,
  browser,
  request,
}) => {
  const shopEmail = `qrshop.${run}@example.com`;
  const payerEmail = `qrpayer.${run}@example.com`;
  await registerViaApi(request, shopEmail);
  await registerViaApi(request, payerEmail);

  // The person getting paid shows a QR code.
  await signIn(page, shopEmail);
  await createRequestViaUi(page, "12.50", "Flat white");
  const qr = page.getByTestId("request-qr");
  await expect(qr.locator("svg")).toBeVisible();
  await expect(page.getByText("Waiting to be paid")).toBeVisible();
  await expect(page.getByText(/Expires in/)).toBeVisible();
  const qrPhoto = await qr.screenshot({ path: "/tmp/qr-code.png", scale: "device" });
  expect(qrPhoto.byteLength).toBeGreaterThan(500);

  // The payer scans that picture of the code.
  const payerPage = await openPhoneFor(browser);
  await signIn(payerPage, payerEmail);
  await payerPage.goto("/scan");
  await payerPage.getByTestId("qr-photo-input").setInputFiles("/tmp/qr-code.png");

  await expect(payerPage).toHaveURL(/\/pay\/r\/[A-Za-z0-9_-]{43}$/);
  await expect(payerPage.locator(".ds-summary__amount")).toHaveText("£12.50");
  await expect(payerPage.getByText(shopEmail).first()).toBeVisible();
  await expect(payerPage.getByText("Flat white")).toBeVisible();

  await payerPage.getByRole("button", { name: "Continue to pay £12.50" }).click();
  await expect(payerPage.getByRole("heading", { name: "Confirm this payment" })).toBeVisible();
  await expect(payerPage.getByText("Scanned QR code")).toBeVisible();
  await expect(payerPage.getByText("Nothing has been sent yet.")).toBeVisible();

  await payerPage.getByRole("button", { name: "Pay £12.50" }).click();
  await expect(payerPage.getByRole("heading", { name: "Payment sent" })).toBeVisible();
  await expectBalance(payerPage, "£487.50");

  // The requester's screen notices, without a refresh.
  await expect(page.getByRole("heading", { name: "Paid" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`${payerEmail} paid you £12.50`)).toBeVisible();
  await page.getByRole("link", { name: "View receipt" }).click();
  await expect(page.getByText(`Received from ${payerEmail}`)).toBeVisible();
  await expectBalance(page, "£512.50");
});

test("the same QR can't be paid twice, and the code can be typed instead", async ({
  page,
  browser,
  request,
}) => {
  const shopEmail = `qrshop2.${run}@example.com`;
  const firstEmail = `qrfirst.${run}@example.com`;
  const secondEmail = `qrsecond.${run}@example.com`;
  for (const email of [shopEmail, firstEmail, secondEmail]) {
    await registerViaApi(request, email);
  }

  await signIn(page, shopEmail);
  const code = await createRequestViaUi(page, "3.00", "Bus fare");
  expect(code).toMatch(/^REQ-[A-HJ-NP-Z2-9]{8}$/);

  // First payer types the code in and pays.
  const first = await openPhoneFor(browser);
  await signIn(first, firstEmail);
  await first.goto("/scan");
  await first.getByLabel("Or enter the code").fill(code.toLowerCase());
  await first.getByRole("button", { name: "Continue" }).click();
  await expect(first.locator(".ds-summary__amount")).toHaveText("£3.00");
  await first.getByRole("button", { name: "Continue to pay £3.00" }).click();
  await first.getByRole("button", { name: "Pay £3.00" }).click();
  await expect(first.getByRole("heading", { name: "Payment sent" })).toBeVisible();

  // Second payer, same code: told it's already paid, and can't continue.
  const second = await openPhoneFor(browser);
  await signIn(second, secondEmail);
  await second.goto("/scan");
  await second.getByLabel("Or enter the code").fill(code);
  await second.getByRole("button", { name: "Continue" }).click();
  await expect(second.getByText("Paid").first()).toBeVisible();
  await expect(second.getByRole("button", { name: /Continue to pay/ })).toBeDisabled();
  await expectBalance(second, "£500.00");
});

test("scanning rejects nonsense, your own code and a cancelled code", async ({ page, request }) => {
  const email = `qrself.${run}@example.com`;
  await registerViaApi(request, email);
  await signIn(page, email);

  await page.goto("/scan");
  await page.getByLabel("Or enter the code").fill("hello there");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("That doesn't look like a payment code from this app.")).toBeVisible();

  await page.getByLabel("Or enter the code").fill("REQ-ZZZZZZZZ");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("We couldn't find that request")).toBeVisible();

  // Your own QR code.
  const code = await createRequestViaUi(page, "2.00", "Tea");
  await page.goto("/scan");
  await page.getByLabel("Or enter the code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("This is your own request")).toBeVisible();
  await expect(page.getByRole("button", { name: /Continue to pay/ })).toBeDisabled();

  // Cancel it, then look again.
  await page.goto("/request");
  const cancelCode = await createRequestViaUi(page, "4.00", "Cake");
  await page.getByRole("button", { name: "Cancel request" }).click();
  await expect(page.getByText("Cancelled").first()).toBeVisible();
  await page.goto("/scan");
  await page.getByLabel("Or enter the code").fill(cancelCode);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("This request can't be paid any more.")).toBeVisible();
});
