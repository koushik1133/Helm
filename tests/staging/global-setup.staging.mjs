// =============================================================================
// tests/staging/global-setup.staging.mjs
//
// HARD staging gate + per-role storageState builder for
// playwright.staging.config.mjs. Runs ONCE before any test.
//
//   (a) Reads PREVIEW_URL (the staging-wired Vercel branch-preview alias).
//   (b) Opens the preview in a real browser, reads the frontend's resolved
//       window.SUPABASE_CONFIG.url, and ABORTS THE ENTIRE RUN (throws) unless it
//       resolves to the STAGING ref AND never to the PROD ref. It also observes
//       the first ~1.5s of network traffic and aborts if anything hits PROD.
//       This guarantees Playwright can never drive write flows against a preview
//       that is (mis)wired to production.
//   (c) Signs in the per-role seeded HARDEN_TEST_ users against the STAGING
//       Supabase GoTrue password endpoint and writes one storageState file per
//       role to tests/e2e/.auth/<role>.json, so authed specs (via
//       helpers/session.mjs authedPage) reuse a session instead of a slow UI
//       login. The emails match scripts/staging/seed-test-data.mjs EXACTLY:
//         harden_test_<tag>_<role>@helm-staging.test   (tag 'a' = Org A)
//       and the password comes from SEED_TEST_PASSWORD. The storageState origin
//       is the PREVIEW_URL origin and the token key is sb-<STAGING_REF>-auth-token
//       (supabase-js v2), so the preview app rehydrates the session on load.
//
// Nothing here mutates staging DATA — it only reads config and signs in.
//
// Required env (see report / SPEC-CHECKLIST.md):
//   PREVIEW_URL                 staging-wired Vercel preview alias (baseURL)
//   SEED_TEST_PASSWORD          password the seeder set on the HARDEN_TEST_ users
//   SUPABASE_STAGING_URL        staging Supabase URL  (default https://<ref>.supabase.co)
//   SUPABASE_STAGING_ANON_KEY   staging anon key (public-by-design, RLS-protected)
// =============================================================================
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROD_REF = 'nqltzgiwznphugcfhmbm';     // must NEVER be the resolved target
const STAGING_REF = 'xizehqgeyjcfpzrdymly';  // the ONLY allowed target

// Must match scripts/staging/seed-test-data.mjs exactly.
const PREFIX = 'HARDEN_TEST_';
const EMAIL_DOMAIN = 'helm-staging.test';
const ORG_TAG = 'a'; // role specs read Org A (see tests/e2e/roles/roles.spec.mjs)
const SEEDED_ROLES = [
  'admin', 'manager', 'sales', 'coordinator',
  'operations', 'designer', 'quality', 'client',
];

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = join(HERE, '..', 'e2e', '.auth'); // authedPage() reads from tests/e2e/.auth/

// Email EXACTLY as the seeder generates it:
//   `${PREFIX.toLowerCase()}${org.tag}_${role}@${EMAIL_DOMAIN}`
const emailForSeeded = (role) => `${PREFIX.toLowerCase()}${ORG_TAG}_${role}@${EMAIL_DOMAIN}`;

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

    // --- HARD GATE: must resolve to STAGING, never PROD, before ANY test runs.
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

  // --- Per-role storageState from the seeded HARDEN_TEST_ accounts -----------
  // Supabase URL/anon for the password sign-in. Prefer the SUPABASE_STAGING_*
  // names the seeder uses; fall back to the HELM_E2E_* names for compatibility.
  const SUPA_URL = process.env.SUPABASE_STAGING_URL
    || process.env.HELM_E2E_STAGING_URL
    || `https://${STAGING_REF}.supabase.co`;
  const SUPA_ANON = process.env.SUPABASE_STAGING_ANON_KEY
    || process.env.HELM_E2E_STAGING_ANON
    || '';
  const PASSWORD = process.env.SEED_TEST_PASSWORD
    || process.env.HELM_E2E_PASSWORD
    || '';

  // Safety: never sign in against anything but the staging ref.
  if (SUPA_URL.includes(PROD_REF) || !SUPA_URL.includes(STAGING_REF)) {
    throw new Error(`[staging-gate] ABORT: Supabase sign-in URL must be the STAGING ref. Got: ${SUPA_URL}`);
  }
  if (!SUPA_ANON || !PASSWORD) {
    console.warn('[staging-gate] missing SUPABASE_STAGING_ANON_KEY and/or SEED_TEST_PASSWORD — '
      + 'skipping storageState generation (authed specs will be unable to sign in).');
    return;
  }

  const origin = new URL(PREVIEW_URL).origin;
  const tokenKey = `sb-${STAGING_REF}-auth-token`;
  mkdirSync(AUTH_DIR, { recursive: true });

  const ok = [];
  for (const role of SEEDED_ROLES) {
    const email = emailForSeeded(role);
    const res = await fetch(SUPA_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { apikey: SUPA_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const session = await res.json().catch(() => ({}));
    if (!session || !session.access_token) {
      console.warn(`[staging-gate] no token for role=${role} (${email}): ${res.status}`);
      continue;
    }
    const storageState = {
      cookies: [],
      origins: [{ origin, localStorage: [{ name: tokenKey, value: JSON.stringify(session) }] }],
    };
    writeFileSync(join(AUTH_DIR, `${role}.json`), JSON.stringify(storageState));
    ok.push(role);
  }
  console.log(`[staging-gate] wrote storageState (origin=${origin}) for roles: ${ok.join(', ') || '(none)'}`);
}
