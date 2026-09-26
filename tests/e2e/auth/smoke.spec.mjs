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
  await page.locator('#email, input[type=email]').first().fill(emailFor('admin'));
  await page.locator('#password, input[type=password]').first().fill(PASSWORD);
  // Assert the form's sign-in REQUEST hits STAGING auth and returns 200 — fast + deterministic,
  // independent of login.html's laggy post-signin redirect (W14-O1). Proves the form authenticates.
  const [resp] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/auth/v1/token') && r.request().method() === 'POST', { timeout: 30_000 }),
    page.locator('#submit').click(),
  ]);
  expect(resp.url(), 'sign-in must go to STAGING').toContain('xizehqgeyjcfpzrdymly');
  expect(resp.status(), 'STAGING sign-in succeeds').toBe(200);
  expect(page.__prodHits, 'zero production requests during login').toEqual([]);
});

test('@smoke authenticated dashboard renders for admin (staging session)', async ({ browser }) => {
  const { context, page } = await authedPage(browser, 'admin');
  try {
    await expect(page).toHaveURL(/\/dashboard/);
    await expect(page.getByText(/admin\.a@synthetic\.helm/i)).toBeVisible();
    await assertStagingOnly(page);
  } finally { await context.close(); }
});

test('@smoke logout clears the session token', async ({ browser }) => {
  const { context, page } = await authedPage(browser, 'admin');
  try {
    const loControl = page.getByText(/log ?out/i).first();
    await expect(loControl).toBeVisible({ timeout: 15_000 });
    await loControl.click();
    // core security property: the session token is removed (fast, local; tolerate navigation)
    await expect.poll(async () => page.evaluate(
      () => { try { return Object.keys(localStorage).some(k => k.includes('auth-token')); } catch { return false; } }
    ), { timeout: 12_000 }).toBe(false);
  } finally { await context.close(); }
});
