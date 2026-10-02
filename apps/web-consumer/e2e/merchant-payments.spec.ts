import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

// Spec §44 Success Scenario 5: a shop takes money. The till is the API
// for now (the merchant app is the next increment), so this drives the
// shop through the API and the customer through the app — which is
// exactly the split a real terminal would have.

const run = `${Date.now()}`;
const PASSWORD = "correct-horse-battery";

async function registerViaApi(request: APIRequestContext, email: string) {
  const res = await request.post("/api/v1/auth/register", {
    data: { email, password: PASSWORD },
  });
  expect(res.status()).toBe(201);
  return (await res.json()) as { user: { id: string }; token: string };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
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

test("a customer pays a shop's QR code, and the money lands in the shop's account", async ({
  page,
  request,
}) => {
  const tillEmail = `till.${run}@example.com`;
  const customerEmail = `shopper.${run}@example.com`;
  const till = await registerViaApi(request, tillEmail);
  await registerViaApi(request, customerEmail);
  const shopName = `Corner Coffee ${run}`;

  // The shop registers and puts a charge on the till.
  const shop = await request.post("/api/v1/merchants", {
    headers: auth(till.token),
    data: {
      legalName: `Corner Coffee Ltd ${run}`,
      tradingName: shopName,
      contactEmail: `hello.${run}@corner.example`,
    },
  });
  expect(shop.status()).toBe(201);
  const shopId = (await shop.json()).merchant.id;

  const charge = await request.post("/api/v1/payment-requests", {
    headers: auth(till.token),
    data: { asMerchantId: shopId, amountMinorUnits: 4_50, purpose: "Flat white" },
  });
  expect(charge.status()).toBe(201);
  const code = (await charge.json()).paymentRequest.code;

  // The customer types the code in rather than scanning (no camera here).
  await signIn(page, customerEmail);
  await page.goto("/scan");
  await page.getByLabel("Or enter the code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.locator(".ds-summary__amount")).toHaveText("£4.50");
  // The shop is named, the person at the till is not.
  await expect(page.getByText(shopName).first()).toBeVisible();
  await expect(page.getByText(tillEmail)).toHaveCount(0);
  await expect(page.getByText("Registered shop")).toBeVisible();
  // And "registered" is not allowed to sound like "vetted".
  await expect(page.getByText("We haven't checked the business itself")).toBeVisible();

  await page.getByRole("button", { name: "Continue to pay £4.50" }).click();
  await page.getByRole("button", { name: "Pay £4.50" }).click();
  await expect(page.getByRole("heading", { name: "Payment sent" })).toBeVisible();
  // £4.50 out, 4p of cashback back (1% of a shop payment, Phase 10).
  await expectBalance(page, "£495.54");

  // The receipt says the shop, not a person.
  await page.goto("/activity");
  await page.getByText(shopName).first().click();
  await expect(page.getByText(`Paid to ${shopName}`)).toBeVisible();

  // The shop's own balance and takings, from its side.
  const account = await request.get(`/api/v1/merchants/${shopId}/account`, {
    headers: auth(till.token),
  });
  expect((await account.json()).account.balanceMinorUnits).toBe(450);

  const activity = await request.get(`/api/v1/merchants/${shopId}/activity`, {
    headers: auth(till.token),
  });
  const latest = (await activity.json()).items[0];
  expect(latest).toMatchObject({
    direction: "in",
    amountMinorUnits: 450,
    title: customerEmail,
    purpose: "Flat white",
  });
});

test("paying a shop earns cashback, and it shows up as its own line", async ({
  page,
  request,
}) => {
  const tillEmail = `cbtill.${run}@example.com`;
  const customerEmail = `cbshopper.${run}@example.com`;
  const till = await registerViaApi(request, tillEmail);
  await registerViaApi(request, customerEmail);

  const shop = await request.post("/api/v1/merchants", {
    headers: auth(till.token),
    data: {
      legalName: `Cashback Corner Ltd ${run}`,
      tradingName: `Cashback Corner ${run}`,
      contactEmail: `hello.${run}@cbcorner.example`,
    },
  });
  const shopId = (await shop.json()).merchant.id;
  const charge = await request.post("/api/v1/payment-requests", {
    headers: auth(till.token),
    data: { asMerchantId: shopId, amountMinorUnits: 20_00, purpose: "Lunch" },
  });
  const code = (await charge.json()).paymentRequest.code;

  await signIn(page, customerEmail);
  await page.goto("/scan");
  await page.getByLabel("Or enter the code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue to pay £20.00" }).click();
  await page.getByRole("button", { name: "Pay £20.00" }).click();
  await expect(page.getByRole("heading", { name: "Payment sent" })).toBeVisible();

  // £20 out, 20p back.
  await expectBalance(page, "£480.20");
  await expect(page.getByText("You've earned £0.20 back")).toBeVisible();
  await expect(page.getByText(/1% back when you pay a shop/)).toBeVisible();

  await page.goto("/activity");
  await expect(page.getByText("Cashback").first()).toBeVisible();
  await expect(page.getByText("+£0.20")).toBeVisible();
});

test("the rewards tree grows from cashback, and says it isn't a real tree", async ({
  page,
  request,
}) => {
  const tillEmail = `treetill.${run}@example.com`;
  const customerEmail = `treeshopper.${run}@example.com`;
  const till = await registerViaApi(request, tillEmail);
  await registerViaApi(request, customerEmail);

  const shop = await request.post("/api/v1/merchants", {
    headers: auth(till.token),
    data: {
      legalName: `Tree Cafe Ltd ${run}`,
      tradingName: `Tree Cafe ${run}`,
      contactEmail: `hello.${run}@tree.example`,
    },
  });
  const shopId = (await shop.json()).merchant.id;

  await signIn(page, customerEmail);

  // Nothing earned yet: a seed, and an honest empty state.
  await page.getByRole("link", { name: "Rewards" }).click();
  await expect(page.getByRole("img", { name: /rewards tree: Seed/i })).toBeVisible();
  await expect(page.getByTestId("cashback-total")).toHaveText("£0.00");
  await expect(page.getByText("Nothing yet")).toBeVisible();
  await expect(page.getByText(/No real tree is planted/i)).toBeVisible();

  // Pay £6 at the shop: 6p back, which sprouts it.
  const charge = await request.post("/api/v1/payment-requests", {
    headers: auth(till.token),
    data: { asMerchantId: shopId, amountMinorUnits: 6_00, purpose: "Sandwich" },
  });
  const code = (await charge.json()).paymentRequest.code;
  await page.goto("/scan");
  await page.getByLabel("Or enter the code").fill(code);
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue to pay £6.00" }).click();
  await page.getByRole("button", { name: "Pay £6.00" }).click();
  await expect(page.getByRole("heading", { name: "Payment sent" })).toBeVisible();

  await page.goto("/rewards");
  await expect(page.getByRole("img", { name: /rewards tree: Sprout/i })).toBeVisible();
  await expect(page.getByTestId("cashback-total")).toHaveText("£0.06");
  await expect(page.getByText("1% of £6.00")).toBeVisible();
  // The ladder and the next step both come from the server. "Seedling"
  // appears twice — as what's next, and as a rung on the ladder.
  await expect(page.getByText("Next: Seedling")).toBeVisible();
  await expect(page.getByText("£0.44 to go")).toBeVisible();
  await expect(page.getByText("Seedling").last()).toBeVisible();
});
