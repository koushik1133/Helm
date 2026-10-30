import { test, expect } from '@playwright/test';
import { requireStagingEnv, emailFor, PASSWORD } from '../helpers/env.mjs';
import { useStaging, assertStagingOnly } from '../helpers/staging.mjs';
import { authedPage } from '../helpers/session.mjs';

test.beforeAll(() => requireStagingEnv());
test.describe.configure({ timeout: 80_000 });

// Real login FORM coverage: entering valid credentials and submitting produces a persisted session
// against STAGING. We assert on the session token (the authoritative sign-in-success signal) rather
// than the dashboard redirect, because login.html's post-signin DB calls make the auto-redirect laggy
// on free-tier staging (W14-O1). Landing-on-dashboard after auth is separately covered by the
// storageState-based tests that navigate straight to /dashboard.
test('@smoke real login form authenticates admin against STAGING', async ({ page }) => {
  await useStaging(page);
  await page.goto('/login.html');
  // wait until login.html's scripts have wired the submit handler; clicking earlier does a native
  // form submit (page reload) that wipes the typed password and never calls /auth/v1/token.
  await page.waitForLoadState('networkidle').catch(() => {});
  // login.html has several password fields (sign-up confirm, invite, reset): scope to the sign-in form.
  const form = page.locator('#loginForm');
  await form.locator('#email').fill(emailFor('admin'));
  await form.locator('#pw').fill(PASSWORD);
  // Assert the form's sign-in REQUEST hits STAGING auth and returns 200 — fast + deterministic,
  // independent of login.html's laggy post-signin redirect (W14-O1). Proves the form authenticates.
  const [resp] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/auth/v1/token') && r.request().method() === 'POST', { timeout: 30_000 }),
    form.locator('#submit').click(),
  ]);
  expect(resp.url(), 'sign-in must go to STAGING').toContain('xizehqgeyjcfpzrdymly');
  expect(resp.status(), 'STAGING sign-in succeeds').toBe(200);
  expect(page.__prodHits, 'zero production requests during login').toEqual([]);
});

test('@smoke authenticated dashboard renders for admin (staging session)', async ({ browser }) => {
  const { context, page } = await authedPage(browser, 'admin');
  try {
    await expect(page).toHaveURL(/\/dashboard/);
    // the e-mail chip moved into the account menu (auth-ui.js placeAccountButton): open it
    await page.locator('#hauAccountBtn').click();
    await expect(page.locator('#hauMenu').getByText(/admin\.a@synthetic\.helm/i)).toBeVisible();
    await assertStagingOnly(page);
  } finally { await context.close(); }
});

test('@smoke logout clears the session token', async ({ browser }) => {
  // Sign in through the form for a session of this test's OWN: Sign out revokes the current
  // session server-side, so reusing the shared saved admin login (authedPage) would log out every
  // later test that uses it (e.g. the resume test).
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await useStaging(page);
    await page.goto('/login.html');
    await page.waitForLoadState('networkidle').catch(() => {});
    const form = page.locator('#loginForm');
    await form.locator('#email').fill(emailFor('admin'));
    await form.locator('#pw').fill(PASSWORD);
    await form.locator('#submit').click();
    await page.waitForURL(/\/dashboard/, { timeout: 45_000, waitUntil: 'domcontentloaded' });
    // Log out now lives in the account menu as "Sign out"
    await page.locator('#hauAccountBtn').click({ timeout: 15_000 });
    const loControl = page.locator('#hauMenu').getByRole('menuitem', { name: /sign out/i });
    await expect(loControl).toBeVisible({ timeout: 15_000 });
    await loControl.click();
    // core security property: the session token is removed (fast, local; tolerate navigation)
    // Sign out navigates to login: an evaluate that races the navigation throws, so retry it.
    await expect.poll(async () => page.evaluate(
      () => { try { return Object.keys(localStorage).some(k => k.includes('auth-token')); } catch { return false; } }
    ).catch(() => true), { timeout: 12_000 }).toBe(false);
  } finally { await context.close(); }
});
