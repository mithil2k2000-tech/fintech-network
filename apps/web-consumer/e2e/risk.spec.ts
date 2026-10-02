import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

// Spec §44 Success Scenario 7: the risk warning, for real. The HIGH
// path has been built since Phase 4 and exercised only with a stub;
// since Phase 12 the deterministic engine decides, so this drives a
// payment that genuinely looks like an authorised-push-payment scam —
// a large sum to someone never paid before, emptying the account — and
// checks the app warns, blocks the button, and only then lets it
// through.

const run = `${Date.now()}`;
const PASSWORD = "correct-horse-battery";

async function registerViaApi(request: APIRequestContext, email: string) {
  const res = await request.post("/api/v1/auth/register", {
    data: { email, password: PASSWORD },
  });
  expect(res.status()).toBe(201);
}

async function signIn(page: Page, email: string) {
  await page.goto("/welcome");
  await page.getByRole("button", { name: "Sign in" }).first().click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Hello");
}

async function startPayment(page: Page, to: string, amount: string) {
  await page.goto("/pay");
  await page.getByLabel("Amount").fill(amount);
  await page.getByLabel("To").fill(to);
  await page.getByRole("button", { name: "Review payment" }).click();
  await expect(page.getByRole("heading", { name: "Check the details" })).toBeVisible();
}

test("a payment that looks like a scam is flagged, and can't be sent by accident", async ({
  page,
  request,
}) => {
  const payerEmail = `risk-payer.${run}@example.com`;
  const strangerEmail = `risk-stranger.${run}@example.com`;
  await registerViaApi(request, payerEmail);
  await registerViaApi(request, strangerEmail);

  await signIn(page, payerEmail);
  // £450 of a £500 balance, to someone never paid before.
  await startPayment(page, strangerEmail, "450.00");

  await expect(page.getByText("High risk")).toBeVisible();
  await expect(page.getByText("This payment looks unusual")).toBeVisible();
  await expect(page.getByText(/Scammers often ask for urgent payments/)).toBeVisible();
  // The reasons are the engine's, in plain words.
  await expect(page.getByText("You haven't paid this person before")).toBeVisible();
  await expect(page.getByText("This would use almost everything in your account")).toBeVisible();

  // The button is held until the warning is acknowledged.
  const pay = page.getByRole("button", { name: "Pay £450.00" });
  await expect(pay).toBeDisabled();
  await page.getByLabel(/I've read the warning/).check();
  await expect(pay).toBeEnabled();

  await pay.click();
  await expect(page.getByRole("heading", { name: "Payment sent" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Available balance" })).toContainText("£50.00");
});

test("an ordinary payment isn't nagged about, and a familiar payee stops being mentioned", async ({
  page,
  request,
}) => {
  const payerEmail = `risk-quiet.${run}@example.com`;
  const friendEmail = `risk-quiet-friend.${run}@example.com`;
  await registerViaApi(request, payerEmail);
  await registerViaApi(request, friendEmail);

  await signIn(page, payerEmail);
  await startPayment(page, friendEmail, "5.00");

  // Noticed, said once, and no warning or checkbox in the way.
  await expect(page.getByText("Low risk")).toBeVisible();
  await expect(page.getByText("You haven't paid this person before")).toBeVisible();
  await expect(page.getByText("This payment looks unusual")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Pay £5.00" })).toBeEnabled();
  await page.getByRole("button", { name: "Pay £5.00" }).click();
  await expect(page.getByRole("heading", { name: "Payment sent" })).toBeVisible();

  // Second time round they're familiar, so there's nothing to say.
  await startPayment(page, friendEmail, "5.00");
  await expect(page.getByText("Nothing unusual about this payment")).toBeVisible();
  await expect(page.getByText("You haven't paid this person before")).toHaveCount(0);
});
