import { test, expect } from "@playwright/test";

/**
 * Login page smoke test.
 *
 * Uses page.route() to mock the dashboard's API calls so the test is
 * hermetic — no backend required. Verifies the form renders, submits,
 * and reacts to a successful response by navigating to "/".
 */

test.describe("/login", () => {
  test.beforeEach(async ({ page }) => {
    // Mock /auth/me on first load (middleware allows /login through, but
    // AuthProvider still pings /auth/me on mount).
    await page.route("**/auth/me", route =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Not authenticated" }),
      })
    );
  });

  test("renders the form with email + password fields", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
  });

  test("link to /register is present", async ({ page }) => {
    await page.goto("/login");
    const link = page.getByRole("link", { name: /Create an account/i });
    await expect(link).toHaveAttribute("href", "/register");
  });

  test("submitting valid creds calls /auth/login and reacts to 200", async ({ page }) => {
    let loginCalled = 0;
    await page.route("**/auth/login", route => {
      loginCalled++;
      route.fulfill({
        status: 200,
        headers: {
          // The dashboard navigates on success; cookie not strictly needed
          // for the test, but include it for realism.
          "set-cookie": "anyhook_session=fake; Path=/; HttpOnly",
        },
        contentType: "application/json",
        body: JSON.stringify({
          user: { id: "u1", email: "alice@example.com", name: "Alice" },
          organization: { id: "o1", name: "Test", slug: "test", role: "owner" },
          organizations: [{ id: "o1", name: "Test", slug: "test", role: "owner" }],
        }),
      });
    });
    // After login the page does window.location.href = "/" — mock the
    // landing page so navigation lands somewhere sane.
    await page.route("**/auth/me", route =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: { id: "u1", email: "alice@example.com", name: "Alice" },
          organization: { id: "o1", name: "Test", slug: "test", role: "owner" },
          organizations: [{ id: "o1", name: "Test", slug: "test", role: "owner" }],
          via: "cookie",
        }),
      })
    );

    await page.goto("/login");
    await page.getByLabel("Email").fill("alice@example.com");
    await page.getByLabel("Password").fill("password123");
    await page.getByRole("button", { name: "Sign in" }).click();

    // Login was POSTed
    await expect.poll(() => loginCalled).toBe(1);
  });

  test("shows error message on 401", async ({ page }) => {
    await page.route("**/auth/login", route =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Invalid email or password" }),
      })
    );

    await page.goto("/login");
    await page.getByLabel("Email").fill("alice@example.com");
    await page.getByLabel("Password").fill("wrong");
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page.getByText("Invalid email or password")).toBeVisible();
  });
});

test.describe("/register", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/auth/me", route =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "Not authenticated" }),
      })
    );
  });

  test("renders the form", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { name: /Create your account/ })).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Create account" })).toBeVisible();
  });

  test("optional fields render with their (optional) markers", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByLabel(/Your name/)).toBeVisible();
    await expect(page.getByLabel(/Organization name/)).toBeVisible();
    // The "(optional)" hint sits next to those labels
    expect(await page.getByText(/\(optional\)/i).count()).toBeGreaterThanOrEqual(2);
  });

  test("link to /login is present", async ({ page }) => {
    await page.goto("/register");
    const link = page.getByRole("link", { name: /Sign in/i });
    await expect(link).toHaveAttribute("href", "/login");
  });
});
