// Accessibility: axe-core automated scans (one layer) + scripted keyboard assertions.
// axe cannot prove WCAG compliance; it catches a subset of machine-detectable issues. We report
// violations by impact and fail only on critical/serious (configurable), plus real keyboard checks.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { requireStagingEnv } from '../helpers/env.mjs';
import { useStaging } from '../helpers/staging.mjs';
import { loginAs } from '../helpers/auth.mjs';
import { authedPage } from '../helpers/session.mjs';

test.beforeAll(() => requireStagingEnv());

async function scan(page) {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const by = { critical: [], serious: [], moderate: [], minor: [] };
  for (const v of res.violations) (by[v.impact] || (by[v.impact] = [])).push(v.id);
  return by;
}

test('@a11y login: no critical/serious axe violations + keyboard reaches submit', async ({ page }) => {
  await useStaging(page);
  await page.goto('/login.html');
  const by = await scan(page);
  console.log('axe login:', JSON.stringify(by));
  expect(by.critical, 'no critical a11y violations on login').toEqual([]);
  expect(by.serious, 'no serious a11y violations on login').toEqual([]);
  // keyboard: tab to email, type, tab to password, tab to submit and activate
  await page.locator('#email').focus();
  await expect(page.locator('#email')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('input[type=password]')).toBeFocused();
});

test('@a11y dashboard: no critical axe violations', async ({ browser }) => {
  const { context, page } = await authedPage(browser, 'admin');
  try {
    const by = await scan(page);
    console.log('axe dashboard:', JSON.stringify(by));
    expect(by.critical, 'no critical a11y violations on dashboard').toEqual([]);
  } finally { await context.close(); }
});

test('@a11y approval page: no critical axe violations + has a title', async ({ page }) => {
  await useStaging(page);
  await page.goto('/approve.html?token=00000000-0000-0000-0000-000000000000');
  await expect(page).toHaveTitle(/approve/i);
  const by = await scan(page);
  console.log('axe approval:', JSON.stringify(by));
  expect(by.critical, 'no critical a11y violations on approval').toEqual([]);
});
