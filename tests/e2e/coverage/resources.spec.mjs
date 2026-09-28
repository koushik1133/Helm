// @coverage — resources.html (event-scoped; previously uncovered screen).
import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { openScreen, assertNotRedirectedToLogin, assertScreenRendered, assertNoConsoleErrors, gotoWithEvent } from './_coverage-utils.mjs';

test.beforeAll(() => requireStagingEnv());

test('@coverage resources loads authenticated, clean console, need add validates', async ({ browser }) => {
  const { context, page, consoleErrors } = await openScreen(browser, 'admin', '/resources.html');
  try {
    assertNotRedirectedToLogin(page);
    await assertScreenRendered(page);

    const qid = await gotoWithEvent(page, '/resources.html');
    expect(qid, 'admin should see at least one quote to scope resources').toBeTruthy();
    assertNotRedirectedToLogin(page);

    // Item 3 — the need "＋ Add" control renders for the event.
    await expect(page.locator('#n_add'), 'the add-need control must be present').toBeVisible();

    // Item 4 — a "custom" need with an empty label must NOT be added.
    const rows = page.locator('#rows tr, #rows [data-id]');
    const before = await rows.count();
    await page.locator('#n_kind').selectOption('other');
    await page.locator('#n_label').fill('');
    await page.locator('#n_add').click();
    await page.waitForTimeout(300);
    expect(await rows.count(), 'empty custom need must not be added').toBeLessThanOrEqual(before);

    assertNoConsoleErrors(consoleErrors);
  } finally { await context.close(); }
});
