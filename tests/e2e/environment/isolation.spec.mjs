import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { loginAs } from '../helpers/auth.mjs';
import { assertStagingOnly } from '../helpers/staging.mjs';

test.beforeAll(() => requireStagingEnv());

test('@security app selects STAGING and makes zero production requests', async ({ page }) => {
  await loginAs(page, 'admin');
  await page.waitForTimeout(1500);           // allow dashboard XHRs to fire
  await assertStagingOnly(page);             // throws if any prod-ref request was seen
});

test('@security production Supabase project ref never appears in any network destination', async ({ page }) => {
  const seenProd = [];
  page.on('request', (r) => { if (r.url().includes('nqltzgiwznphugcfhmbm')) seenProd.push(r.url()); });
  await loginAs(page, 'sales');
  await page.waitForTimeout(1500);
  expect(seenProd, 'no request may target the production project').toEqual([]);
});
