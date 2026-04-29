import { test, expect } from "@playwright/test";

/**
 * E2E for the 2FA flows. Two scenarios:
 *
 * 1. Settings → Security: enable, verify, backup-code display.
 * 2. /login: needs_2fa pending-token → verify-login → completes login.
 *
 * All API calls are mocked. The test asserts the dashboard's local
 * decision points (when does the form swap, what does the success
 * card render) rather than crypto round-trips.
 */

const FAKE_USER = {
  id: "u1",
  email: "alice@example.com",
  name: "Alice",
};
const FAKE_ORG = { id: "o1", name: "Test", slug: "test", role: "owner" as const };

const SESSION_RESPONSE = {
  user: FAKE_USER,
  organization: FAKE_ORG,
  organizations: [FAKE_ORG],
  via: "cookie",
};

test.describe("Settings → Security: 2FA enrollment", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/auth/me", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SESSION_RESPONSE),
      })
    );
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

  test("setup → verify-setup shows backup codes once", async ({ page }) => {
    let status = {
      enabled: false,
      enrollment_pending: false,
      unused_backup_codes: 0,
    };

    await page.route("**/auth/2fa/status", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(status),
      })
    );
    await page.route("**/auth/2fa/setup", (route) => {
      status = { ...status, enrollment_pending: true };
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          secret: "JBSWY3DPEHPK3PXP",
          otpauth_url:
            "otpauth://totp/AnyHook:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=AnyHook",
        }),
      });
    });
    await page.route("**/auth/2fa/verify-setup", (route) => {
      const body = route.request().postDataJSON();
      expect(body.code).toMatch(/^\d{6}$/);
      status = {
        enabled: true,
        enrollment_pending: false,
        unused_backup_codes: 10,
      };
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          enabled: true,
          backup_codes: Array.from(
            { length: 10 },
            (_, i) => `aaaaaaaa-${i.toString().padStart(8, "0").slice(0, 8)}`
          ),
          message: "Save these backup codes — they are shown only once.",
        }),
      });
    });

    await page.goto("/settings");
    await page.getByRole("button", { name: /^security$/i }).click();

    // Disabled state: shows the Enable button.
    const enableBtn = page.getByRole("button", { name: /^Enable$/ });
    await expect(enableBtn).toBeVisible();
    await enableBtn.click();

    // Setup card should now be visible with the secret.
    await expect(page.getByText("JBSWY3DPEHPK3PXP")).toBeVisible();

    // Type a 6-digit code, submit.
    await page.getByLabel(/6-digit code/i).fill("123456");
    await page.getByRole("button", { name: /^Verify$/ }).click();

    // Backup codes card.
    await expect(page.getByText(/Save your backup codes/i)).toBeVisible();
    // First backup code in our fake set.
    await expect(page.getByText(/^aaaaaaaa-00000000$/)).toBeVisible();
  });
});

test.describe("/login second-step 2FA", () => {
  test.beforeEach(async ({ page }) => {
    // Pre-2FA: no session yet.
    await page.route("**/auth/me", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Not authenticated" }),
      })
    );
  });

  test("login with 2FA-enabled user shows code input then completes", async ({
    page,
  }) => {
    await page.route("**/auth/login", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          needs_2fa: true,
          pending_token: "fake.pending.jwt",
        }),
      })
    );

    let verifyCalled = 0;
    await page.route("**/auth/2fa/verify-login", (route) => {
      verifyCalled++;
      const body = route.request().postDataJSON();
      expect(body.pending_token).toBe("fake.pending.jwt");
      expect(body.code).toBe("654321");
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(SESSION_RESPONSE),
      });
    });

    await page.goto("/login");
    await page.getByLabel("Email").fill("alice@example.com");
    await page.getByLabel("Password").fill("password123");
    await page.getByRole("button", { name: "Sign in" }).click();

    // The form swaps to the 2FA second-step view.
    await expect(
      page.getByRole("heading", { name: /Two-factor verification/i })
    ).toBeVisible();
    await page.getByLabel("Code").fill("654321");
    await page.getByRole("button", { name: "Verify" }).click();

    await expect.poll(() => verifyCalled).toBe(1);
  });

  test("verify-login error keeps the user on the code form", async ({ page }) => {
    await page.route("**/auth/login", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          needs_2fa: true,
          pending_token: "fake.pending.jwt",
        }),
      })
    );
    await page.route("**/auth/2fa/verify-login", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Invalid 2FA code" }),
      })
    );

    await page.goto("/login");
    await page.getByLabel("Email").fill("alice@example.com");
    await page.getByLabel("Password").fill("password123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByLabel("Code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();

    await expect(page.getByText(/Invalid 2FA code/i)).toBeVisible();
    // Still on the code form
    await expect(
      page.getByRole("heading", { name: /Two-factor verification/i })
    ).toBeVisible();
  });
});
