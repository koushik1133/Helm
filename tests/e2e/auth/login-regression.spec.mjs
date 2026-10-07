// Login / org-bootstrap regression guards.
//
// These cover the two failures found & fixed on 2026-10-01, so they can't silently return:
//   1) "Database error querying schema" (HTTP 500) on sign-in — caused by auth.users rows
//      created with NULL GoTrue token columns (create_helm_user bug). A login must return a
//      session (200), NEVER a 5xx. See supabase/prod-fix/create-helm-user-token-columns-fix.sql.
//   2) The app mislabelling a server/DB error as "Couldn't reach the server". A WRONG password
//      must be classified as invalid credentials (HTTP 400), not a network/connection failure.
//
// STAGING-only, same conventions as auth/smoke.spec.mjs (useStaging + env creds + prod-hit guard).
import { test, expect } from '@playwright/test';
import { requireStagingEnv, emailFor, PASSWORD } from '../helpers/env.mjs';
import { useStaging, assertStagingOnly } from '../helpers/staging.mjs';
import { authedPage } from '../helpers/session.mjs';

test.beforeAll(() => requireStagingEnv());
test.describe.configure({ timeout: 80_000 });

const STAGING_REF = 'xizehqgeyjcfpzrdymly';

// A real seeded role account must sign in with a 200 session — and categorically NOT a 5xx.
// This is the direct guard for the NULL-token-column bug (which returned HTTP 500 on every login).
test('@smoke @auth sign-in returns a session, never a 5xx (NULL-token-column guard)', async ({ page }) => {
  await useStaging(page);
  await page.goto('/login.html');
  await page.locator('#email, input[type=email]').first().fill(emailFor('planner'));
  await page.locator('#password, input[type=password]').first().fill(PASSWORD);

  const [resp] = await Promise.all([
    page.waitForResponse(
      r => r.url().includes('/auth/v1/token') && r.request().method() === 'POST',
      { timeout: 30_000 },
    ),
    page.locator('#submit').click(),
  ]);

  expect(resp.url(), 'sign-in must go to STAGING').toContain(STAGING_REF);
  expect(resp.status(), 'sign-in must NOT be a server/DB error (e.g. "Database error querying schema")')
    .toBeLessThan(500);
  expect(resp.status(), 'valid credentials authenticate (200)').toBe(200);
  const body = await resp.json().catch(() => ({}));
  expect(body.access_token, 'a session token is issued on success').toBeTruthy();
  expect(page.__prodHits, 'zero production requests during login').toEqual([]);
});

// A wrong password must be a clean credentials rejection (400), never a 5xx, and the UI must
// say so — not the generic "couldn't reach the server" copy that masked the real error.
test('@auth wrong password → invalid credentials (400), classified as auth not network', async ({ page }) => {
  await useStaging(page);
  await page.goto('/login.html');
  await page.locator('#email, input[type=email]').first().fill(emailFor('planner'));
  await page.locator('#password, input[type=password]').first().fill('definitely-not-the-password-' + Date.now());

  const [resp] = await Promise.all([
    page.waitForResponse(
      r => r.url().includes('/auth/v1/token') && r.request().method() === 'POST',
      { timeout: 30_000 },
    ),
    page.locator('#submit').click(),
  ]);

  // Server side: a clean 400 invalid-credentials, never a 5xx DB/schema error.
  expect(resp.status(), 'wrong password is a 400, not a 5xx').toBe(400);
  const body = await resp.json().catch(() => ({}));
  expect(JSON.stringify(body)).toMatch(/invalid.?credentials/i);

  // Client side: the error is surfaced, and NOT mislabelled as a connectivity problem.
  const errText = (await page.locator('body').innerText()).toLowerCase();
  expect(errText, 'a credentials error is shown to the user').toMatch(/credential|password|sign/i);
  expect(errText, 'must NOT be mislabelled as a network/connection failure')
    .not.toMatch(/couldn.?t reach the server|check your connection/i);
  expect(page.__prodHits, 'zero production requests during login').toEqual([]);
});

// Org-bootstrap guard: a signed-in non-admin role resolves an org and lands on the dashboard
// (not bounced to /login). Proves the account is fully provisioned (profile has org_id), which is
// what makes the whole RBAC/RLS surface usable rather than empty.
test('@smoke @auth signed-in role has an org and reaches the dashboard', async ({ browser }) => {
  const { context, page } = await authedPage(browser, 'planner');
  try {
    await expect(page, 'authed role lands on the dashboard, not back at login').toHaveURL(/\/dashboard/);
    await expect(page.locator('body')).not.toContainText(/sign in on the dashboard|welcome back/i);
    await assertStagingOnly(page);
  } finally { await context.close(); }
});
