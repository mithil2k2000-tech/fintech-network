import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

// Spec §44 Success Scenario 1 (register -> balance -> pay -> review ->
// confirm -> ledger -> receipt -> activity), through the actual screens.

const run = `${Date.now()}`;
const PASSWORD = "correct-horse-battery";

async function registerViaApi(request: APIRequestContext, email: string) {
  const res = await request.post("/api/v1/auth/register", {
    data: { email, password: PASSWORD },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { user: { id: string }; token: string };
}

async function registerViaUi(page: Page, email: string) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/welcome$/);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).last().click();
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Hello");
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("new user registers, pays someone, and sees the receipt and activity", async ({ page, request }) => {
  const payee = `sam.${run}@example.com`;
  const payer = `alex.${run}@example.com`;
  await registerViaApi(request, payee);

  await registerViaUi(page, payer);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hello, Alex");
  const balance = page.getByRole("region", { name: "Available balance" });
  await expect(balance).toContainText("£500.00");
  await expect(page.getByText("Starting balance")).toBeVisible();
  await noHorizontalScroll(page);

  // Every tile on Home goes somewhere, and since Phase 11 so does every
  // tab in the bottom bar: nothing is left marked "Soon".
  await expect(page.locator(".ds-action[aria-disabled='true']")).toHaveCount(0);
  await expect(page.locator(".ds-actions").getByRole("link")).toHaveCount(4);
  await expect(page.locator(".ds-nav [aria-disabled='true']")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Rewards" })).toBeVisible();

  await page.locator(".ds-actions").getByRole("link", { name: "Pay" }).click();
  await expect(page).toHaveURL(/\/pay$/);
  await expect(page.getByText("Available: £500.00")).toBeVisible();

  await page.getByLabel("Amount").fill("12.50");
  await page.getByLabel("To", { exact: true }).fill(payee);
  await page.getByLabel("What's it for? (optional)").fill("Coffee");
  await page.getByRole("button", { name: "Review payment" }).click();

  await expect(page.getByRole("heading", { name: "Check the details" })).toBeVisible();
  await expect(page.locator(".ds-summary__amount")).toHaveText("£12.50");
  await expect(page.getByText("Low risk")).toBeVisible();
  await expect(page.getByText("Nothing has been sent yet.")).toBeVisible();
  await noHorizontalScroll(page);

  await page.getByRole("button", { name: "Pay £12.50" }).click();
  await expect(page.getByRole("heading", { name: "Payment sent" })).toBeVisible();
  await expect(page.getByText(payee)).toBeVisible();

  await page.getByRole("link", { name: "View receipt" }).click();
  await expect(page).toHaveURL(/\/receipts\/[0-9a-f-]{36}$/);
  await expect(page.locator(".ds-summary__amount")).toHaveText("£12.50");
  await expect(page.getByText(`Paid to ${payee}`)).toBeVisible();
  await expect(page.getByText("Completed")).toBeVisible();
  await expect(page.locator("dd.ds-mono")).toHaveText(/^RCP-[A-HJ-NP-Z2-9]{12}$/);
  await expect(page.getByText("Coffee")).toBeVisible();
  await noHorizontalScroll(page);

  // The receipt is a focused screen with a back button, not the nav bar.
  await page.getByRole("button", { name: "Back" }).click();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Activity" }).click();
  await expect(page).toHaveURL(/\/activity$/);
  const firstRow = page.locator(".ds-txn").first();
  await expect(firstRow).toContainText(payee);
  await expect(firstRow).toContainText("−£12.50");
  await expect(firstRow).toContainText("£487.50");
  await expect(page.getByRole("heading", { name: "Today" })).toBeVisible();

  // Rows with a receipt open it.
  await firstRow.click();
  await expect(page).toHaveURL(/\/receipts\//);

  await page.goto("/");
  await expect(page.getByRole("region", { name: "Available balance" })).toContainText("£487.50");
});

test("the payee sees the money arrive, and nobody else can open the receipt", async ({ page, request }) => {
  const payee = `robin.${run}@example.com`;
  const payer = await registerViaApi(request, `kim.${run}@example.com`);
  await registerViaApi(request, payee).then(() => undefined);

  const created = await request.post("/api/v1/payments", {
    headers: { Authorization: `Bearer ${payer.token}` },
    data: { recipientEmail: payee, amountMinorUnits: 700, purpose: "Cinema" },
  });
  const { payment } = await created.json();
  const confirmed = await request.post(`/api/v1/payments/${payment.id}/confirm`, {
    headers: { Authorization: `Bearer ${payer.token}` },
    data: {},
  });
  const receiptId = (await confirmed.json()).payment.receiptId as string;

  // Payee signs in through the UI.
  await page.goto("/welcome");
  await page.getByRole("button", { name: "Sign in" }).first().click();
  await page.getByLabel("Email").fill(payee);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await expect(page.getByRole("region", { name: "Available balance" })).toContainText("£507.00");
  const row = page.locator(".ds-txn").first();
  await expect(row).toContainText(`kim.${run}@example.com`);
  await expect(row).toContainText("+£7.00");

  await row.click();
  await expect(page.getByText(`Received from kim.${run}@example.com`)).toBeVisible();

  // A third person can't see it.
  await page.goto("/profile");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/welcome$/);
  await registerViaUi(page, `eve.${run}@example.com`);
  await page.goto(`/receipts/${receiptId}`);
  await expect(page.getByText("Receipt not found")).toBeVisible();
});

test("pay form catches mistakes before and after contacting the server", async ({ page, request }) => {
  const other = `lee.${run}@example.com`;
  await registerViaApi(request, other);
  await registerViaUi(page, `jo.${run}@example.com`);
  await page.goto("/pay");

  const amount = page.getByLabel("Amount");
  const to = page.getByLabel("To", { exact: true });
  const review = page.getByRole("button", { name: "Review payment" });

  await review.click();
  await expect(page.getByText("Enter an amount")).toBeVisible();
  await expect(page.getByText("Enter the recipient's email address")).toBeVisible();

  await amount.fill("12.505");
  await to.fill(other);
  await review.click();
  await expect(page.getByText("Use at most 2 decimal places")).toBeVisible();

  await amount.fill("600");
  await expect(page.getByText(/more than your available balance/)).toBeVisible();

  await amount.fill("20000");
  await review.click();
  await expect(page.getByText("The most you can send at once is £10,000.00")).toBeVisible();

  await amount.fill("5");
  await to.fill(`nobody.${run}@example.com`);
  await review.click();
  await expect(page.getByText("There's no account with that email")).toBeVisible();

  await to.fill(`jo.${run}@example.com`);
  await review.click();
  await expect(page.getByText("You can't send money to yourself")).toBeVisible();

  // Cancelling at review sends nothing.
  await to.fill(other);
  await review.click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: "Review payment" })).toBeVisible();
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Available balance" })).toContainText("£500.00");
});

test("an over-balance payment fails clearly and takes nothing", async ({ page, request }) => {
  const other = `max.${run}@example.com`;
  await registerViaApi(request, other);
  await registerViaUi(page, `pat.${run}@example.com`);
  await page.goto("/pay");
  await page.getByLabel("Amount").fill("600");
  await page.getByLabel("To", { exact: true }).fill(other);
  await page.getByRole("button", { name: "Review payment" }).click();
  // Since Phase 12 this also looks risky — more than the whole balance,
  // to someone never paid — so the warning has to be acknowledged
  // before the payment is even attempted, and then it still fails for
  // the reason it always did.
  await expect(page.getByText("This payment looks unusual")).toBeVisible();
  await page.getByLabel(/I've read the warning/).check();
  await page.getByRole("button", { name: "Pay £600.00" }).click();
  await expect(page.getByRole("heading", { name: "Payment didn't go through" })).toBeVisible();
  await expect(page.getByText("You don't have enough money for this payment.")).toBeVisible();
  await expect(page.getByText("No money has left your account.")).toBeVisible();
  await page.getByRole("button", { name: "Back to home" }).click();
  await expect(page.getByRole("region", { name: "Available balance" })).toContainText("£500.00");
});

test("sessions survive a refresh, end on sign-out, and protect every screen", async ({ page }) => {
  await registerViaUi(page, `ash.${run}@example.com`);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hello, Ash");

  await page.goto("/profile");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/welcome$/);

  for (const path of ["/", "/pay", "/activity", "/profile"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/welcome$/);
  }

  await page.getByRole("button", { name: "Sign in" }).first().click();
  await page.getByLabel("Email").fill(`ash.${run}@example.com`);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await expect(page.getByText("That email and password don't match.")).toBeVisible();

  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).last().click();
  // Lands back on the last protected page visited.
  await expect(page).toHaveURL(/\/profile$/);
});

test("a tampered session sends the user back to sign in, and the cookie is out of reach", async ({
  page,
  context,
}) => {
  await registerViaUi(page, `kai.${run}@example.com`);

  // Since Phase 14 the session is an httpOnly cookie: nothing the page
  // runs can read it, which is the whole point of moving it there.
  const readable = await page.evaluate(() => document.cookie);
  expect(readable).not.toContain("fn_session");

  // Replace it with something that isn't a real token — what a stolen
  // or expired session looks like from the app's side.
  await context.addCookies([
    {
      name: "fn_session_consumer",
      value: "not-a-real-token",
      domain: "localhost",
      path: "/api",
    },
  ]);
  await page.goto("/activity");
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByText("Your session has ended. Please sign in again.")).toBeVisible();
});

test("someone who has never signed in is just shown the sign-in screen", async ({ page }) => {
  // No session and an expired one both look like a 401 to the app, and
  // telling a first-time visitor that their session has ended would be
  // nonsense. Only the second one gets an explanation.
  await page.goto("/");
  await expect(page).toHaveURL(/\/welcome$/);
  await expect(page.getByText("Your session has ended. Please sign in again.")).toHaveCount(0);
});
