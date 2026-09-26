// Responsive matrix — no unexpected horizontal overflow + key control reachable on critical pages.
import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { useStaging } from '../helpers/staging.mjs';
import { authedPage } from '../helpers/session.mjs';

test.beforeAll(() => requireStagingEnv());

const WIDTHS = [320, 360, 375, 390, 414, 768, 1024, 1440];

async function overflow(page) {
  return page.evaluate(() => ({
    docW: document.documentElement.scrollWidth,
    winW: window.innerWidth,
    overflow: document.documentElement.scrollWidth > window.innerWidth + 2,
  }));
}

for (const w of WIDTHS) {
  test(`@responsive login has no horizontal overflow @ ${w}px`, async ({ page }) => {
    await useStaging(page);
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto('/login.html');
    await expect(page.locator('#submit')).toBeVisible();      // primary action reachable
    const o = await overflow(page);
    expect(o.overflow, `no horizontal overflow (doc ${o.docW} > win ${o.winW})`).toBeFalsy();
  });
}

test('@responsive dashboard has no horizontal overflow across widths', async ({ browser }) => {
  const { context, page } = await authedPage(browser, 'admin');
  try {
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(200);
      const o = await overflow(page);
      expect(o.overflow, `dashboard overflow @ ${w}px (doc ${o.docW} > win ${o.winW})`).toBeFalsy();
    }
  } finally { await context.close(); }
});
