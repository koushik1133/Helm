// @coverage — control.html (Settings; previously uncovered screen).
import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { openScreen, assertNotRedirectedToLogin, assertScreenRendered, assertNoConsoleErrors } from './_coverage-utils.mjs';

test.beforeAll(() => requireStagingEnv());

test('@coverage control center loads authenticated, clean console, coupon add validates', async ({ browser }) => {
  const { context, page, consoleErrors } = await openScreen(browser, 'admin', '/control.html');
  try {
    assertNotRedirectedToLogin(page);
    await assertScreenRendered(page);
    assertNoConsoleErrors(consoleErrors);

    // Item 3 — a key control (add-coupon) exists.
    const addCoupon = page.locator('#co_add');
    await expect(addCoupon, 'the add-coupon control must be present').toBeVisible();

    // Item 4 — adding a coupon with an empty/too-short code is rejected with an inline message.
    await page.locator('#co_code').fill('');
    await addCoupon.click();
    // the message sits right under the coupon row (cc-pricing-validation), not in the page banner
    const msg = page.locator('#co_err');
    await expect(msg, 'empty coupon code must surface a validation message').toContainText(/coupon code/i);
  } finally { await context.close(); }
});
