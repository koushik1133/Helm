// @coverage — budget.html (event-scoped; previously uncovered screen).
import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { openScreen, assertNotRedirectedToLogin, assertScreenRendered, assertNoConsoleErrors, gotoWithEvent } from './_coverage-utils.mjs';

test.beforeAll(() => requireStagingEnv());

test('@coverage budget loads authenticated, clean console, cost add validates', async ({ browser }) => {
  const { context, page, consoleErrors } = await openScreen(browser, 'admin', '/budget.html');
  try {
    assertNotRedirectedToLogin(page);
    await assertScreenRendered(page);

    const qid = await gotoWithEvent(page, '/budget.html');
    expect(qid, 'admin should see at least one quote to scope budget').toBeTruthy();
    assertNotRedirectedToLogin(page);

    // Item 3 — the cost "＋ Add" control renders for the event.
    await expect(page.locator('#c_add'), 'the add-cost control must be present').toBeVisible();

    // Item 4 — an empty cost line (no description) must NOT be added.
    const rows = page.locator('#costRows tr, #costRows [data-id]');
    const before = await rows.count();
    await page.locator('#c_desc').fill('');
    await page.locator('#c_add').click();
    await page.waitForTimeout(300);
    expect(await rows.count(), 'empty cost line must not be added').toBeLessThanOrEqual(before);

    assertNoConsoleErrors(consoleErrors);
  } finally { await context.close(); }
});
