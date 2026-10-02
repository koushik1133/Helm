// =============================================================================
// tests/staging/specs/17
// STUB — required staging flow #17: Tasks — create/assign/complete CRUD
//
// STATUS: TODO (not yet authored). This spec is intentionally SKIPPED via
// test.fixme so it appears in the report as PENDING — it never silently passes.
//
// REASON: coverage/control.spec.mjs touches tasks partially. Author a dedicated task CRUD spec once selectors are confirmed.
//
// Run with the staging config only (hard-gates the STAGING ref first):
//   PREVIEW_URL=... npx playwright test -c playwright.staging.config.mjs
// =============================================================================
import { test } from '@playwright/test';

test.describe('Flow #17 — Tasks — create/assign/complete CRUD (STUB)', () => {
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
