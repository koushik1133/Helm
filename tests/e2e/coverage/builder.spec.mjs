// @coverage — builder.html (floor-plan builder canvas; previously uncovered screen).
// Item 4 (empty create form) is N/A: the builder is a canvas layout tool, not a record-create form
// with required empty fields (Save writes a layout version using a defaulted name). Items 1–3 covered.
import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { assertStagingOnly } from '../helpers/staging.mjs';
import { openScreen, assertNotRedirectedToLogin, assertNoConsoleErrors } from './_coverage-utils.mjs';

test.beforeAll(() => requireStagingEnv());

test('@coverage builder loads authenticated, clean console, canvas + toolbar render', async ({ browser }) => {
  const { context, page, consoleErrors } = await openScreen(browser, 'admin', '/builder.html');
  try {
    assertNotRedirectedToLogin(page);
    // The builder's only h1 is the "Helm Events" brand, which builder.css deliberately hides
    // (display:none) below 1500px to make room for the toolbar. So we assert it is in the DOM rather
    // than visible. (A11y note in r81-REPORT.md: a visually-hidden page heading would be better.)
    await assertStagingOnly(page);
    await expect(page.locator('h1').first(), 'builder page heading exists').toBeAttached();
    assertNoConsoleErrors(consoleErrors);

    // Item 3 — the Save control and the event/quote name input in the toolbar render.
    await expect(page.locator('#saveBtn'), 'the Save control must be present').toBeVisible();
    await expect(page.locator('#projName'), 'the builder toolbar (event name) must render').toBeVisible();
  } finally { await context.close(); }
});
