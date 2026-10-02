import { devices, type Browser, type Page } from "@playwright/test";
import { CONSUMER_APP } from "../playwright.config";

/**
 * A second person, on a phone of their own.
 *
 * Since Phase 14 a session is an httpOnly cookie, and a cookie belongs
 * to a browser rather than to a tab — signing in as someone else in a
 * second tab signs you out of the first, in these tests and in real
 * life. So each person in a test gets their own browser context, which
 * is what a second phone actually is. (The merchant app is the one
 * exception: its cookie is scoped to that app, so the same person can
 * have the till and their own app open together.)
 */
export async function openPhoneFor(browser: Browser, baseURL = CONSUMER_APP): Promise<Page> {
  const context = await browser.newContext({ ...devices["Pixel 7"], baseURL });
  return context.newPage();
}

/** Puts the phone away. */
export async function closePhone(page: Page): Promise<void> {
  await page.context().close();
}
