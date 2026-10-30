// @smoke - "Continue where you left off" (0206) on localhost -> STAGING, two browser contexts (= two devices).
// Start a quote, fill client + discovery, click into Requirements; a SECOND browser context (a fresh
// session from the same saved login, no shared localStorage) shows the dashboard card at "step 3 of 8";
// saving the quotation (step 8) finishes it and the card is gone. The quote is moved to Deleted at the
// end (soft, restorable). Needs HELM_E2E_* staging env + 0206 applied on staging.
// Run: npx playwright test --project=chromium tests/e2e/workflow/resume.spec.mjs
import { test, expect } from '@playwright/test';
import { authedPage } from '../helpers/session.mjs';
import { requireStagingEnv } from '../helpers/env.mjs';
import { assertStagingOnly } from '../helpers/staging.mjs';

test.beforeAll(() => requireStagingEnv());
test.describe.configure({ timeout: 120_000 });

test('@smoke resume card follows the quote across devices until the quotation is saved', async ({ browser }) => {
  const a = await authedPage(browser, 'admin');
  let quoteId = null;
  try {
    // 1) start a quote: since r19 "New quote" opens flow.html directly (no name dialog / chooser)
    await a.page.locator('#createBtn').click();
    await a.page.waitForURL(/\/flow(\.html)?\?quote=/, { timeout: 30_000, waitUntil: 'domcontentloaded' });
    quoteId = new URL(a.page.url()).searchParams.get('quote');
    expect(quoteId).toMatch(/^[0-9a-f-]{36}$/);

    // 2) client + discovery, then into Requirements (the step save is debounced ~1.5 s)
    await a.page.locator('#c_name').fill('Resume Test');
    // client e-mail is now required for step 1 to save (reserved example.com domain: no real inbox)
    await a.page.locator('#c_email').fill('resume.e2e@example.com');
    await a.page.locator('#c_phone').fill('9876543210');
    await a.page.locator('#c_type').fill('Wedding');
    const d = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
    await a.page.locator('#c_date').fill(d);
    await a.page.locator('#c_date').blur();
    await a.page.locator('#d_mode').selectOption('call');
    await a.page.locator('#d_notes').fill('Garden theme');
    await a.page.locator('#d_notes').blur();
    await a.page.locator('#sec-reqs').click({ position: { x: 20, y: 20 } });
    await a.page.waitForTimeout(3_000);

    // 3) a second device: the dashboard card is there, at step 3
    const b = await authedPage(browser, 'admin');
    try {
      const card = b.page.locator('#hdResume, #flowResume').first();
      await expect(card).toBeVisible({ timeout: 20_000 });
      await expect(card).toContainText('step 3 of 8');
      await expect(card.getByRole('link', { name: /^Continue/ })).toHaveAttribute('href', new RegExp('flow(\\.html)?\\?quote=' + quoteId + '#sec-reqs'));
      // the Quotes "In progress" tab lists it for the whole studio
      await b.page.goto('/quotes.html?view=inprogress');
      await expect(b.page.locator('#ipWrap')).toContainText('Stopped at: Requirements', { timeout: 20_000 });

      // 4) save the quotation in step 8 -> finished
      await a.page.locator('#q_guests').fill('50');
      // plate price is read-only now (set by the menu package / Settings -> Pricing)
      await a.page.locator('#q_save').click();
      await expect(a.page.locator('#q_msg')).toContainText(/Saved/, { timeout: 20_000 });

      await b.page.goto('/dashboard.html');
      await b.page.waitForTimeout(4_000);
      const rows = await b.page.evaluate(async () => (await window.BPStore.flowProgress.list({ scope: 'mine', limit: 100 })).rows.map((r) => r.id));
      expect(rows).not.toContain(quoteId);
      await assertStagingOnly(b.page);
    } finally { await b.context.close(); }
  } finally {
    if (quoteId) await a.page.evaluate((id) => window.BPStore.quoteShelf && window.BPStore.quoteShelf.move(id, 'delete'), quoteId).catch(() => {});
    await a.context.close();
  }
});
