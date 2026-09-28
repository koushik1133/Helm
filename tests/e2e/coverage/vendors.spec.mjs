// @coverage — vendors.html (previously uncovered screen).
import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { openScreen, assertNotRedirectedToLogin, assertScreenRendered, assertNoConsoleErrors, assertEmptyModalRejected } from './_coverage-utils.mjs';

test.beforeAll(() => requireStagingEnv());

test('@coverage vendors loads authenticated, clean console, add-form validates', async ({ browser }) => {
  const { context, page, consoleErrors } = await openScreen(browser, 'admin', '/vendors.html');
  try {
    assertNotRedirectedToLogin(page);
    await assertScreenRendered(page);
    assertNoConsoleErrors(consoleErrors);

    const addBtn = page.locator('#newBtn');
    await expect(addBtn, 'the + Add partner control must be present').toBeVisible();

    // Empty submit → "Name is required." surfaced in #vm_err.
    await assertEmptyModalRejected(page, { trigger: '#newBtn', save: '#vm_save', err: '#vm_err' });
  } finally { await context.close(); }
});
