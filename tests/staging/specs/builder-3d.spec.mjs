// =============================================================================
// tests/staging/specs/9
// STUB — required staging flow #9: Builder 3D view renders and round-trips layout
//
// STATUS: TODO (not yet authored). This spec is intentionally SKIPPED via
// test.fixme so it appears in the report as PENDING — it never silently passes.
//
// REASON: No 3D builder spec exists. Author once the 3D canvas selectors/readiness signal are confirmed on the preview.
//
// Run with the staging config only (hard-gates the STAGING ref first):
//   PREVIEW_URL=... npx playwright test -c playwright.staging.config.mjs
// =============================================================================
import { test } from '@playwright/test';

test.describe('Flow #9 — Builder 3D view renders and round-trips layout (STUB)', () => {
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
