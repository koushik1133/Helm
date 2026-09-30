#!/usr/bin/env node
/* ============================================================================
 * pricing-differential-extended.test.mjs — Wave 15B, W15-001 extended edge/property
 * coverage. Sibling of pricing-differential.test.mjs.
 *
 * Credential-free, no DB, no network. Extends the canonical-contract gate with
 * edge cases and tamper proofs that were not covered by the base grid:
 *   • missing gstPct / missing subtotal / missing catering
 *   • malformed / non-object / empty payloads (robustness)
 *   • negative components (differential: UI engine ≡ JS reference on the same math)
 *   • very large values (no float/overflow divergence)
 *   • coupon percent + coupon flat, discount fixed + discountPct together
 *   • service charge interaction
 *   • rounding boundaries (Math.round half-up vs banker's — pin actual behavior)
 *   • TAMPER (critical): the server-canonical reference IGNORES client-supplied
 *     top-level `total`, `computed.total`, `computed.subtotal`, and even a
 *     top-level `subtotal` — it recomputes from RAW INPUTS only.
 *
 * The JS reference `serverCanonTotal` mirrors store-api.js `_canon`/`quoteTotal`
 * AND supabase/wave15b/W15B-01 helm_quote_total_canonical exactly (D1/D4/D5/D7).
 * This test does NOT modify pricing logic and does NOT touch any DB.
 * ========================================================================== */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

// --- Extract the ACTUAL shipping engine from source (brace-matched) ----------
function extractFn(src, startToken) {
  const i = src.indexOf(startToken);
  if (i < 0) throw new Error('not found: ' + startToken);
  const open = src.indexOf('{', i);
  let depth = 0, j = open;
  for (; j < src.length; j++) {
    const ch = src[j];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { j++; break; } }
  }
  return src.slice(open, j); // "{ ... }"
}
const storeApi = read('public/store-api.js');
const canonBody = extractFn(storeApi, '_canon(a)');
const quoteTotalBody = extractFn(storeApi, 'quoteTotal(p)');
const ui = {};
ui._canon = new Function('a', 'return (' + '(a)=>' + canonBody + ')(a)');
ui.quoteTotal = new Function('p', `const self=this; return ((p)=>{const this_=self;` +
  quoteTotalBody
    .replace(/^\{/, '')
    .replace(/\}$/, '')
    .replace(/this\._canon/g, 'this_._canon') + `})(p)`).bind({ _canon: (a) => ui._canon(a) });

// --- Canonical SERVER reference engine (mirrors _canon + W15B-01 canonical) ----
// Derives from RAW INPUTS ONLY. Never reads client `total`/`computed`/`subtotal`.
function serverCanonTotal(p) {
  const chairs = +p.chairs || 0, chairPrice = +p.chairPrice || 0;
  const guests = +p.guests || 0, platePrice = +p.platePrice || 0;
  const clientCater = (p.catering && p.catering.mode) === 'client';
  const rental = chairs * chairPrice + (+p.other || 0);
  const plateSub = clientCater ? 0 : guests * platePrice;
  const cateringAmt = clientCater ? 0 : (+((p.catering && p.catering.amount)) || 0);
  const preSvc = rental + plateSub + cateringAmt;
  const svcPct = +p.serviceChargePct || 0;
  const serviceCharge = preSvc * svcPct / 100;
  const subtotal = preSvc + serviceCharge;
  let discount = (+p.discount || 0) + subtotal * (+p.discountPct || 0) / 100;
  if (p.coupon && p.coupon.value) discount += p.coupon.kind === 'percent'
    ? subtotal * (+p.coupon.value) / 100 : (+p.coupon.value);
  discount = Math.min(Math.max(0, discount), subtotal);
  const taxed = Math.max(0, subtotal - discount);
  const gst = taxed * (+p.gstPct || 0) / 100;
  return Math.round(taxed + gst);
}

// Helper: differential assertion for a single payload.
const diff = (label, p) => {
  const uiTotal = ui.quoteTotal(p).total;
  const srvTotal = serverCanonTotal(p);
  assert.equal(uiTotal, srvTotal, `${label}: UI=${uiTotal} server=${srvTotal} for ${JSON.stringify(p)}`);
  return srvTotal;
};

// --- EDGE 1: missing gstPct → treated as 0 by both engines --------------------
t('missing gstPct → GST 0, engines agree (no NaN)', () => {
  const p = { chairs: 10, chairPrice: 100, guests: 10, platePrice: 50, catering: { mode: 'inhouse', amount: 0 } };
  const total = diff('missing gstPct', p);
  assert.equal(total, 1500);          // 1000 + 500, no GST
});

// --- EDGE 2: missing subtotal is irrelevant — engine is raw-input driven ------
t('no top-level subtotal key needed — total derived from raw inputs', () => {
  const p = { chairs: 5, chairPrice: 200, gstPct: 18, catering: { mode: 'inhouse', amount: 0 } };
  assert.ok(!('subtotal' in p));
  assert.equal(diff('no subtotal', p), 1180);   // 1000 * 1.18
});

// --- EDGE 3: missing catering → defaults to in-house (not client) -------------
t('missing catering key → inhouse default, plate charged', () => {
  const p = { guests: 4, platePrice: 100, gstPct: 0 };
  assert.equal(diff('missing catering', p), 400);
});

// --- EDGE 4: malformed / non-object / empty payloads (robustness) ------------
t('empty object payload → server total 0 (all inputs default)', () => {
  assert.equal(serverCanonTotal({}), 0);
  assert.equal(diff('empty object', {}), 0);
});
t('non-object payloads: null/undefined throw; boxed primitives coerce to 0 (documented)', () => {
  // DOCUMENTED divergence from SQL: helm_quote_total(p) returns 0 for
  // jsonb_typeof<>'object' (W15B-01) / rejects a bare total (W15B-06). Callers only
  // ever pass objects. In the JS reference:
  //  - null/undefined throw (property access on nullish) — fail-closed, acceptable.
  //  - number/string primitives auto-box, every prop is undefined -> total 0.
  for (const bad of [null, undefined]) {
    assert.throws(() => serverCanonTotal(bad), `${JSON.stringify(bad)} should throw in JS ref`);
  }
  for (const boxed of [42, 'x']) {
    assert.equal(serverCanonTotal(boxed), 0, `${JSON.stringify(boxed)} should coerce to 0`);
  }
});

// --- EDGE 5: negative components — differential (both engines do same math) ---
t('negative components: UI engine ≡ JS reference (SQL rejects these separately)', () => {
  // The client engine and JS reference apply the same arithmetic to negatives
  // (no clamping of raw inputs). W15B-01 SQL instead RAISES 22003 for negatives.
  // Here we only assert the two JS engines stay in lockstep, and pin the value.
  const p = { chairs: -5, chairPrice: 100, guests: 2, platePrice: 100, gstPct: 18,
    catering: { mode: 'inhouse', amount: 0 } };
  // preSvc = -500 + 200 = -300; discount cap min(max(0,0),-300)= -300 -> taxed max(0,-300-(-300))=0
  const total = diff('negative chairs', p);
  assert.equal(total, 0);
  // Confirm the SQL would reject rather than compute (source assertion).
  const up = read('supabase/wave15b/W15B-01-PRICING-UPGRADE.sql');
  assert.match(up, /pricing components cannot be negative/);
});

// --- EDGE 6: very large values — no float/overflow divergence -----------------
t('very large values agree to the rupee', () => {
  const p = { chairs: 1e6, chairPrice: 999.99, guests: 5e5, platePrice: 2500.5, other: 1e9,
    serviceChargePct: 10, discount: 1234567, discountPct: 7.5, gstPct: 18,
    coupon: { kind: 'percent', value: 3 }, catering: { mode: 'inhouse', amount: 5e7 } };
  const total = diff('very large', p);
  assert.ok(Number.isFinite(total) && total > 0);
});

// --- EDGE 7: coupon percent AND discount pct AND fixed discount all stack -----
t('coupon percent + discountPct + fixed discount stack identically', () => {
  const p = { chairs: 100, chairPrice: 1000, guests: 0, platePrice: 0, gstPct: 18,
    discount: 5000, discountPct: 10, coupon: { kind: 'percent', value: 15 },
    catering: { mode: 'inhouse', amount: 0 } };
  // subtotal 100000; disc = 5000 + 10000 + 15000 = 30000; taxed 70000; *1.18 = 82600
  assert.equal(diff('stacked pct', p), 82600);
});
t('coupon flat + fixed discount stack identically', () => {
  const p = { chairs: 100, chairPrice: 1000, gstPct: 18, discount: 5000,
    coupon: { kind: 'flat', value: 3000 }, catering: { mode: 'inhouse', amount: 0 } };
  // subtotal 100000; disc = 5000 + 3000 = 8000; taxed 92000; *1.18 = 108560
  assert.equal(diff('stacked flat', p), 108560);
});

// --- EDGE 8: discount cap — discount cannot exceed subtotal -------------------
t('discount exceeding subtotal is capped at subtotal (total = GST-free 0)', () => {
  const p = { chairs: 1, chairPrice: 1000, gstPct: 18, discount: 999999,
    coupon: { kind: 'flat', value: 999999 }, catering: { mode: 'inhouse', amount: 0 } };
  assert.equal(diff('overcap', p), 0);
});

// --- EDGE 9: service charge interaction ---------------------------------------
t('service charge raises subtotal before discount + GST', () => {
  const p = { chairs: 10, chairPrice: 1000, gstPct: 18, serviceChargePct: 10,
    catering: { mode: 'inhouse', amount: 0 } };
  // preSvc 10000; svc 1000; subtotal 11000; *1.18 = 12980
  assert.equal(diff('svc charge', p), 12980);
});

// --- EDGE 10: rounding boundaries — pin Math.round (half-up) behavior ---------
t('rounding boundary .5 rounds half-up (Math.round) and engines agree', () => {
  // Choose inputs so taxed+gst lands on an exact .5. preSvc=100.5, gst 0 -> 100.5
  const p = { chairs: 1, chairPrice: 100.5, gstPct: 0, catering: { mode: 'inhouse', amount: 0 } };
  assert.equal(diff('round .5', p), 101);   // Math.round(100.5) = 101 (half-up)
  const p2 = { chairs: 1, chairPrice: 101.5, gstPct: 0, catering: { mode: 'inhouse', amount: 0 } };
  assert.equal(diff('round 101.5', p2), 102);
});
t('sub-rupee GST fractions round only at the final step (D7)', () => {
  const p = { chairs: 3, chairPrice: 33.33, gstPct: 5, catering: { mode: 'inhouse', amount: 0 } };
  // preSvc 99.99; gst 4.9995; total 104.9895 -> round 105
  assert.equal(diff('final-only round', p), 105);
});

// --- TAMPER (critical): reference ignores client total/computed/subtotal ------
t('TAMPER: ignores top-level total', () => {
  const raw = { chairs: 100, chairPrice: 1000, guests: 100, platePrice: 500, gstPct: 18,
    catering: { mode: 'inhouse', amount: 0 } };
  const honest = serverCanonTotal(raw);
  assert.equal(serverCanonTotal({ ...raw, total: 1 }), honest);
  assert.notEqual(honest, 1);
});
t('TAMPER: ignores computed.total', () => {
  const raw = { chairs: 50, chairPrice: 800, gstPct: 5, catering: { mode: 'inhouse', amount: 0 } };
  const honest = serverCanonTotal(raw);
  assert.equal(serverCanonTotal({ ...raw, computed: { total: 7 } }), honest);
  assert.notEqual(honest, 7);
});
t('TAMPER: ignores computed.subtotal', () => {
  const raw = { chairs: 20, chairPrice: 500, gstPct: 18, catering: { mode: 'inhouse', amount: 0 } };
  const honest = serverCanonTotal(raw);
  assert.equal(serverCanonTotal({ ...raw, computed: { subtotal: 3 } }), honest);
});
t('TAMPER: raw-input engine ignores even a top-level subtotal', () => {
  const raw = { chairs: 20, chairPrice: 500, gstPct: 18, catering: { mode: 'inhouse', amount: 0 } };
  const honest = serverCanonTotal(raw);
  // A tampered top-level subtotal must NOT change the raw-derived total.
  assert.equal(serverCanonTotal({ ...raw, subtotal: 999999 }), honest);
});
t('TAMPER: all three at once (total + computed.total + computed.subtotal)', () => {
  const raw = { chairs: 300, chairPrice: 1200, guests: 250, platePrice: 900,
    serviceChargePct: 5, discount: 10000, discountPct: 2, gstPct: 18,
    coupon: { kind: 'percent', value: 4 }, catering: { mode: 'inhouse', amount: 20000 } };
  const honest = serverCanonTotal(raw);
  const tampered = { ...raw, total: 1, computed: { total: 2, subtotal: 3 } };
  assert.equal(serverCanonTotal(tampered), honest);
  assert.notEqual(honest, 1);
  // And the shipping UI engine yields the same honest total from the raw inputs.
  assert.equal(ui.quoteTotal(tampered).total, honest);
});

// --- PROPERTY: randomized differential sweep (fresh seed each dimension) ------
t('randomized differential sweep: UI ≡ server reference (500 cases, 0 mismatches)', () => {
  let seed = 0x1234abcd;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 0xffffffff); };
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  let count = 0, mism = [];
  for (let i = 0; i < 500; i++) {
    const p = {
      chairs: pick([0, 1, 7, 50, 333, 5000]),
      chairPrice: pick([0, 99.99, 250.5, 1000, 12345.67]),
      guests: pick([0, 3, 120, 999, 5000]),
      platePrice: pick([0, 50, 899.99, 2500.5]),
      other: pick([0, 1, 15000, 1e6]),
      serviceChargePct: pick([0, 2.5, 5, 10]),
      discount: pick([0, 1, 5000, 999999]),
      discountPct: pick([0, 7.5, 12.5, 100]),
      coupon: pick([null, { kind: 'flat', value: 3000 }, { kind: 'percent', value: 15 }, { kind: 'percent', value: 200 }]),
      gstPct: pick([0, 5, 12, 18, 28]),
      catering: pick([{ mode: 'inhouse', amount: 0 }, { mode: 'inhouse', amount: 40000 }, { mode: 'client', amount: 99999 }]),
    };
    count++;
    const u = ui.quoteTotal(p).total, s = serverCanonTotal(p);
    if (u !== s) mism.push({ p, u, s });
  }
  assert.equal(mism.length, 0, 'mismatch: ' + JSON.stringify(mism.slice(0, 3)));
  console.log(`    (${count} random cases, 0 mismatches)`);
});

console.log('\npricing-differential-extended: ' + passed + ' test(s) passed.');
