import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the AnyHook dashboard.
 *
 * Two scenarios:
 *   - Local dev: just run `npm run test:e2e`. webServer below boots
 *     `next start` against the prebuilt .next/, served on port 3000.
 *     The backend is NOT started by Playwright — tests use page.route()
 *     to mock all network calls so they're hermetic.
 *   - CI: same. The backend-tests CI job is separate from this one.
 *
 * Tests live in dashboard/e2e/.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3100",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Boot the dashboard for the test run. In CI, this needs `npm run build`
  // to have already produced .next/. Locally too — it's a one-line warmup.
  // Port 3100 is chosen to avoid the default 3000 in case the user has
  // their own dev server running.
  webServer: {
    command: "npx next start -p 3100",
    url: "http://localhost:3100/login",
    timeout: 60_000,
    reuseExistingServer: !process.env.CI,
    env: {
      NEXT_PUBLIC_API_URL: "http://localhost:3001",
    },
  },
});
