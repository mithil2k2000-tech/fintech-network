import { defineConfig, devices } from "@playwright/test";

// End-to-end tests drive the real apps against the real API and a real
// Postgres. Needs DATABASE_URL (migrated) and JWT_SECRET in the env.
// Starts every server itself unless they're already running.
//
// The merchant app runs here too, so one test can watch a shop take a
// payment in its own app while the customer pays in theirs — which is
// the only way to prove the two halves actually meet.
const API_PORT = Number(process.env.E2E_API_PORT ?? 3100);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5180);
const MERCHANT_PORT = Number(process.env.E2E_MERCHANT_PORT ?? 5181);
const ADMIN_PORT = Number(process.env.E2E_ADMIN_PORT ?? 5182);

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } }
      : {}),
  },
  projects: [
    { name: "phone", use: { ...devices["Pixel 7"], browserName: "chromium" } },
  ],
  webServer: [
    {
      command: "pnpm --filter @fintech-network/api exec tsx src/index.ts",
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: true,
      // Many sign-ups from one address in a minute is exactly what the
      // auth rate limit blocks, so the test server raises it.
      env: {
        PORT: String(API_PORT),
        RATE_LIMIT_PER_MINUTE: "1000",
        AUTH_RATE_LIMIT_PER_MINUTE: "1000",
        WRITE_RATE_LIMIT_PER_MINUTE: "1000",
      },
      timeout: 60_000,
    },
    {
      command: `pnpm exec vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: true,
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}` },
      timeout: 60_000,
    },
    {
      command: `pnpm --filter web-merchant exec vite --port ${MERCHANT_PORT} --strictPort`,
      url: `http://localhost:${MERCHANT_PORT}`,
      reuseExistingServer: true,
      env: {
        API_PROXY_TARGET: `http://localhost:${API_PORT}`,
        // A QR shown on the till points into the customer's app.
        VITE_PAY_ORIGIN: `http://localhost:${WEB_PORT}`,
      },
      timeout: 60_000,
    },
    {
      command: `pnpm --filter web-admin exec vite --port ${ADMIN_PORT} --strictPort`,
      url: `http://localhost:${ADMIN_PORT}`,
      reuseExistingServer: true,
      env: { API_PROXY_TARGET: `http://localhost:${API_PORT}` },
      timeout: 60_000,
    },
  ],
});

export const ADMIN_APP = `http://localhost:${ADMIN_PORT}`;
export const MERCHANT_APP = `http://localhost:${MERCHANT_PORT}`;
export const CONSUMER_APP = `http://localhost:${WEB_PORT}`;
