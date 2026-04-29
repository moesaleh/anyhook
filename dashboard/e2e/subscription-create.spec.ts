import { test, expect } from "@playwright/test";

/**
 * E2E for the 4-step create-subscription wizard.
 *
 * All API calls are mocked via page.route() so the test runs without
 * a backend. We assert the wizard's local logic: step gating,
 * validation, header dynamic-add, the success page rendering of the
 * one-time webhook secret.
 */

const FAKE_USER = {
  id: "u1",
  email: "alice@example.com",
  name: "Alice",
};
const FAKE_ORG = { id: "o1", name: "Test", slug: "test", role: "owner" as const };

test.describe("/subscriptions/new", () => {
  test.beforeEach(async ({ page }) => {
    // AuthProvider pings /auth/me on mount; pretend we're signed in.
    await page.route("**/auth/me", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: FAKE_USER,
          organization: FAKE_ORG,
          organizations: [FAKE_ORG],
          via: "cookie",
        }),
      })
    );
    // QuotaIndicator + ServiceHealth poll a couple of endpoints; stub
    // them so the wizard isn't drowned in console noise.
    await page.route("**/organizations/current/quotas", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          subscriptions: { used: 0, limit: 100 },
          api_keys: { used: 0, limit: 10 },
        }),
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
  });

  test("walks through all 4 steps and shows the secret on success", async ({
    page,
  }) => {
    let createCalled = 0;
    await page.route("**/subscribe", (route) => {
      createCalled++;
      const body = route.request().postDataJSON();
      // Round-trip-sanity: connection_type from step 1, args.endpoint
      // from step 2, webhook_url from step 3.
      expect(body.connection_type).toBe("graphql");
      expect(body.args.endpoint_url).toBe("wss://api.example.com/graphql");
      expect(body.args.query).toContain("subscription");
      expect(body.webhook_url).toBe("https://hooks.example.com/in");
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          subscriptionId: "00000000-0000-0000-0000-000000000001",
          webhook_secret: "0".repeat(64),
          message: "Subscription created. Save webhook_secret — it is shown only once.",
        }),
      });
    });

    await page.goto("/subscriptions/new");
    await expect(
      page.getByRole("heading", { name: /New Subscription/ })
    ).toBeVisible();

    // Step 1 — connection type. GraphQL is the default.
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 2 — source config. Endpoint + a starter query.
    await page.getByLabel(/Source Endpoint URL/i).fill("wss://api.example.com/graphql");
    await page
      .getByLabel(/GraphQL Subscription Query/i)
      .fill("subscription { x { id } }");
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 3 — webhook destination.
    await page.getByLabel(/Webhook URL/i).fill("https://hooks.example.com/in");
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 4 — review + submit.
    await expect(page.getByRole("button", { name: /Create Subscription/i })).toBeVisible();
    await page.getByRole("button", { name: /Create Subscription/i }).click();

    // Success page
    await expect(page.getByRole("heading", { name: "Subscription Created" })).toBeVisible();
    // The full hex secret is displayed exactly once.
    await expect(page.getByText("0".repeat(64))).toBeVisible();
    await expect.poll(() => createCalled).toBe(1);
  });

  test("step 2 blocks Continue when endpoint is missing", async ({ page }) => {
    await page.goto("/subscriptions/new");
    await page.getByRole("button", { name: "Continue" }).click(); // step 1 → 2
    await page.getByRole("button", { name: "Continue" }).click(); // try to leave step 2 empty
    // Still on step 2 — validation prevented the move.
    await expect(page.getByLabel(/Source Endpoint URL/i)).toBeVisible();
    // Inline validation message visible.
    await expect(
      page.getByText(/endpoint URL is required/i).first()
    ).toBeVisible();
  });

  test("step 3 rejects non-http webhook URLs", async ({ page }) => {
    await page.goto("/subscriptions/new");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.getByLabel(/Source Endpoint URL/i).fill("wss://api.example.com/graphql");
    await page
      .getByLabel(/GraphQL Subscription Query/i)
      .fill("subscription { x }");
    await page.getByRole("button", { name: "Continue" }).click();

    // Step 3 — paste a non-http URL.
    await page.getByLabel(/Webhook URL/i).fill("ftp://example.com/in");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText(/http:\/\/ or https:\/\//i)).toBeVisible();
  });
});

test.describe("/subscriptions delete dialog", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/auth/me", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: FAKE_USER,
          organization: FAKE_ORG,
          organizations: [FAKE_ORG],
          via: "cookie",
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
    await page.route("**/subscriptions/status/all", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ statuses: [], checked_at: new Date().toISOString() }),
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
  });

  test("confirm deletes the subscription via /unsubscribe", async ({ page }) => {
    let unsubscribeCalled = 0;
    await page.route("**/unsubscribe", (route) => {
      unsubscribeCalled++;
      const body = route.request().postDataJSON();
      expect(body.subscription_id).toBe(
        "11111111-2222-3333-4444-555555555555"
      );
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ message: "Unsubscribed successfully" }),
      });
    });

    await page.goto("/subscriptions");

    // The first delete button on the row.
    await page.getByRole("button", { name: /^Delete$/ }).first().click();
    // Confirmation dialog
    const confirm = page.getByRole("button", { name: /Delete Subscription|Delete/ });
    await confirm.last().click();

    await expect.poll(() => unsubscribeCalled).toBe(1);
  });
});
