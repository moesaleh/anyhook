import { test, expect } from "@playwright/test";

/**
 * E2E for the negative / auth-edge flows the backend enforces, asserted
 * from the dashboard's point of view. Like the other specs in this dir,
 * every backend call is mocked with page.route() so the run is hermetic
 * (no live backend, no Kafka/Postgres/Redis).
 *
 * Covered (mirrors the backend behaviours the API can return):
 *   1. SSRF 400 on subscription create — POST /subscribe rejects a
 *      webhook_url that resolves to a private/loopback/IMDS address; the
 *      wizard stays on the form and surfaces an error instead of the
 *      one-time-secret success page.
 *   2. Quota 429 on subscription create — the org is at its subscription
 *      cap; apiFetch maps 429 -> RateLimitError and the wizard reports the
 *      failure rather than navigating to success.
 *   3. Expired-session (401) mid-session — a 401 from /auth/me during an
 *      in-app refresh drives AuthProvider to router.replace("/login").
 *   4. Org-switch — picking another org in the sidebar POSTs
 *      /auth/switch-org and re-reads /auth/me, swapping the active org.
 *   5. API-key create + revoke lifecycle — the settings panel shows the
 *      raw key once on create, then flips the row to "Revoked" on delete.
 */

const FAKE_USER = {
  id: "u1",
  email: "alice@example.com",
  name: "Alice",
};
const FAKE_ORG = { id: "o1", name: "Acme", slug: "acme", role: "owner" as const };
const OTHER_ORG = {
  id: "o2",
  name: "Globex",
  slug: "globex",
  role: "admin" as const,
};

const SESSION_RESPONSE = {
  user: FAKE_USER,
  organization: FAKE_ORG,
  organizations: [FAKE_ORG],
  via: "cookie" as const,
};

// A webhook target that the backend's SSRF guard rejects (link-local /
// cloud-metadata address). The dashboard does only a protocol check
// client-side, so http:// to a private host passes the wizard and the
// server is the one that says no.
const SSRF_WEBHOOK_URL = "http://169.254.169.254/latest/meta-data/";

/** Stub the endpoints the sidebar / dlq-alert poll so an authed page
 * renders without noise. Mirrors the minimal-mock convention the other
 * specs use (only what the mounted components fetch). */
async function stubChromeEndpoints(page: import("@playwright/test").Page) {
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
}

/** Walk the create-subscription wizard to step 4 with valid GraphQL
 * source config and the supplied webhook URL, then submit. Shared by the
 * SSRF and quota tests, which differ only in the /subscribe response. */
async function fillWizardAndSubmit(
  page: import("@playwright/test").Page,
  webhookUrl: string
) {
  await page.goto("/subscriptions/new");
  await expect(
    page.getByRole("heading", { name: /New Subscription/ })
  ).toBeVisible();

  // Step 1 — connection type (GraphQL default).
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 2 — source endpoint + query. Labels match step-source-config.tsx
  // ("Source Endpoint URL", "Subscription Query").
  await page
    .getByLabel(/Source Endpoint URL/i)
    .fill("wss://api.example.com/graphql");
  await page
    .getByLabel(/Subscription Query/i)
    .fill("subscription { x { id } }");
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 3 — webhook destination (passes the client-side protocol check).
  await page.getByLabel(/Webhook URL/i).fill(webhookUrl);
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 4 — review + submit.
  await page.getByRole("button", { name: /Create Subscription/i }).click();
}

test.describe("subscription create — SSRF 400", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/auth/me", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SESSION_RESPONSE),
      })
    );
    await stubChromeEndpoints(page);
  });

  test("rejects a private/IMDS webhook URL and stays on the form", async ({
    page,
  }) => {
    let subscribeCalled = 0;
    let sentWebhookUrl: string | undefined;
    await page.route("**/subscribe", (route) => {
      subscribeCalled++;
      sentWebhookUrl = route.request().postDataJSON()?.webhook_url;
      // What src/lib/url-validation.js -> the /subscribe handler returns
      // for a destination that resolves to a blocked address.
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: "webhook_url resolves to a private or reserved IP address",
        }),
      });
    });

    await fillWizardAndSubmit(page, SSRF_WEBHOOK_URL);

    // The request went out with exactly the URL we typed (so the guard is
    // really server-side, not a client pre-filter).
    await expect.poll(() => subscribeCalled).toBe(1);
    expect(sentWebhookUrl).toBe(SSRF_WEBHOOK_URL);

    // The wizard surfaces a failure banner and does NOT advance to the
    // one-time-secret success page.
    await expect(
      page.getByText(/Failed to create subscription/i)
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Subscription Created" })
    ).toHaveCount(0);
    // Still on step 4 — the submit button is back to its idle label.
    await expect(
      page.getByRole("button", { name: /Create Subscription/i })
    ).toBeVisible();
  });
});

test.describe("subscription create — quota 429", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/auth/me", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SESSION_RESPONSE),
      })
    );
    await stubChromeEndpoints(page);
  });

  test("handles a 429 quota response without navigating to success", async ({
    page,
  }) => {
    let subscribeCalled = 0;
    await page.route("**/subscribe", (route) => {
      subscribeCalled++;
      // The quota middleware returns 429 with Retry-After when the org is
      // at its subscription cap; the dashboard's apiFetch reads that
      // header into a RateLimitError.
      route.fulfill({
        status: 429,
        headers: { "Retry-After": "120" },
        contentType: "application/json",
        body: JSON.stringify({
          error: "Subscription quota exceeded (100/100)",
        }),
      });
    });

    await fillWizardAndSubmit(page, "https://hooks.example.com/in");

    await expect.poll(() => subscribeCalled).toBe(1);
    // Wizard reports the failure and remains on the form (no success page).
    await expect(
      page.getByText(/Failed to create subscription/i)
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Subscription Created" })
    ).toHaveCount(0);
  });
});

test.describe("expired session — 401 mid-session redirects to /login", () => {
  test("a 401 from /auth/me during refresh sends the user to /login", async ({
    page,
  }) => {
    // First /auth/me (AuthProvider mount) succeeds: the app renders
    // authenticated with two orgs so the switcher is usable. The SECOND
    // call (triggered by switchOrg -> refresh) returns 401 to model a
    // session that lapsed mid-session.
    let meCalls = 0;
    await page.route("**/auth/me", (route) => {
      meCalls++;
      if (meCalls === 1) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            user: FAKE_USER,
            organization: FAKE_ORG,
            organizations: [FAKE_ORG, OTHER_ORG],
            via: "cookie",
          }),
        });
      }
      return route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Session expired" }),
      });
    });
    // The switch-org write itself still goes through (the cookie was only
    // borderline-expired); the redirect comes from the follow-up identity
    // refresh, exactly as AuthProvider.refresh() intends.
    await page.route("**/auth/switch-org", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ organization_id: OTHER_ORG.id }),
      })
    );
    await stubChromeEndpoints(page);

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    // Open the org picker and pick the other org -> switchOrg -> refresh.
    await page
      .getByRole("button", { name: /Switch organization/i })
      .click();
    await page.getByRole("menuitem", { name: /Globex/ }).click();

    // AuthProvider.refresh() saw an AuthError and replaced the route.
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe("org-switch", () => {
  test("switching org POSTs /auth/switch-org and swaps the active org", async ({
    page,
  }) => {
    // /auth/me returns the active org; after the switch the dashboard
    // re-reads it and we flip which org is "current". Typed wide enough to
    // hold either org's role literal.
    let activeOrg: { id: string; name: string; slug: string; role: string } =
      FAKE_ORG;
    await page.route("**/auth/me", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: FAKE_USER,
          organization: activeOrg,
          organizations: [FAKE_ORG, OTHER_ORG],
          via: "cookie",
        }),
      })
    );

    let switchCalled = 0;
    let switchedTo: string | undefined;
    await page.route("**/auth/switch-org", (route) => {
      switchCalled++;
      switchedTo = route.request().postDataJSON()?.organization_id;
      activeOrg = OTHER_ORG; // subsequent /auth/me reflects the new org
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ organization_id: OTHER_ORG.id }),
      });
    });
    await stubChromeEndpoints(page);

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    // The trigger shows the current org name before switching.
    const trigger = page.getByRole("button", { name: /Switch organization/i });
    await expect(trigger).toContainText("Acme");

    await trigger.click();
    await page.getByRole("menuitem", { name: /Globex/ }).click();

    await expect.poll(() => switchCalled).toBe(1);
    expect(switchedTo).toBe(OTHER_ORG.id);
    // After refresh() the active org in the sidebar is now Globex.
    await expect(
      page.getByRole("button", { name: /Switch organization/i })
    ).toContainText("Globex");
  });
});

test.describe("API key lifecycle — create then revoke", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/auth/me", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SESSION_RESPONSE),
      })
    );
    await stubChromeEndpoints(page);
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
  });

  test("create shows the raw key once, then revoke flips the row", async ({
    page,
  }) => {
    const KEY_ID = "key-1";
    const RAW_KEY = "ak_live_" + "a".repeat(40);
    // The list mutates across the lifecycle: empty -> one active key ->
    // that key revoked. A small bit of server-state simulation keeps the
    // re-fetch after each mutation honest.
    let revokedAt: string | null = null;
    let keyExists = false;

    await page.route("**/organizations/current/api-keys", (route) => {
      const method = route.request().method();
      if (method === "POST") {
        // POST -> created-once payload (CreatedApiKey carries `key`).
        keyExists = true;
        const name = route.request().postDataJSON()?.name ?? "Test Key";
        return route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            id: KEY_ID,
            name,
            key_prefix: "ak_live_a",
            key: RAW_KEY,
            last_used_at: null,
            expires_at: null,
            revoked_at: null,
            created_at: new Date().toISOString(),
            message: "Save this API key — it is shown only once.",
          }),
        });
      }
      // GET list — reflects current server state.
      const keys = keyExists
        ? [
            {
              id: KEY_ID,
              name: "Test Key",
              key_prefix: "ak_live_a",
              last_used_at: null,
              expires_at: null,
              revoked_at: revokedAt,
              created_at: new Date().toISOString(),
            },
          ]
        : [];
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(keys),
      });
    });

    // DELETE /…/api-keys/:id -> mark revoked for the next list fetch.
    let revokeCalled = 0;
    await page.route("**/organizations/current/api-keys/*", (route) => {
      if (route.request().method() === "DELETE") {
        revokeCalled++;
        revokedAt = new Date().toISOString();
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ message: "API key revoked" }),
        });
      }
      return route.fallback();
    });

    await page.goto("/settings");
    await page.getByRole("button", { name: /^api keys$/i }).click();

    // Empty state first.
    await expect(page.getByText(/No API keys yet/i)).toBeVisible();

    // Create a key.
    await page.getByRole("button", { name: /New API key/i }).click();
    await page.getByLabel(/Key name/i).fill("Test Key");
    await page.getByRole("button", { name: /^Create$/ }).click();

    // The one-time secret banner shows the raw key value verbatim.
    await expect(page.getByText(/shown only once/i)).toBeVisible();
    await expect(page.getByText(RAW_KEY)).toBeVisible();

    // The row is now Active.
    const row = page.getByRole("row", { name: /Test Key/ });
    await expect(row).toContainText("Active");

    // Revoke it — the app's confirm dialog (not native confirm()) opens.
    // The row's trash button and the dialog's confirm button share the
    // "Revoke key" name, so scope the confirm click to the dialog.
    await row.getByRole("button", { name: /Revoke key/i }).click();
    const dialog = page.getByRole("alertdialog", { name: /Revoke API key/i });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: /Revoke key/i }).click();

    await expect.poll(() => revokeCalled).toBe(1);
    // After the re-fetch the same row now reads Revoked.
    await expect(
      page.getByRole("row", { name: /Test Key/ })
    ).toContainText("Revoked");
  });
});
