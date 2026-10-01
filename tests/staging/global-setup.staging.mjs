// =============================================================================
// tests/staging/global-setup.staging.mjs
//
// HARD staging gate for playwright.staging.config.mjs. Runs ONCE before any test.
// It opens the preview URL in a real browser, reads the frontend's resolved
// window.SUPABASE_CONFIG.url, and ABORTS THE ENTIRE RUN (throws) unless it
// resolves to the STAGING project ref. This guarantees Playwright can never
// drive write flows against a preview that is (mis)wired to production.
//
// Also forwards HELM_E2E_* env to the per-role auth setup, same as the localhost
// config's global-setup. Nothing here mutates data.
// =============================================================================
import { chromium } from '@playwright/test';

const PROD_REF = 'nqltzgiwznphugcfhmbm';     // must NEVER be the resolved target
const STAGING_REF = 'xizehqgeyjcfpzrdymly';  // the ONLY allowed target

export default async function globalSetup() {
  const PREVIEW_URL = process.env.PREVIEW_URL || '';
  if (!PREVIEW_URL) {
    throw new Error('[staging-gate] PREVIEW_URL is required (the staging-wired Vercel preview alias).');
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const prodHits = [];
    page.on('request', (r) => { if (r.url().includes(PROD_REF)) prodHits.push(r.url()); });

    await page.goto(PREVIEW_URL, { waitUntil: 'domcontentloaded' });
    const cfg = await page.evaluate(() => ({
      url: (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url) || '',
      staging: !!(window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.__staging),
    }));

    if (!cfg.url.includes(STAGING_REF)) {
      throw new Error(
        `[staging-gate] ABORT: preview ${PREVIEW_URL} did NOT resolve to STAGING ` +
        `(${STAGING_REF}). Resolved url="${cfg.url}". Refusing to run any tests.`
      );
    }
    if (cfg.url.includes(PROD_REF)) {
      throw new Error(
        `[staging-gate] ABORT: preview ${PREVIEW_URL} resolved to PRODUCTION ` +
        `(${PROD_REF}). Refusing to run any tests against production.`
      );
    }
    await page.waitForTimeout(1500);
    if (prodHits.length) {
      throw new Error(`[staging-gate] ABORT: ${prodHits.length} request(s) hit PROD: ${prodHits[0]}`);
    }

    console.log(`[staging-gate] OK — ${PREVIEW_URL} resolves to STAGING (${STAGING_REF}), __staging=${cfg.staging}.`);
  } finally {
    await browser.close();
  }

  // Delegate per-role storageState generation to the existing e2e global-setup so
  // authed specs work unchanged against the preview baseURL.
  const { default: e2eGlobalSetup } = await import('../e2e/global-setup.mjs');
  if (typeof e2eGlobalSetup === 'function') {
    await e2eGlobalSetup();
  }
}
