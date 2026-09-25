// Helm E2E — Playwright config. STAGING-ONLY via env-injected config (see helpers/staging.mjs).
// Mutation tests run against localhost -> STAGING. Never point mutation tests at prod.
import { defineConfig, devices } from '@playwright/test';

const PORT = process.env.HELM_E2E_PORT || '4173';
const baseURL = process.env.HELM_E2E_BASE_URL || `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,            // shared local server + shared staging DB; keep ordering predictable
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,                      // no retries: a flaky pass must not hide a real failure (Wave 13 rule)
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
  ],
  // Reuse the already-running local static server if present; otherwise start it.
  webServer: {
    command: 'node server.js',
    port: Number(PORT),
    reuseExistingServer: true,
    timeout: 20_000,
    env: { PORT },
  },
});
