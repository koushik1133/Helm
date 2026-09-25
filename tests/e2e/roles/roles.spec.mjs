// Non-vacuous role authorization at the data layer, driven through a real logged-in browser session.
// ALLOWED: must actually see a same-org record. DENIED: must get zero rows / auth failure.
import { test, expect } from '@playwright/test';
import { requireStagingEnv, STAGING_URL } from '../helpers/env.mjs';
import { loginAs } from '../helpers/auth.mjs';
import { assertStagingOnly } from '../helpers/staging.mjs';

test.beforeAll(() => requireStagingEnv());

// read a REST collection from inside the authenticated page (uses the page's own session token)
async function pageSelect(page, path) {
  return page.evaluate(async ([base, p]) => {
    let tok = null;
    for (const k of Object.keys(localStorage)) if (k.includes('auth-token')) { try { tok = JSON.parse(localStorage[k]).access_token; } catch {} }
    const r = await fetch(base + '/rest/v1/' + p, { headers: { apikey: window.SUPABASE_CONFIG.anonKey, Authorization: 'Bearer ' + tok } });
    const b = await r.json().catch(() => null);
    return { status: r.status, count: Array.isArray(b) ? b.length : -1 };
  }, [STAGING_URL, path]);
}

test('@roles admin sees Org A quotes (>0) — non-vacuous allow', async ({ page }) => {
  await loginAs(page, 'admin');
  await assertStagingOnly(page);
  const q = await pageSelect(page, 'quotes?select=id&limit=50');
  expect(q.status).toBe(200);
  expect(q.count, 'admin must actually see quotes').toBeGreaterThan(0);
});

test('@roles client sees zero quotes/leads/payments — enforced denial', async ({ page }) => {
  await loginAs(page, 'client');
  await assertStagingOnly(page);
  for (const tbl of ['quotes', 'leads', 'quote_payments']) {
    const r = await pageSelect(page, tbl + '?select=id&limit=50');
    expect(r.status).toBe(200);
    expect(r.count, `client must not see ${tbl}`).toBe(0);
  }
});

test('@roles all 11 roles authenticate through the real UI', async ({ page }) => {
  const roles = ['admin','manager','planner','sales','coordinator','supervisor','quality','operations','crew','worker','client'];
  for (const role of roles) {
    await loginAs(page, role);
    await expect(page, `${role} should reach dashboard`).toHaveURL(/\/dashboard/);
    await page.goto('/login.html');   // reset for next role (session replaced on next login)
  }
});
