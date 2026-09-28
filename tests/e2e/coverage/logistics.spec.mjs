// @coverage — logistics.html (event-scoped; previously uncovered screen).
import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { openScreen, assertNotRedirectedToLogin, assertScreenRendered, assertNoConsoleErrors, gotoWithEvent } from './_coverage-utils.mjs';

test.beforeAll(() => requireStagingEnv());

test('@coverage logistics loads authenticated, clean console, checklist add validates', async ({ browser }) => {
  const { context, page, consoleErrors } = await openScreen(browser, 'admin', '/logistics.html');
  try {
    assertNotRedirectedToLogin(page);
    await assertScreenRendered(page);

    const qid = await gotoWithEvent(page, '/logistics.html');
    expect(qid, 'admin should see at least one quote to scope logistics').toBeTruthy();
    assertNotRedirectedToLogin(page);

    // Item 3 — the logistics work pane renders for the event.
    await expect(page.locator('#pane'), 'the logistics pane must render').toBeVisible();

    // Item 4 — an empty checklist item (no title) must NOT be added.
    const addBtn = page.locator('#a_add');
    if (await addBtn.count() && await addBtn.isVisible().catch(() => false)) {
      const rows = page.locator('#pane [data-st], #pane [data-del]');
      const before = await rows.count();
      await page.locator('#a_title').fill('');
      await addBtn.click();
      await page.waitForTimeout(300);
      expect(await rows.count(), 'empty checklist item must not be added').toBeLessThanOrEqual(before);
    } else {
      test.info().annotations.push({ type: 'note', description: 'add control not rendered for this tab; empty-add check skipped' });
    }

    assertNoConsoleErrors(consoleErrors);
  } finally { await context.close(); }
});
