// =============================================================================
// tests/staging/specs/22
// STUB — required staging flow #22: SAFE payment test — sim-pay / Razorpay TEST mode ONLY (never live settlement)
//
// STATUS: TODO (not yet authored). This spec is intentionally SKIPPED via
// test.fixme so it appears in the report as PENDING — it never silently passes.
//
// REASON: No payment spec exists. SAFETY: must use ONLY /sim-pay or Razorpay TEST keys/cards. Must assert liveChannels.pay === false and NEVER trigger a real settlement or a live Razorpay link.
//
// Run with the staging config only (hard-gates the STAGING ref first):
//   PREVIEW_URL=... npx playwright test -c playwright.staging.config.mjs
// =============================================================================
import { test } from '@playwright/test';

test.describe('Flow #22 — SAFE payment test — sim-pay / Razorpay TEST mode ONLY (never live settlement) (STUB)', () => {
  // test.fixme marks this as expected-unimplemented: it is reported as pending
  // and is NOT executed, so it can never report a false green.
  test.fixme('TODO: author against the staging-wired preview', async ({ page }) => {
    // SAFETY GUARD (author must keep): staging must never trigger live settlement.
    // Assert liveChannels.pay is false and use ONLY sim-pay / Razorpay TEST mode.

    // Intentionally unimplemented. See the REASON header above.
    // When authoring: use helpers/session.mjs authedPage(browser, '<role>') for a
    // seeded HARDEN_TEST_ session, and helpers/staging.mjs assertStagingOnly(page)
    // to re-assert the STAGING ref inside the test.
    void page;
  });
});
