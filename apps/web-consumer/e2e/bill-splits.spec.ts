import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { openPhoneFor } from "./people";

// Spec §44 Success Scenario 4: a bill is split, everyone sees their own
// share, and the organiser watches it come back in. The odd penny is
// visible on screen, because that is exactly the kind of thing people
// check.

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

async function expectBalance(page: Page, amount: string) {
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Available balance" })).toContainText(amount);
}

async function startSplit(page: Page, total: string, purpose: string, emails: string[]) {
  await page.goto("/split");
  await page.getByLabel("Total to split").fill(total);
  await page.getByLabel("What's it for? (optional)").fill(purpose);
  for (const [i, email] of emails.entries()) {
    if (i > 0) await page.getByRole("button", { name: "Add another person" }).click();
    // By role, so the field isn't confused with its own remove button.
    await page.getByRole("textbox", { name: `Person ${i + 1}`, exact: true }).fill(email);
  }
}

test("a bill is split three ways, each share is paid, and the odd penny adds up", async ({
  page,
  browser,
  request,
}) => {
  const organiserEmail = `splitter.${run}@example.com`;
  const anaEmail = `ana.${run}@example.com`;
  const benEmail = `ben.${run}@example.com`;
  for (const email of [organiserEmail, anaEmail, benEmail]) {
    await registerViaApi(request, email);
  }

  await signIn(page, organiserEmail);
  await startSplit(page, "10.00", "Pizza", [anaEmail, benEmail]);

  // £10 between 3 is not £3.33 each: the organiser takes the extra penny.
  const preview = page.getByTestId("split-preview");
  await expect(preview).toContainText("£3.34");
  await expect(preview).toContainText("£3.33");

  await page.getByRole("button", { name: "Ask 2 people" }).click();
  await expect(page).toHaveURL(/\/splits\/[0-9a-f-]{36}$/);
  await expect(page.locator(".ds-summary__amount")).toHaveText("£10.00");
  await expect(page.getByText("split 3 ways")).toBeVisible();
  await expect(page.getByText("Still owed")).toBeVisible();
  const splitUrl = page.url();

  // Ana sees her share as a normal request, and pays it.
  const ana = await openPhoneFor(browser);
  await signIn(ana, anaEmail);
  await expect(ana.getByTestId("waiting-requests")).toContainText("£3.33");
  await ana.goto("/requests");
  await expect(ana.getByText("Split bill")).toBeVisible();
  await expect(ana.getByText("Pizza")).toBeVisible();
  await ana.getByRole("link", { name: "Review and pay" }).click();
  await ana.getByRole("button", { name: "Continue to pay £3.33" }).click();
  await ana.getByRole("button", { name: "Pay £3.33" }).click();
  await expect(ana.getByRole("heading", { name: "Payment sent" })).toBeVisible();
  await expectBalance(ana, "£496.67");

  // The organiser's screen notices, without a refresh.
  await expect(page.getByText("Paid").first()).toBeVisible({ timeout: 20_000 });

  // Ben declines instead; the split is then finished with.
  const ben = await openPhoneFor(browser);
  await signIn(ben, benEmail);
  await ben.goto("/requests");
  await ben.getByRole("button", { name: "Decline" }).click();
  await expect(ben.getByText("Declined").first()).toBeVisible();
  await expectBalance(ben, "£500.00");

  await page.goto(splitUrl);
  await expect(page.getByText("All settled")).toBeVisible();
  await expect(page.getByText("£3.33 came back to you")).toBeVisible();
  await expectBalance(page, "£503.33");
});

test("the organiser can call a split off, and unpaid shares go with it", async ({
  page,
  browser,
  request,
}) => {
  const organiserEmail = `splitter2.${run}@example.com`;
  const guestEmail = `guest2.${run}@example.com`;
  for (const email of [organiserEmail, guestEmail]) {
    await registerViaApi(request, email);
  }

  await signIn(page, organiserEmail);
  await startSplit(page, "30.00", "Cancelled dinner", [guestEmail]);
  await page.getByRole("button", { name: "Ask 1 person" }).click();
  await expect(page.locator(".ds-summary__amount")).toHaveText("£30.00");

  await page.getByRole("button", { name: "Cancel this split" }).click();
  await expect(page.getByText("Cancelled").first()).toBeVisible();

  const guest = await openPhoneFor(browser);
  await signIn(guest, guestEmail);
  await expect(guest.getByTestId("waiting-requests")).toHaveCount(0);
  await guest.goto("/requests");
  await expect(guest.getByRole("button", { name: "Decline" })).toHaveCount(0);
  await expectBalance(guest, "£500.00");
});

test("a split is refused before anything is sent when someone can't be added", async ({
  page,
  request,
}) => {
  const organiserEmail = `splitter3.${run}@example.com`;
  const realEmail = `real3.${run}@example.com`;
  for (const email of [organiserEmail, realEmail]) {
    await registerViaApi(request, email);
  }

  await signIn(page, organiserEmail);
  await startSplit(page, "20.00", "Nobody's dinner", [realEmail, `ghost.${run}@example.com`]);
  await page.getByRole("button", { name: "Ask 2 people" }).click();
  await expect(page.getByText(/couldn't add/)).toBeVisible();
  await expect(page).toHaveURL(/\/split$/);

  // Nothing was created, so the real person was never asked.
  await page.goto("/split");
  await expect(page.getByText("No splits yet")).toBeVisible();
});

test("a split can't be opened by someone who isn't in it", async ({ page, browser, request }) => {
  const organiserEmail = `splitter4.${run}@example.com`;
  const guestEmail = `guest4.${run}@example.com`;
  const nosyEmail = `nosy4.${run}@example.com`;
  for (const email of [organiserEmail, guestEmail, nosyEmail]) {
    await registerViaApi(request, email);
  }

  await signIn(page, organiserEmail);
  await startSplit(page, "15.00", "Private lunch", [guestEmail]);
  await page.getByRole("button", { name: "Ask 1 person" }).click();
  await expect(page.locator(".ds-summary__amount")).toHaveText("£15.00");
  const splitUrl = page.url();

  const nosy = await openPhoneFor(browser);
  await signIn(nosy, nosyEmail);
  await nosy.goto(splitUrl);
  await expect(nosy.getByText("We couldn't find that split")).toBeVisible();
  await expect(nosy.getByText("Private lunch")).toHaveCount(0);
});
