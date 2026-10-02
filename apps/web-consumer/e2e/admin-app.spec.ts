import { test, expect } from "@playwright/test";
import { ADMIN_APP } from "../playwright.config";

// Phase 15: the admin app is a real app now. What can be driven from
// here without a database is the door — an operations view is
// admin-only, and an ordinary account has to be told so plainly rather
// than shown a screen full of refusals. The numbers themselves are
// checked against the tables they came from in the API's integration
// tests, which is where that belongs.

const run = `${Date.now()}`;
const PASSWORD = "correct-horse-battery";

test("the admin app turns away an account that isn't an administrator", async ({
  page,
  request,
}) => {
  const email = `notadmin.${run}@example.com`;
  const registered = await request.post("/api/v1/auth/register", {
    data: { email, password: PASSWORD },
  });
  expect(registered.status()).toBe(201);

  await page.goto(`${ADMIN_APP}/`);
  await expect(page).toHaveURL(/\/signin$/);
  // No way to make an account from here, and it says so.
  await expect(page.getByText("Admin accounts aren't created here.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Create account" })).toHaveCount(0);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByText("This account can't see the admin app")).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/signin$/);
});

test("a wrong password is refused, and says nothing about whether the account exists", async ({
  page,
}) => {
  await page.goto(`${ADMIN_APP}/signin`);
  await page.getByLabel("Email").fill(`nobody.${run}@example.com`);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("That email and password don't match.")).toBeVisible();
});
