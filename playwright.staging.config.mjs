// =============================================================================
// playwright.staging.config.mjs
//
// Playwright config for driving a STAGING-WIRED Vercel branch-preview URL.
// Unlike playwright.config.mjs (localhost -> staging via injected creds), this
// config targets a REMOTE preview host via PREVIEW_URL and makes a HARD
// ASSERTION in globalSetup that the frontend's resolved Supabase ref is the
// STAGING ref (xizehqgeyjcfpzrdymly). If that assertion fails, the entire run
// aborts before a single test executes — so tests can NEVER run against a
// preview that is misrouted to production.
//
// Run (NOT executed here — prepared only):
//   PREVIEW_URL=https://<preview-alias>.vercel.app \
//   npx playwright test --config playwright.staging.config.mjs
//
// Requires the same HELM_E2E_* env as playwright.config.mjs for authed flows
// (see tests/e2e/helpers/env.mjs). No webServer: the target is remote.
// =============================================================================
import { defineConfig, devices } from '@playwright/test';

const PREVIEW_URL = process.env.PREVIEW_URL || '';

export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/staging/global-setup.staging.mjs', // HARD staging-ref gate (aborts all tests otherwise)
  fullyParallel: false,       // shared staging DB — keep ordering predictable
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,                 // a flaky pass must not hide a real failure (Wave 13 rule)
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-staging' }]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: PREVIEW_URL,     // REMOTE staging-wired preview host
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    // Mapped e2e flows (tests/e2e/**). Per-role storageState is applied inside each
    // spec via helpers/session.mjs authedPage(browser, '<role>'), which loads the
    // tests/e2e/.auth/<role>.json files the staging globalSetup signs in and writes
    // (seeded HARDEN_TEST_ accounts, origin = PREVIEW_URL). This is the per-role
    // storageState mechanism this suite uses — there is no single shared session.
    { name: 'e2e-chromium', testDir: './tests/e2e', use: { ...devices['Desktop Chrome'] } },
    { name: 'e2e-firefox',  testDir: './tests/e2e', use: { ...devices['Desktop Firefox'] } },
    { name: 'e2e-webkit',   testDir: './tests/e2e', use: { ...devices['Desktop Safari'] } },
    // TODO-stub flows (tests/staging/specs/**) — all test.fixme, reported as pending,
    // never silently passing. Single-browser is enough for unimplemented stubs.
    { name: 'staging-stubs', testDir: './tests/staging/specs', use: { ...devices['Desktop Chrome'] } },
  ],
  // No webServer — we drive a remote preview deploy, not a local static server.
});
