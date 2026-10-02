import { test, expect, type Page } from "@playwright/test";

// Spec §13: the assistant, through the actual screens. What's being
// checked here isn't that it answers nicely — it's that the answer
// carries the account's own figures, and that asking it to move money
// gets a refusal and a link to the screen where the person does it.

const run = `${Date.now()}`;
const PASSWORD = "correct-horse-battery";

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

test("the assistant answers from the account, and says where the figures came from", async ({
  page,
}) => {
  await registerViaUi(page, `ada.${run}@example.com`);

  await page.getByTestId("ask-prompt").click();
  await expect(page).toHaveURL(/\/assistant$/);
  await expect(page.getByText("I can't:")).toBeVisible();
  await expect(page.getByText(/only you can do that/)).toBeVisible();
  await noHorizontalScroll(page);

  // A suggested question is one the assistant actually recognises.
  await page.getByRole("button", { name: "What's my balance?" }).click();
  const answer = page.getByTestId("assistant-answer").first();
  await expect(answer).toContainText("£500.00");
  await expect(page.getByTestId("assistant-figures").first()).toContainText("From your account:");
  await expect(page.getByText(/Figures come from your account/)).toBeVisible();

  // Typed questions work the same way.
  await page.getByLabel("Your question").fill("How much cashback have I earned?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  const second = page.getByTestId("assistant-answer").nth(1);
  await expect(second).toContainText("haven't earned any cashback yet");
  await expect(second).toContainText("£1.00");
  await noHorizontalScroll(page);

  // Both turns stay on screen, in order.
  await expect(page.getByTestId("assistant-answer")).toHaveCount(2);
  await expect(page.locator(".ds-ask__you").first()).toHaveText("What's my balance?");
});

test("asking the assistant to pay gets a refusal and an empty payment form", async ({
  page,
  request,
}) => {
  const payee = `wren.${run}@example.com`;
  const res = await request.post("/api/v1/auth/register", {
    data: { email: payee, password: PASSWORD },
  });
  expect(res.status()).toBe(201);

  await registerViaUi(page, `bo.${run}@example.com`);
  await page.goto("/assistant");
  await page.getByLabel("Your question").fill(`pay ${payee} £250`);
  await page.getByRole("button", { name: "Ask", exact: true }).click();

  const answer = page.getByTestId("assistant-answer").first();
  await expect(answer).toContainText("can't send, cancel or refund money");
  await expect(answer).toContainText("nothing moves until you confirm it");

  // The only thing it offers is the screen where the person does it —
  // and that screen arrives empty, with nothing filled in for them.
  await page.getByRole("link", { name: "Go to the payment screen" }).click();
  await expect(page).toHaveURL(/\/pay$/);
  await expect(page.getByLabel("Amount")).toHaveValue("");
  await expect(page.getByLabel("To", { exact: true })).toHaveValue("");

  // And nothing moved while all that was happening.
  await page.goto("/");
  await expect(page.getByRole("region", { name: "Available balance" })).toContainText("£500.00");
});

test("the assistant explains a payment the risk checks flagged", async ({ page, request }) => {
  const stranger = `zed.${run}@example.com`;
  await request.post("/api/v1/auth/register", { data: { email: stranger, password: PASSWORD } });
  await registerViaUi(page, `cyd.${run}@example.com`);

  // A big payment to someone never paid before: flagged, acknowledged,
  // sent — the journey a person would want explained afterwards.
  await page.goto("/pay");
  await page.getByLabel("Amount").fill("300");
  await page.getByLabel("To", { exact: true }).fill(stranger);
  await page.getByRole("button", { name: "Review payment" }).click();
  await expect(page.getByText("This payment looks unusual")).toBeVisible();
  await page.getByLabel(/I've read the warning/).check();
  await page.getByRole("button", { name: "Pay £300.00" }).click();
  await expect(page.getByRole("heading", { name: "Payment sent" })).toBeVisible();

  await page.goto("/assistant");
  await page.getByLabel("Your question").fill("Why was my payment flagged?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();

  const answer = page.getByTestId("assistant-answer").first();
  await expect(answer).toContainText("£300.00");
  await expect(answer).toContainText(stranger);
  await expect(answer).toContainText("You haven't paid this person before");
  await expect(answer).toContainText("fixed rules");
  // The same discipline as the review screen: no score, no rule names.
  await expect(answer).not.toContainText("score");
  await expect(answer).not.toContainText("NEW_PAYEE");
});

test("the assistant won't give advice or look at anyone else", async ({ page, request }) => {
  const other = `ira.${run}@example.com`;
  await request.post("/api/v1/auth/register", { data: { email: other, password: PASSWORD } });
  await registerViaUi(page, `dee.${run}@example.com`);
  await page.goto("/assistant");

  const askAbout = async (question: string) => {
    await page.getByLabel("Your question").fill(question);
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    return page.getByTestId("assistant-answer").last();
  };

  await expect(await askAbout("should I put my savings in crypto?")).toContainText(
    "not a financial adviser"
  );
  await expect(await askAbout(`what's ${other}'s balance?`)).toContainText(
    "only see your own account"
  );
  await expect(await askAbout("someone says I'll be arrested unless I pay now")).toContainText(
    "pressure is itself the warning sign"
  );
  await expect(await askAbout("what's the weather in Leeds?")).toContainText(
    "don't know how to answer that one"
  );
  await noHorizontalScroll(page);
});
