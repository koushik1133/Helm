// @coverage — staff.html (previously uncovered screen).
import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { openScreen, assertNotRedirectedToLogin, assertScreenRendered, assertNoConsoleErrors, assertEmptyModalRejected } from './_coverage-utils.mjs';

test.beforeAll(() => requireStagingEnv());

test('@coverage staff loads authenticated, clean console, add-form validates', async ({ browser }) => {
  const { context, page, consoleErrors } = await openScreen(browser, 'admin', '/staff.html');
  try {
    assertNotRedirectedToLogin(page);
    await assertScreenRendered(page);
    assertNoConsoleErrors(consoleErrors);

    // Item 3 — key control ("＋ Add staff") exists (admin can edit → not hidden).
    const addBtn = page.locator('#newBtn');
    await expect(addBtn, 'the + Add staff control must be present').toBeVisible();

    // Item 4 — empty submit rejected with a validation message (Wave 16).
    await assertEmptyModalRejected(page, { trigger: '#newBtn', save: '#sm_save', err: '#sm_err' });
  } finally { await context.close(); }
});
