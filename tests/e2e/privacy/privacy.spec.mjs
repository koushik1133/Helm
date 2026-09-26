import { test, expect } from '@playwright/test';
import { requireStagingEnv } from '../helpers/env.mjs';
import { loginAs } from '../helpers/auth.mjs';
import { authedPage } from '../helpers/session.mjs';

test.beforeAll(() => requireStagingEnv());

test('@privacy no service_role in page source or loaded scripts; staging anon only', async ({ browser }) => {
  const { context, page } = await authedPage(browser, 'admin');
  try {
    const html = await page.content();
    expect(html.includes('service_role'), 'no service_role literal in DOM/source').toBeFalsy();
    const scriptLeak = await page.evaluate(async () => {
      const urls = [...document.querySelectorAll('script[src]')].map(s => s.src).filter(u => u.startsWith(location.origin));
      for (const u of urls) { try { const t = await (await fetch(u)).text(); if (/service_role/.test(t)) return u; } catch {} }
      return null;
    });
    expect(scriptLeak, 'no service_role in bundled scripts').toBeNull();
  } finally { await context.close(); }
});

test('@privacy no PII/token/otp/password in dashboard URL', async ({ browser }) => {
  const { context, page } = await authedPage(browser, 'admin');
  try {
    expect(/token=|otp=|password=|email=|phone=/i.test(page.url())).toBeFalsy();
  } finally { await context.close(); }
});

// (logout/session-clear is covered deterministically in smoke.spec.mjs)
