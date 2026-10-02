import { test, expect, type Page, type APIRequestContext } from "@playwright/test";
import { MERCHANT_APP } from "../playwright.config";
import { openPhoneFor } from "./people";

// Spec §44 Success Scenario 6: a shop takes a payment through its own
// app. Both apps are driven at once — the till in one tab, the customer
// in another — because the point of the merchant app is that the two
// meet in the middle without anyone touching the API by hand.

const run = `${Date.now()}`;
const PASSWORD = "correct-horse-battery";

async function registerViaApi(request: APIRequestContext, email: string) {
  const res = await request.post("/api/v1/auth/register", {
    data: { email, password: PASSWORD },
  });
  expect(res.status()).toBe(201);
}

/** Signs in on whichever app the page is pointed at. */
async function signIn(page: Page, origin: string, email: string) {
  await page.goto(`${origin}/welcome`);
  await page.getByRole("button", { name: "Sign in" }).first().click();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).last().click();
}

async function registerShop(page: Page, tradingName: string) {
  await expect(page.getByText("Register your shop")).toBeVisible();
  await page.getByLabel("Trading name").fill(tradingName);
  await page.getByLabel("Registered name").fill(`${tradingName} Ltd`);
  await page.getByRole("button", { name: "Register shop" }).click();
  await expect(page.getByRole("heading", { name: tradingName })).toBeVisible();
}

test("a shop registers, takes a payment on the till, and sees it arrive", async ({
  page,
  browser,
  request,
}) => {
  const ownerEmail = `till-owner.${run}@example.com`;
  const customerEmail = `till-customer.${run}@example.com`;
  await registerViaApi(request, ownerEmail);
  await registerViaApi(request, customerEmail);
  const shopName = `Till Test Cafe ${run}`;

  // The shop owner signs in as themselves and registers the shop.
  await signIn(page, MERCHANT_APP, ownerEmail);
  await registerShop(page, shopName);
  await expect(page.getByRole("region", { name: "In the till" })).toContainText("£0.00");

  // Put a charge on the till.
  await page.getByRole("link", { name: "Take a payment" }).click();
  await page.getByLabel("Amount to charge").fill("4.50");
  await page.getByLabel("What's it for? (optional)").fill("Flat white");
  await page.getByRole("button", { name: "Show the code" }).click();

  await expect(page.getByRole("heading", { name: "Show this to the customer" })).toBeVisible();
  await expect(page.getByTestId("charge-qr").locator("svg")).toBeVisible();
  await expect(page.getByText("Waiting for the customer")).toBeVisible();
  const code = (await page.locator(".ds-mono").innerText()).trim();
  expect(code).toMatch(/^REQ-[A-HJ-NP-Z2-9]{8}$/);

  // The customer pays it in their own app.
  const customer = await openPhoneFor(browser);
  await signIn(customer, "", customerEmail);
  await expect(customer.getByRole("heading", { level: 1 })).toContainText("Hello");
  await customer.goto("/scan");
  await customer.getByLabel("Or enter the code").fill(code);
  await customer.getByRole("button", { name: "Continue" }).click();
  await expect(customer.getByText(shopName).first()).toBeVisible();
  await customer.getByRole("button", { name: "Continue to pay £4.50" }).click();
  await customer.getByRole("button", { name: "Pay £4.50" }).click();
  await expect(customer.getByRole("heading", { name: "Payment sent" })).toBeVisible();

  // The till notices, without anyone refreshing it.
  await expect(page.getByRole("heading", { name: "Paid" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(`${customerEmail} paid £4.50`)).toBeVisible();

  // The shop's own receipt, from its side.
  await page.getByRole("link", { name: "View receipt" }).click();
  await expect(page.getByText(`received from ${customerEmail}`)).toBeVisible();

  // And the till and takings both show the money.
  await page.goto(`${MERCHANT_APP}/`);
  await expect(page.getByRole("region", { name: "In the till" })).toContainText("£4.50");
  await page.getByRole("link", { name: "Takings" }).click();
  await expect(page.getByText("Flat white")).toBeVisible();
  await expect(page.getByText(customerEmail).first()).toBeVisible();
});

test("a charge can be called off before anyone pays it", async ({ page, request }) => {
  const ownerEmail = `till-owner2.${run}@example.com`;
  await registerViaApi(request, ownerEmail);
  const shopName = `Cancel Cafe ${run}`;

  await signIn(page, MERCHANT_APP, ownerEmail);
  await registerShop(page, shopName);

  await page.getByRole("link", { name: "Take a payment" }).click();
  await page.getByLabel("Amount to charge").fill("12.00");
  await page.getByRole("button", { name: "Show the code" }).click();
  await expect(page.getByTestId("charge-qr")).toBeVisible();

  await page.getByRole("button", { name: "Cancel this charge" }).click();
  await expect(page.getByText("This charge can't be paid any more.")).toBeVisible();
  await expect(page.getByText("Cancelled").first()).toBeVisible();

  await page.goto(`${MERCHANT_APP}/`);
  await expect(page.getByText("Waiting to be paid")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "In the till" })).toContainText("£0.00");
});

test("staff can take money but can't change the team", async ({ page, browser, request }) => {
  const ownerEmail = `team-owner.${run}@example.com`;
  const staffEmail = `team-staff.${run}@example.com`;
  await registerViaApi(request, ownerEmail);
  await registerViaApi(request, staffEmail);
  const shopName = `Team Cafe ${run}`;

  await signIn(page, MERCHANT_APP, ownerEmail);
  await registerShop(page, shopName);

  await page.getByRole("link", { name: "Team" }).click();
  await expect(page.getByText(`${ownerEmail} (you)`)).toBeVisible();
  await page.getByLabel("Their email").fill(staffEmail);
  await page.getByRole("button", { name: "Add to the team" }).click();
  await expect(page.getByText(staffEmail).first()).toBeVisible();

  // The new member signs in and finds the shop waiting for them.
  const staff = await openPhoneFor(browser);
  await signIn(staff, MERCHANT_APP, staffEmail);
  await expect(staff.getByRole("heading", { name: shopName })).toBeVisible();
  await staff.getByRole("link", { name: "Take a payment" }).click();
  await staff.getByLabel("Amount to charge").fill("2.00");
  await staff.getByRole("button", { name: "Show the code" }).click();
  await expect(staff.getByTestId("charge-qr")).toBeVisible();

  // But the team screen is read-only for them.
  await staff.goto(`${MERCHANT_APP}/team`);
  await expect(staff.getByText("Only an owner of this shop can add people.")).toBeVisible();
  await expect(staff.getByRole("button", { name: "Add to the team" })).toHaveCount(0);
});

test("the merchant app sends you to sign in, and says what registering doesn't prove", async ({
  page,
  request,
}) => {
  const email = `notice.${run}@example.com`;
  await registerViaApi(request, email);

  // Signed out, any screen sends you to sign in.
  await page.goto(`${MERCHANT_APP}/takings`);
  await expect(page.getByRole("button", { name: "Sign in" }).first()).toBeVisible();

  await signIn(page, MERCHANT_APP, email);
  // No shop yet, so the app asks for one rather than showing an empty till.
  await expect(page.getByText("Register your shop")).toBeVisible();
  await expect(page.getByText("We don't check businesses")).toBeVisible();
});
