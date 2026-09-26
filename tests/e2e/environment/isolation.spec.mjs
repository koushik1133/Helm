import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { assertStagingOnly } from '../helpers/staging.mjs';
import { authedPage } from '../helpers/session.mjs';

test.beforeAll(() => requireStagingEnv());

// (Real login->STAGING selection is additionally covered by smoke.spec's assertStagingOnly after a
//  live UI login. Here we use a stored session to make the isolation assertions deterministic.)
test('@security app selects STAGING and makes zero production requests', async ({ browser }) => {
  const { context, page } = await authedPage(browser, 'admin');
  try {
    await page.waitForTimeout(1500);           // allow dashboard XHRs to fire
    await assertStagingOnly(page);             // throws if any prod-ref request was seen
  } finally { await context.close(); }
});

test('@security production Supabase project ref never appears in any network destination', async ({ browser }) => {
  const { context, page } = await authedPage(browser, 'sales');
  try {
    const seenProd = [];
    page.on('request', (r) => { if (r.url().includes('nqltzgiwznphugcfhmbm')) seenProd.push(r.url()); });
    await page.reload();
    await page.waitForTimeout(1500);
    expect(seenProd, 'no request may target the production project').toEqual([]);
  } finally { await context.close(); }
});
