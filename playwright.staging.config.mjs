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
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
  ],
  // No webServer — we drive a remote preview deploy, not a local static server.
});
