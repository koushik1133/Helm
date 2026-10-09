#!/usr/bin/env node
/* item-spec-parity.mjs — 0086 parity gate: quotes with SPEC-priced items (stage by m², generator by
   kVA, DJ by power/setup, ...) give the SAME integer total in the shipping UI engine
   (BPStore.pricing.fromItems -> objectsCost -> pricing.other -> quoteTotal) and in the DB pricing
   authority (public.helm_quote_total, D8, 0001/0079) for the exact pricing object the builder writes.
   Also proves items WITHOUT a spec price exactly as before. Self-skips without a local PG. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
try { execFileSync('psql', ['-tAc', 'select 1'], { stdio: ['ignore', 'ignore', 'ignore'] }); }
catch { console.log('item-spec-parity: SKIP (no local PG reachable via PG* env)'); process.exit(0); }
const s = readFileSync(join(ROOT, 'public/store-api.js'), 'utf8');
const a = s.indexOf('const OBJECT_CAT_PRICE'), p0 = s.indexOf('const pricing = {', a);
let i = s.indexOf('{', p0), d = 0; for (; i < s.length; i++) { if (s[i] === '{') d++; else if (s[i] === '}' && --d === 0) break; }
const { pricing: P, ITEM_SPEC: S } = new Function(s.slice(a, i + 1) + '; return { pricing, ITEM_SPEC };')();

const st = (spec) => ({ type: 'stage', category: 'structure', properties: { spec } });
const CARD2 = Object.assign({}, S.DEFAULT_RATES, { stage: { base: 2500, perSqM: 520.5, stdHeightM: 0.6, heightPerSqMPerM: 175 } });
const CASES = [
  { name: 'stage 8x5 m only', items: [st({ lengthM: 8, widthM: 5 })], r: { gstPct: 18 } },
  { name: 'stage in ft + height + chairs + plates', items: [st({ lengthM: S.toM(30, 'ft'), widthM: S.toM(18, 'ft'), heightM: 1.1, unit: 'ft' })],
    q: { chairs: 150, chairPrice: 200, guests: 180, platePrice: 650 }, r: { gstPct: 18 } },
  { name: 'generator 125 kVA 2 days diesel + DJ 3-pin + LED', items: [
    { type: 'generator', category: 'logistics', properties: { spec: { kva: 125, days: 2, diesel: true } } },
    { type: 'dj', category: 'av', properties: { spec: { setup: 'speakers2', power: 'pin3', extraSpeakers: 1 } } },
    { type: 'led', category: 'av', properties: { spec: { pitch: 'p48_outdoor', widthM: 5.5, heightM: 3.25, days: 1 } } }], r: { gstPct: 18, serviceChargePct: 10 } },
  { name: 'every spec type + discount + coupon', items: [
    { type: 'lighting', properties: { spec: { kind: 'fairy', qty: 3, lengthM: 17.5 } } }, { type: 'chandelier', properties: { spec: { size: 'grand', qty: 2 } } },
    { type: 'photobooth', properties: { spec: { kind: 'spin360', hours: 1.5 } } }, { type: 'chocolatefountain', properties: { spec: { size: 'large', servings: 333 } } },
    { type: 'chariot', properties: { spec: { kind: 'flower', trips: 1 } } }, { type: 'smoke', properties: { spec: { kind: 'low_fog', units: 3 } } },
    { type: 'dancers', properties: { spec: { count: 8, basis: 'hour', qty: 2.5 } } }],
    q: { discount: 5000, discountPct: 3, coupon: { kind: 'percent', value: 5 } }, r: { gstPct: 18 } },
  { name: 'studio-edited rate card (fractional)', items: [st({ lengthM: 7.3, widthM: 4.9, heightM: 1.5 })], cards: CARD2, r: { gstPct: 12 } },
  { name: 'mixed spec + flat (no spec) items', items: [st({ lengthM: 10, widthM: 6 }), { type: 'stage', category: 'structure' }, { type: 'dj', category: 'av' }], r: { gstPct: 18 } },
  { name: 'bad spec falls back to catalog price', items: [st({ lengthM: -2, widthM: 6 })], r: { gstPct: 18 } },
  { name: 'missing rate falls back to catalog price', items: [st({ lengthM: 8, widthM: 5 })], cards: { dj: S.DEFAULT_RATES.dj }, r: { gstPct: 18 } },
  { name: 'tax-inclusive (0079 server prices it as gst 0)', items: [st({ lengthM: 8, widthM: 5 })], r: { gstPct: 0 } },
];
const rows = CASES.map((c) => {
  const oi = P.fromItems(c.items, {}, c.cards);
  const p = Object.assign({ chairs: 0, chairPrice: 0, guests: 0, platePrice: 0, catering: { mode: 'inhouse', amount: 0 } }, c.q || {}, c.r, { other: oi.objectsCost + 0 });
  return { c, p, oi, ui: P.quoteTotal(p).total };
});
// no-spec items unchanged
assert.equal(P.fromItems([{ type: 'stage', category: 'structure' }, { type: 'dj', category: 'av' }], {}).objectsCost, 55000);
assert.equal(rows[6].oi.objectsCost, 45000); assert.equal(rows[7].oi.objectsCost, 45000);
assert.equal(rows[0].oi.objectsCost, 18000);
const vals = rows.map((r, k) => `(${k}, '${JSON.stringify(r.p).replace(/'/g, "''")}'::jsonb)`).join(',');
const out = execFileSync('psql', ['-X', '-q', '-t', '-A', '-F', '|', '-c',
  `select k, public.helm_quote_total(e)::bigint from (values ${vals}) v(k, e) order by k`], { encoding: 'utf8' }).trim().split('\n');
let pass = 0, fail = 0;
out.forEach((ln) => { const [k, db] = ln.split('|').map(Number); const r = rows[k];
  if (r.ui === db) pass++; else { fail++; console.log(`  ✗ ${r.c.name}: ui=${r.ui} db=${db}`); } });
console.log(`item-spec-parity: ${pass} parity case(s) passed, ${fail} failed`);
process.exit(fail || pass !== CASES.length ? 1 : 0);
