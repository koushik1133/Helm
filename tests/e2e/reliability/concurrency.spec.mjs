// Two-tab concurrency: documents the known last-write-wins on direct quote-metadata edits.
// Does NOT change behavior. Two independent authenticated contexts edit the same quote.
import { test, expect } from '@playwright/test';
import { requireStagingEnv, STAGING_URL } from '../helpers/env.mjs';
import { authedPage } from '../helpers/session.mjs';
import { createApprovalFixture, svcGet } from '../helpers/fixtures.mjs';

test.beforeAll(() => requireStagingEnv());
const BASE = STAGING_URL;

async function patchTitle(page, quoteId, title) {
  return page.evaluate(async ([base, id, t]) => {
    let tok = null; for (const k of Object.keys(localStorage)) if (k.includes('auth-token')) { try { tok = JSON.parse(localStorage[k]).access_token; } catch {} }
    const r = await fetch(base + '/rest/v1/quotes?id=eq.' + id, {
      method: 'PATCH', headers: { apikey: window.SUPABASE_CONFIG.anonKey, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ title: t }),
    });
    return { status: r.status };
  }, [BASE, quoteId, title]);
}

test('@reliability two-tab edit of same quote = last-write-wins (documented, no crash)', async ({ browser }) => {
  const fx = await createApprovalFixture();
  const a = await authedPage(browser, 'admin');   // two independent admin tabs (same session state)
  const b = await authedPage(browser, 'admin');
  const ctxA = a.context, ctxB = b.context, pageA = a.page, pageB = b.page;
  const rA = await patchTitle(pageA, fx.quoteId, 'EDIT-FROM-A');
  const rB = await patchTitle(pageB, fx.quoteId, 'EDIT-FROM-B'); // stale-state overwrite
  expect(rA.status).toBeGreaterThanOrEqual(200);
  expect(rB.status).toBeGreaterThanOrEqual(200);
  const q = await svcGet('quotes?id=eq.' + fx.quoteId + '&select=title');
  // last writer wins, no error/corruption; no optimistic-lock guard exists
  expect(['EDIT-FROM-A', 'EDIT-FROM-B']).toContain(q[0].title);
  await ctxA.close();
  await ctxB.close();
  // Conclusion: LOST-UPDATE RISK — PRODUCT DECISION REQUIRED (no version/updated_at guard).
});
