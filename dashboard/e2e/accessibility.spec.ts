import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

/**
 * Accessibility smoke tests via axe-core.
 *
 * The bar is "no serious / critical violations on the rendered page".
 * We exclude minor/moderate findings from the failing set to keep the
 * gate signal high — a moderate-severity finding tends to be a
 * suggestion (e.g. landmark redundancy) rather than a real barrier.
 *
 * All API calls are mocked so the pages render their authenticated
 * state without a backend.
 */

const FAKE_USER = { id: "u1", email: "alice@example.com", name: "Alice" };
const FAKE_ORG = { id: "o1", name: "Test", slug: "test", role: "owner" as const };
const FAKE_SESSION = {
  user: FAKE_USER,
  organization: FAKE_ORG,
  organizations: [FAKE_ORG],
  via: "cookie",
};

async function mockBackend(page: import("@playwright/test").Page) {
  await page.route("**/auth/me", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(FAKE_SESSION),
    })
  );
  await page.route("**/health", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "ok",
        timestamp: new Date().toISOString(),
        services: { postgres: "connected", redis: "connected" },
      }),
    })
  );
  await page.route("**/organizations/current/quotas", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        subscriptions: { used: 1, limit: 100 },
        api_keys: { used: 0, limit: 10 },
      }),
    })
  );
  await page.route("**/subscriptions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          subscription_id: "11111111-2222-3333-4444-555555555555",
          organization_id: FAKE_ORG.id,
          connection_type: "graphql",
          args: {
            endpoint_url: "wss://api.example.com/graphql",
            query: "subscription { x }",
          },
          webhook_url: "https://hooks.example.com/in",
          status: "active",
          created_at: new Date().toISOString(),
        },
      ]),
    })
  );
  await page.route("**/subscriptions/status/all", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        statuses: [],
        checked_at: new Date().toISOString(),
      }),
    })
  );
  await page.route("**/deliveries/stats", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total_deliveries: 0,
        successful: 0,
        failed: 0,
        success_rate: 0,
        avg_response_time_ms: null,
        deliveries_24h: 0,
        deliveries_7d: 0,
      }),
    })
  );
  await page.route("**/deliveries/timeseries**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ range: "24 hours", buckets: [] }),
    })
  );
  await page.route("**/organizations/current/members", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: FAKE_USER.id,
          email: FAKE_USER.email,
          name: FAKE_USER.name,
          role: "owner",
          created_at: new Date().toISOString(),
        },
      ]),
    })
  );
}

async function expectNoSeriousAxeViolations(
  page: import("@playwright/test").Page
) {
  const results = await new AxeBuilder({ page })
    // WCAG AA + best-practice rules
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical"
  );

  if (blocking.length > 0) {
    // Print a compact summary so CI output is greppable.
    const summary = blocking.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.length,
    }));
    // eslint-disable-next-line no-console
    console.log("Axe violations:", JSON.stringify(summary, null, 2));
  }
  expect(blocking, "no serious/critical accessibility violations").toEqual([]);
}

test.describe("Accessibility — axe-core", () => {
  test("/login has no serious violations", async ({ page }) => {
    await page.route("**/auth/me", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Not authenticated" }),
      })
    );
    await page.goto("/login");
    await page.getByRole("heading", { name: "Sign in" }).waitFor();
    await expectNoSeriousAxeViolations(page);
  });

  test("/register has no serious violations", async ({ page }) => {
    await page.route("**/auth/me", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Not authenticated" }),
      })
    );
    await page.goto("/register");
    await page.getByRole("heading", { name: /Create your account/ }).waitFor();
    await expectNoSeriousAxeViolations(page);
  });

  test("dashboard home has no serious violations", async ({ page }) => {
    await mockBackend(page);
    await page.goto("/");
    await page.getByRole("heading", { name: "Dashboard" }).waitFor();
    await expectNoSeriousAxeViolations(page);
  });

  test("/subscriptions has no serious violations", async ({ page }) => {
    await mockBackend(page);
    await page.goto("/subscriptions");
    await page.getByRole("heading", { name: "Subscriptions" }).waitFor();
    await expectNoSeriousAxeViolations(page);
  });

  test("/settings has no serious violations", async ({ page }) => {
    await mockBackend(page);
    await page.goto("/settings");
    await page.getByRole("heading", { name: "Settings" }).waitFor();
    await expectNoSeriousAxeViolations(page);
  });
});
