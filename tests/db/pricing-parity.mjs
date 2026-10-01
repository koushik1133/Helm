#!/usr/bin/env node
/* ============================================================================
 * pricing-parity.mjs — W15-001 legitimate-pricing parity gate (DB vs UI).
 *
 * Proves the DB pricing AUTHORITY (public.helm_quote_total_canonical, the function
 * installed by supabase/migrations/0001_pricing_authority.sql) produces the SAME
 * integer-rupee total as the ACTUAL shipping UI engine (BPStore.pricing.quoteTotal
 * / _canon, extracted live from public/store-api.js) for the SAME raw inputs —
 * across GST, service charge, fixed + percent discounts, coupons (fixed/percent),
 * the discount cap, rounding, client-vs-inhouse catering and object costs.
 *
 * This is the guarantee that the server fix changes NO legitimate total (it only
 * stops trusting a tampered client total). It runs the REAL DB function via psql,
 * not a reimplementation. Self-skips if no local PG is configured.
 *
 * DB connection: standard PG* env (PGHOST/PGPORT/PGDATABASE/PGUSER) must point at
 * a disposable test DB that has migration 0001 applied.
 * ========================================================================== */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// --- self-skip without a DB --------------------------------------------------
function dbAvailable() {
  try { execFileSync('psql', ['-tAc', 'select 1'], { stdio: ['ignore', 'ignore', 'ignore'] }); return true; }
  catch { return false; }
}
if (!dbAvailable()) {
  console.log('pricing-parity: SKIP (no local PG reachable via PG* env) — run against the disposable PG17 test DB.');
  process.exit(0);
}

// --- extract the ACTUAL shipping UI engine from source (brace-matched) --------
function extractFn(src, startToken) {
  const i = src.indexOf(startToken); if (i < 0) throw new Error('not found: ' + startToken);
  const open = src.indexOf('{', i); let depth = 0, j = open;
  for (; j < src.length; j++) { const c = src[j]; if (c === '{') depth++; else if (c === '}') { depth--; if (depth === 0) { j++; break; } } }
  return src.slice(open, j);
}
const storeApi = read('public/store-api.js');
const canonBody = extractFn(storeApi, '_canon(a)');
const quoteTotalBody = extractFn(storeApi, 'quoteTotal(p)');
const ui = {};
ui._canon = new Function('a', 'return (' + '(a)=>' + canonBody + ')(a)');
ui.quoteTotal = new Function('p', `const self=this; return ((p)=>{const this_=self;` +
  quoteTotalBody.replace(/^\{/, '').replace(/\}$/, '').replace(/this\._canon/g, 'this_._canon') + `})(p)`)
  .bind({ _canon: (a) => ui._canon(a) });

// --- cases: cover every pricing feature --------------------------------------
const CASES = [
  { name: 'subtotal-equiv ₹236,000 (chairs reconstruct 200000 preSvc)',
    p: { chairs: 0, chairPrice: 0, guests: 0, platePrice: 0, other: 200000, gstPct: 18 } },
  { name: 'chairs+plates (the ₹247,800 case)',
    p: { chairs: 100, chairPrice: 500, guests: 200, platePrice: 800, other: 0, gstPct: 18 } },
  { name: 'service charge 10%',
    p: { chairs: 50, chairPrice: 400, guests: 100, platePrice: 600, serviceChargePct: 10, gstPct: 18 } },
  { name: 'fixed discount',
    p: { other: 100000, discount: 15000, gstPct: 18 } },
  { name: 'percent discount',
    p: { other: 100000, discountPct: 12.5, gstPct: 18 } },
  { name: 'coupon fixed',
    p: { other: 100000, coupon: { kind: 'fixed', value: 5000 }, gstPct: 18 } },
  { name: 'coupon percent',
    p: { other: 100000, coupon: { kind: 'percent', value: 7 }, gstPct: 18 } },
  { name: 'discount cap (discount > subtotal)',
    p: { other: 10000, discount: 99999, gstPct: 18 } },
  { name: 'rounding (odd)',
    p: { chairs: 7, chairPrice: 333, guests: 13, platePrice: 777, gstPct: 18 } },
  { name: 'client catering excluded',
    p: { chairs: 50, chairPrice: 400, guests: 200, platePrice: 800, catering: { mode: 'client', amount: 999999 }, gstPct: 18 } },
  { name: 'inhouse catering amount',
    p: { chairs: 50, chairPrice: 400, catering: { mode: 'inhouse', amount: 60000 }, gstPct: 18 } },
  { name: 'zero GST',
    p: { other: 100000, gstPct: 0 } },
  { name: 'everything stacked',
    p: { chairs: 80, chairPrice: 450, guests: 150, platePrice: 900, other: 20000, serviceChargePct: 8,
         discount: 10000, discountPct: 5, coupon: { kind: 'percent', value: 3 }, gstPct: 18 } },
];

// --- DB totals in one round-trip ---------------------------------------------
const jarg = JSON.stringify(CASES.map((c) => c.p));
const sql = `select (ord-1), public.helm_quote_total_canonical(e)::int `
  + `from jsonb_array_elements($json$${jarg}$json$::jsonb) with ordinality as t(e, ord) order by ord;`;
const out = execFileSync('psql', ['-X', '-q', '-t', '-A', '-F', '|', '-c', sql], { encoding: 'utf8' });
const dbTotals = {};
for (const line of out.trim().split('\n')) { const [i, v] = line.split('|'); dbTotals[+i] = +v; }

// --- compare -----------------------------------------------------------------
let passed = 0, failed = 0;
CASES.forEach((c, i) => {
  const uiTotal = Math.round(ui.quoteTotal(c.p).total);
  const dbTotal = dbTotals[i];
  try {
    assert.equal(dbTotal, uiTotal, `${c.name}: DB=${dbTotal} UI=${uiTotal}`);
    console.log(`  ✓ ${c.name} — UI=DB=₹${uiTotal}`);
    passed++;
  } catch (e) { console.error(`  ✗ ${e.message}`); failed++; }
});
console.log('');
console.log(`pricing-parity: ${passed} parity case(s) passed, ${failed} failed.`);
if (failed) process.exit(1);
