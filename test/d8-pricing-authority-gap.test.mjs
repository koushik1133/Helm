#!/usr/bin/env node
/* ============================================================================
 * d8-pricing-authority-gap.test.mjs — Wave 15 finding W15-001 (characterization).
 *
 * READ-ONLY source test (no DB, no network). It PINS a real gap discovered in
 * Wave 15 so it cannot change silently and so a future "fix" is a conscious,
 * reviewed act (this is money-critical — see the zero-data-loss guardrail).
 *
 * FINDING W15-001 — D8 "server pricing authority" is INERT for the shipping UI
 * payload:
 *   • phase99 helm_quote_total() / enforce_pricing_total() / save_quotation_version()
 *     only RE-DERIVE the total when the pricing jsonb has a TOP-LEVEL `subtotal`
 *     key. Otherwise they return/keep the CLIENT-SUPPLIED `total` verbatim.
 *   • The real UI payload (quotes.html gatherPricing + flow.html saveQuotation)
 *     emits `total` at the top level but places `subtotal` only NESTED under
 *     `computed`. So the guard is false and the client total is trusted as-is.
 *   • Therefore a can_edit() staff member (incl. sales/operations) can persist an
 *     arbitrary quote total that bypasses the server formula. No anon path.
 *
 * WHY THIS IS NOT A DROP-IN FIX (product decision): helm_quote_total is a
 * SIMPLIFIED model (subtotal − discount, then ×(1+gstPct/100)). It ignores
 * discountPct, coupon, serviceChargePct, catering and IGST/place-of-supply that
 * the client engine (_canon in store-api.js) actually applies. Naively enabling
 * recompute on computed.subtotal would MIS-PRICE legitimate quotes. Faithful
 * server authority requires porting the full pricing engine server-side — a
 * money-critical decision requiring the pricing owner's sign-off. Until then this
 * test pins the boundary. When the decision lands, replace these characterization
 * assertions with the enforced behavior and verify against an approved staging DB.
 * ========================================================================== */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

const phase99 = read('supabase/phase99-server-pricing-authority.sql');
const quotesHtml = read('public/quotes.html');
const flowHtml = read('public/flow.html');

// 1. The server recompute is guarded on a TOP-LEVEL `subtotal` key.
t('helm_quote_total returns client total when top-level subtotal is absent (guard pinned)', () => {
  assert.match(phase99, /not\s*\(\s*p\s*\?\s*'subtotal'\s*\)[\s\S]*?return\s+coalesce\(\(p->>'total'\)::numeric/i,
    'helm_quote_total no longer falls through to the client total — D8 boundary CHANGED; re-review W15-001 and update this test');
});
t('enforce_pricing_total trigger only recomputes when top-level subtotal is present', () => {
  assert.match(phase99, /new\.pricing\s*\?\s*'subtotal'\s*\)\s*then\s*[\s\S]*?jsonb_set\(new\.pricing,\s*'\{total\}'/i,
    'enforce_pricing_total guard CHANGED — re-review W15-001');
});
t('save_quotation_version only overwrites total when top-level subtotal is present', () => {
  assert.match(phase99, /p_pricing\s*\?\s*'subtotal'\s*\)\s*then\s*[\s\S]*?jsonb_set\(p_pricing,\s*'\{total\}'/i,
    'save_quotation_version guard CHANGED — re-review W15-001');
});

// 2. The shipping UI payload does NOT carry a top-level `subtotal`; subtotal lives
//    only under `computed`, and `total` is set from the client-side calc.
t('quotes.html gatherPricing emits no top-level subtotal (only computed carries it)', () => {
  const m = quotesHtml.match(/function gatherPricing\(\)\{[\s\S]*?\n\s{2}\}/);
  assert.ok(m, 'gatherPricing not found — selector drift, update this test');
  const body = m[0];
  assert.ok(!/\bsubtotal\b/.test(body),
    'gatherPricing now emits a top-level subtotal — D8 may now engage; re-review W15-001 and update this test');
});
t('quotes.html persists client total + nested computed (savePricing payload shape)', () => {
  assert.match(quotesHtml, /const\s+pricing\s*=\s*\{\s*\.\.\.p,\s*computed:\s*t,\s*total:\s*t\.total/,
    'savePricing payload shape CHANGED — re-review W15-001');
});
t('flow.html saveQuotation persists client total + nested computed (no top-level subtotal)', () => {
  assert.match(flowHtml, /pricing\s*=\s*Object\.assign\(\{\},\s*ev\.pricing\|\|\{\},\s*p,\s*\{\s*computed:\s*t,\s*total:\s*t\.total/,
    'saveQuotation payload shape CHANGED — re-review W15-001');
});

// 3. The server formula is NOT equivalent to the client engine (why a partial fix
//    would mis-price). Pin that the client engine applies factors the server omits.
t('client engine applies coupon/serviceCharge/catering that helm_quote_total omits', () => {
  const storeApi = read('public/store-api.js');
  const clientHasRichModel = /coupon/i.test(storeApi) && /(serviceCharge|catering)/i.test(storeApi);
  assert.ok(clientHasRichModel, 'client pricing engine model not found — update this test');
  assert.ok(!/coupon/i.test(phase99) && !/serviceCharge/i.test(phase99),
    'helm_quote_total now models coupon/serviceCharge — server may now be authoritative; re-review W15-001');
});

console.log('\nd8-pricing-authority-gap: ' + passed + ' assertion(s) passed.');
