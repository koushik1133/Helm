// @coverage — plan.html (Event details: venue + menu; event-scoped; previously uncovered screen).
// Item 4 (empty create form) is N/A: this screen edits an event's venue/menu via pre-populated
// selects gated by lock state, not a create/add form with required empty fields. Items 1–3 covered.
import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { openScreen, assertNotRedirectedToLogin, assertScreenRendered, assertNoConsoleErrors, gotoWithEvent } from './_coverage-utils.mjs';

test.beforeAll(() => requireStagingEnv());

test('@coverage plan loads authenticated, clean console, key controls render', async ({ browser }) => {
  const { context, page, consoleErrors } = await openScreen(browser, 'admin', '/plan.html');
  try {
    assertNotRedirectedToLogin(page);
    await assertScreenRendered(page);

    const qid = await gotoWithEvent(page, '/plan.html');
    expect(qid, 'admin should see at least one quote to scope plan').toBeTruthy();
    assertNotRedirectedToLogin(page);

    // Item 3 — the package selector renders for the event.
    await expect(page.locator('#p_pkg'), 'the package selector must render').toBeVisible();

    assertNoConsoleErrors(consoleErrors);
  } finally { await context.close(); }
});
