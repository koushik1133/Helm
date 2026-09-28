// @coverage — discovery.html (event-scoped; previously uncovered screen).
import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { openScreen, assertNotRedirectedToLogin, assertScreenRendered, assertNoConsoleErrors, gotoWithEvent } from './_coverage-utils.mjs';

test.beforeAll(() => requireStagingEnv());

test('@coverage discovery loads authenticated, clean console, requirement add validates', async ({ browser }) => {
  const { context, page, consoleErrors } = await openScreen(browser, 'admin', '/discovery.html');
  try {
    assertNotRedirectedToLogin(page);
    await assertScreenRendered(page);

    const qid = await gotoWithEvent(page, '/discovery.html');
    expect(qid, 'admin should see at least one quote to scope discovery').toBeTruthy();
    assertNotRedirectedToLogin(page);

    // Item 3 — the requirement "＋ Add" control renders for the event.
    await expect(page.locator('#r_add'), 'the add-requirement control must be present').toBeVisible();

    // Item 4 — submitting an empty requirement must NOT add a row.
    const rows = page.locator('#reqRows tr, #reqRows [data-id]');
    const before = await rows.count();
    await page.locator('#r_service').fill('');
    await page.locator('#r_add').click();
    await page.waitForTimeout(300);
    expect(await rows.count(), 'empty requirement must not be added').toBeLessThanOrEqual(before);

    assertNoConsoleErrors(consoleErrors);
  } finally { await context.close(); }
});
