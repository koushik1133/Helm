#!/usr/bin/env node
/* ============================================================================
 * pricing-differential.test.mjs — Wave 15B, W15-001 canonical-contract gate.
 *
 * Credential-free. Proves TWO things needed before any server pricing fix:
 *   1. The canonical server reference engine (defined here, the exact math the
 *      proposed SQL will mirror — see supabase/wave15b/) reproduces the ACTUAL
 *      shipping UI engine (`_canon`/`quoteTotal`, extracted live from
 *      public/store-api.js) to the integer rupee across 100+ generated cases.
 *      => a server that recomputes the total from CANONICAL RAW INPUTS will not
 *         change any legitimate total. (Phase 4 differential.)
 *   2. The reference engine derives the total from RAW INPUTS only (never the
 *      client-supplied `total`/`computed`). A tampered top-level `total` with a
 *      bogus `computed.subtotal` is ignored and the correct total is recomputed.
 *      (Phase 2/6 design proof — server does not trust the client final total.)
 *
 * This test does NOT modify pricing logic and does NOT touch any DB. It locks the
 * contract so the SQL fix (SOURCE PREPARED, staging-only) can be verified against
 * it. Runtime A/B on STAGING remains BLOCKED — LOCAL E2E CREDENTIALS REQUIRED.
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
// Build a live object mirroring the shipping `pricing` object's two methods.
const ui = {};
ui._canon = new Function('a', 'return (' + '(a)=>' + canonBody.replace(/^\{/, '{') + ')(a)');
ui.quoteTotal = new Function('p', `const self=this; return ((p)=>{const this_=self;` +
  quoteTotalBody
    .replace(/^\{/, '')
    .replace(/\}$/, '')
    .replace(/this\._canon/g, 'this_._canon') + `})(p)`).bind({ _canon: (a) => ui._canon(a) });

// Quick sanity: the extracted UI engine computes a known case.
t('extracted shipping _canon computes the locked example (5000 preSvc, 18% GST)', () => {
  const c = ui._canon({ preSvc: 5000, svcPct: 0, discountFixed: 0, discountPct: 0, coupon: null, gstPct: 18 });
  assert.equal(c.total, 5900); // 5000 * 1.18
});

// --- Canonical SERVER reference engine (the math the SQL will mirror) ---------
// Derives the total from RAW INPUTS ONLY. Mirrors _canon exactly (D1/D4/D5/D7).
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

// --- Generate 100+ representative cases across the input space ----------------
function* cases() {
  const chairsSet = [0, 1, 50, 300, 1234];
  const cp = [0, 250.5, 1000];
  const guests = [0, 120, 999];
  const plate = [0, 899.99, 2500];
  const other = [0, 15000];
  const svc = [0, 5, 10];
  const disc = [0, 5000];
  const discPct = [0, 12.5, 100];
  const coupons = [null, { kind: 'flat', value: 3000 }, { kind: 'percent', value: 15 }];
  const gst = [0, 5, 18];
  const cater = [{ mode: 'inhouse', amount: 0 }, { mode: 'inhouse', amount: 40000 }, { mode: 'client', amount: 99999 }];
  let n = 0;
  for (const c of chairsSet) for (const g of guests) for (const co of coupons)
  for (const gp of gst) for (const s of svc) {
    // vary the remaining dims deterministically to keep breadth without exploding
    const p = {
      chairs: c, chairPrice: cp[n % cp.length], guests: g, platePrice: plate[n % plate.length],
      other: other[n % other.length], serviceChargePct: s,
      discount: disc[n % disc.length], discountPct: discPct[n % discPct.length],
      coupon: co, gstPct: gp, catering: cater[n % cater.length],
    };
    n++; yield p;
  }
}

// --- 1. DIFFERENTIAL: server reference ≡ shipping UI engine, to the rupee -----
t('server-canonical reference reproduces the shipping UI total to the rupee (100+ cases)', () => {
  let count = 0, mism = [];
  for (const p of cases()) {
    count++;
    const uiTotal = ui.quoteTotal(p).total;
    const srvTotal = serverCanonTotal(p);
    if (uiTotal !== srvTotal) mism.push({ p, uiTotal, srvTotal });
  }
  assert.ok(count >= 100, `expected >=100 cases, got ${count}`);
  assert.equal(mism.length, 0,
    'server/UI mismatch (STOP pricing deployment): ' + JSON.stringify(mism.slice(0, 3)));
  console.log(`    (${count} cases, 0 mismatches)`);
});

// --- 2. TAMPER: reference ignores client total/computed, recomputes from raw --
t('server reference ignores tampered top-level total + bogus computed.subtotal', () => {
  const raw = { chairs: 100, chairPrice: 1000, guests: 100, platePrice: 500, gstPct: 18,
    discount: 0, discountPct: 0, coupon: null, catering: { mode: 'inhouse', amount: 0 } };
  const honest = serverCanonTotal(raw);              // truth from raw inputs
  const tampered = { ...raw, computed: { subtotal: 5, total: 1 }, total: 1 };
  assert.equal(serverCanonTotal(tampered), honest,
    'server total must come from raw inputs, not the client total/computed');
  assert.notEqual(honest, 1);                        // tamper would have set 1
});



// --- 3. The SOURCE-PREPARED migration mirrors the canonical contract ----------
t('W15B UPGRADE migration recomputes from raw inputs (canonical D1/D4/D5/D7)', () => {
  const up = read('supabase/wave15b/W15B-01-PRICING-UPGRADE.sql');
  for (const key of ['chairPrice', 'platePrice', 'serviceChargePct', 'discountPct', 'coupon', 'catering', 'gstPct']) {
    assert.ok(up.includes(key), `UPGRADE must read raw input ${key}`);
  }
  assert.match(up, /least\(greatest\(0,\s*discount\),\s*subtotal\)/, 'D4 discount cap missing');
  assert.match(up, /round\(taxed \+ gst\)/, 'D7 final-only rounding missing');
  // never sources a value from the client `computed` object (accessor, not comment)
  assert.ok(!/->\s*'computed'|->>\s*'computed'/.test(up), 'UPGRADE must not read from client `computed`');
});
