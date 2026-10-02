import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { openPhoneFor } from "./people";

// Spec §44 Success Scenario 3: one person asks another for money by name,
// it appears in the other's app, and they either pay it or say no. Money
// only ever moves through the same review-and-confirm step as any payment.

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

async function askPerson(page: Page, toEmail: string, amount: string, purpose: string) {
  await page.goto("/request");
  await page.getByRole("button", { name: "Ask a person" }).click();
  await page.getByLabel("Amount to request").fill(amount);
  await page.getByLabel("Who are you asking?").fill(toEmail);
  await page.getByLabel("What's it for? (optional)").fill(purpose);
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByRole("heading", { name: "Request sent" })).toBeVisible();
}

async function expectBalance(page: Page, amount: string) {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Available balance" })).toContainText(amount);
}

test("a request sent to a person shows up in their app and is paid from there", async ({
  page,
  browser,
  request,
}) => {
  const askerEmail = `asker.${run}@example.com`;
  const friendEmail = `friend.${run}@example.com`;
  await registerViaApi(request, askerEmail);
  await registerViaApi(request, friendEmail);

  await signIn(page, askerEmail);
  await askPerson(page, friendEmail, "18.00", "Taxi home");
  await expect(page.getByText("We've asked them")).toBeVisible();
  await expect(page.getByText(friendEmail).first()).toBeVisible();
  await expect(page.getByText(/Expires in/)).toBeVisible();

  // The person asked sees it waiting as soon as they open the app.
  const friend = await openPhoneFor(browser);
  await signIn(friend, friendEmail);
  const prompt = friend.getByTestId("waiting-requests");
  await expect(prompt).toContainText(`${askerEmail} asked you for £18.00`);
  await prompt.click();

  await expect(friend.getByRole("heading", { name: "Requests for you" })).toBeVisible();
  await expect(friend.getByTestId("incoming-amount")).toHaveText("£18.00");
  await expect(friend.getByText("Taxi home")).toBeVisible();
  await friend.getByRole("link", { name: "Review and pay" }).click();

  await expect(friend).toHaveURL(/\/pay\/r\/[0-9a-f-]{36}$/);
  await expect(friend.locator(".ds-summary__amount")).toHaveText("£18.00");
  await friend.getByRole("button", { name: "Continue to pay £18.00" }).click();
  await expect(friend.getByRole("heading", { name: "Confirm this payment" })).toBeVisible();
  await expect(friend.getByText("A request sent to you")).toBeVisible();
  await friend.getByRole("button", { name: "Pay £18.00" }).click();
  await expect(friend.getByRole("heading", { name: "Payment sent" })).toBeVisible();
  await expectBalance(friend, "£482.00");

  // Nothing is left waiting, and the earlier list shows it paid.
  await expect(friend.getByTestId("waiting-requests")).toHaveCount(0);
  await friend.goto("/requests");
  await expect(friend.getByText("Paid").first()).toBeVisible();

  // The asker's screen notices, without a refresh.
  await expect(page.getByRole("heading", { name: "Paid" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`${friendEmail} paid you £18.00`)).toBeVisible();
  await expectBalance(page, "£518.00");
});

test("the person asked can decline, and nothing moves", async ({ page, browser, request }) => {
  const askerEmail = `asker2.${run}@example.com`;
  const friendEmail = `friend2.${run}@example.com`;
  await registerViaApi(request, askerEmail);
  await registerViaApi(request, friendEmail);

  await signIn(page, askerEmail);
  await askPerson(page, friendEmail, "25.00", "Concert ticket");

  const friend = await openPhoneFor(browser);
  await signIn(friend, friendEmail);
  await friend.goto("/requests");
  await expect(friend.getByTestId("incoming-amount")).toHaveText("£25.00");
  await friend.getByRole("button", { name: "Decline" }).click();

  await expect(friend.getByText("Declined").first()).toBeVisible();
  await expect(friend.getByRole("button", { name: "Decline" })).toHaveCount(0);
  await expectBalance(friend, "£500.00");
  await expect(friend.getByTestId("waiting-requests")).toHaveCount(0);

  // The asker is told, on the screen they were already looking at.
  await expect(page.getByText(`${friendEmail} declined this request`)).toBeVisible({
    timeout: 15_000,
  });
  await expectBalance(page, "£500.00");
});

test("a request sent to someone else can't be opened by anyone it wasn't sent to", async ({
  page,
  browser,
  request,
}) => {
  const askerEmail = `asker3.${run}@example.com`;
  const friendEmail = `friend3.${run}@example.com`;
  const nosyEmail = `nosy.${run}@example.com`;
  for (const email of [askerEmail, friendEmail, nosyEmail]) {
    await registerViaApi(request, email);
  }

  await signIn(page, askerEmail);
  await askPerson(page, friendEmail, "9.00", "Sandwich");
  // The asker can look at their own, but can't pay it.
  const reference = (await page.locator(".ds-mono").first().innerText()).trim();
  expect(reference).toMatch(/^REQ-[A-HJ-NP-Z2-9]{8}$/);

  const friend = await openPhoneFor(browser);
  await signIn(friend, friendEmail);
  await friend.goto("/requests");
  const payLink = friend.getByRole("link", { name: "Review and pay" });
  await expect(payLink).toBeVisible();
  const href = await payLink.getAttribute("href");

  // Someone else with the same link is told nothing about it.
  const nosy = await openPhoneFor(browser);
  await signIn(nosy, nosyEmail);
  await nosy.goto(href!);
  await expect(nosy.getByText("We couldn't find that request")).toBeVisible();
  await expect(nosy.getByText("9.00")).toHaveCount(0);

  // And typing the reference into the scanner doesn't reach it either.
  await nosy.goto("/scan");
  await nosy.getByLabel("Or enter the code").fill(reference);
  await nosy.getByRole("button", { name: "Continue" }).click();
  await expect(nosy.getByText("We couldn't find that request")).toBeVisible();
});

test("asking an address nobody has, or yourself, is refused on the spot", async ({
  page,
  request,
}) => {
  const email = `asker4.${run}@example.com`;
  await registerViaApi(request, email);
  await signIn(page, email);

  await page.goto("/request");
  await page.getByRole("button", { name: "Ask a person" }).click();
  await page.getByLabel("Amount to request").fill("5.00");
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText("Enter the email address of the person you're asking")).toBeVisible();

  await page.getByLabel("Who are you asking?").fill(`ghost.${run}@example.com`);
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText("We couldn't send a request to that address")).toBeVisible();

  await page.getByLabel("Who are you asking?").fill(email);
  await page.getByRole("button", { name: "Send request" }).click();
  await expect(page.getByText("We couldn't send a request to that address")).toBeVisible();
});
