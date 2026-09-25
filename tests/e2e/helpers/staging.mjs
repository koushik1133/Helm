// Staging injection + isolation gate.
// The committed public/config.js ships an EMPTY staging block, so localhost fails closed by default.
// Here we inject window.HELM_STAGING_SUPABASE (public url+anon, from env) BEFORE config.js runs, so the
// app's router selects STAGING. We also guard: any request to the PRODUCTION Supabase project fails the test.
import { expect } from '@playwright/test';
import { STAGING_URL, STAGING_ANON } from './env.mjs';

const PROD_REF = 'nqltzgiwznphugcfhmbm';   // production Supabase project ref — must NEVER be contacted here
const STAGING_REF = 'xizehqgeyjcfpzrdymly';

// Call once per page/context creation, before navigation.
export async function useStaging(page) {
  // 1) inject staging creds so config.js resolveStaging() picks them (runs before page scripts)
  await page.addInitScript(([url, anon]) => {
    window.HELM_STAGING_SUPABASE = { url, anonKey: anon };
  }, [STAGING_URL, STAGING_ANON]);

  // 2) network guard: OBSERVE every request and record any that targets the production project.
  //    (Observe-only, no interception — interception adds latency to every asset and causes flakes.)
  page.__prodHits = [];
  page.on('request', (req) => { if (req.url().includes(PROD_REF)) page.__prodHits.push(req.url()); });
}

// Run at the start of any staging suite AFTER a page has loaded the app.
export async function assertStagingOnly(page) {
  const cfg = await page.evaluate(() => ({
    url: window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url,
    staging: !!(window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.__staging),
  }));
  expect(cfg.url, 'app must select STAGING Supabase').toContain(STAGING_REF);
  expect(cfg.url, 'app must NOT select production Supabase').not.toContain(PROD_REF);
  expect(cfg.staging, 'router must flag __staging').toBe(true);
  expect(page.__prodHits, 'zero requests to production Supabase').toEqual([]);
}
