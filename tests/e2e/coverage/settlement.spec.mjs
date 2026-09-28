// @coverage — settlement.html (event-scoped; previously uncovered screen).
import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { openScreen, assertNotRedirectedToLogin, assertScreenRendered, assertNoConsoleErrors, gotoWithEvent, assertEmptyAlertRejected } from './_coverage-utils.mjs';

test.beforeAll(() => requireStagingEnv());

test('@coverage settlement loads authenticated, clean console, add-expense validates', async ({ browser }) => {
  const { context, page, consoleErrors } = await openScreen(browser, 'admin', '/settlement.html');
  try {
    assertNotRedirectedToLogin(page);
    await assertScreenRendered(page);

    // The add controls are event-scoped: select the session's first quote as the event context.
    const qid = await gotoWithEvent(page, '/settlement.html');
    expect(qid, 'admin should see at least one quote to scope settlement').toBeTruthy();
    assertNotRedirectedToLogin(page);

    // Item 3 — the expense "＋ Add" control renders for the event.
    await expect(page.locator('#e_add'), 'the add-expense control must be present').toBeVisible();

    // Item 4 — empty expense (no payee) is rejected client-side via a blocking alert.
    await assertEmptyAlertRejected(page, '#e_add');

    assertNoConsoleErrors(consoleErrors);
  } finally { await context.close(); }
});
