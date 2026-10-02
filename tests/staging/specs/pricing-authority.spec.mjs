// =============================================================================
// tests/staging/specs/7
// STUB — required staging flow #7: Server-side pricing authority (D8) — client cannot override totals
//
// STATUS: TODO (not yet authored). This spec is intentionally SKIPPED via
// test.fixme so it appears in the report as PENDING — it never silently passes.
//
// REASON: coverage/budget.spec.mjs covers pricing math but not the D8 server-authority assertion (tampered client total must be ignored/recomputed server-side).
//
// Run with the staging config only (hard-gates the STAGING ref first):
//   PREVIEW_URL=... npx playwright test -c playwright.staging.config.mjs
// =============================================================================
import { test } from '@playwright/test';

test.describe('Flow #7 — Server-side pricing authority (D8) — client cannot override totals (STUB)', () => {
  // test.fixme marks this as expected-unimplemented: it is reported as pending
  // and is NOT executed, so it can never report a false green.
  test.fixme('TODO: author against the staging-wired preview', async ({ page }) => {
    // Intentionally unimplemented. See the REASON header above.
    // When authoring: use helpers/session.mjs authedPage(browser, '<role>') for a
    // seeded HARDEN_TEST_ session, and helpers/staging.mjs assertStagingOnly(page)
    // to re-assert the STAGING ref inside the test.
    void page;
  });
});
