// R3-A: live history, server recents, re-pricing alerts, per-event profit (static + pure checks)
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
const store = read('public/store-api.js'), flow = read('public/flow.html'), builder = read('public/builder.js'),
  ins = read('public/insights.html'), mig = read('supabase/migrations/0077_r3_sync_reprice_profit.sql'), ap = read('supabase/APPLY-0077.sql');

t('store-api: realtime version subscription, server recents, insights.events, bell link + label', () => {
  assert.match(store, /subscribeVersions\(id, cb\)/);
  assert.match(store, /table: "quote_versions", filter: f/);
  assert.match(store, /table: "quotation_versions", filter: f/);
  assert.match(store, /rpc\("recent_touch"/); assert.match(store, /rpc\("recent_list"/);
  assert.match(store, /rpc\("insights_events"/);
  assert.match(store, /k === "price_change"\) return "flow\.html\?id=" \+ enc\(q\)/);
  assert.match(store, /price_change: \[/);
});
t('builder: version list refreshes on open, focus, visibility, after save, realtime', () => {
  assert.match(builder, /watchVersions\(\);/);
  assert.match(builder, /subscribeVersions\(currentQuoteId/);
  assert.match(builder, /visibilitychange[^\n]*refreshVersionsSoon/);
  assert.match(builder, /noteSavedVersion\(v, label\);\n\s*refreshVersionsSoon\(true\)/);
});
t('flow: activity trail + quotation versions re-read after save and live', () => {
  assert.match(flow, /await renderQuoteVersions\(\); renderActivity\(\); renderReprice\(\);/);
  assert.match(flow, /subscribeVersions\(id, \(\)=>refreshHistorySoon\(\)\)/);
});
t('flow: re-price banner is manual, goes through saveQuotation, stale-approval confirm', () => {
  assert.match(flow, /id="repriceBanner"[^>]*hidden/);
  assert.match(flow, /Prices changed since this quote was priced/);
  const body = flow.slice(flow.indexOf('async function applyReprice'), flow.indexOf('async function renderQuoteVersions'));
  assert.match(body, /BPUI\.confirm\(/); assert.match(body, /approval will go stale/); assert.match(body, /await saveQuotation\(\)/);
  assert.doesNotMatch(flow.slice(flow.indexOf('function renderReprice'), flow.indexOf('async function applyReprice')), /saveQuotation|quotationVersions\.save/);
  assert.match(flow, /_ratesAt:ratesSnapshot\(\)/);
});
t('nav-trail: server merge (newest wins, unsafe links dropped)', () => {
  const g = globalThis; g.window = undefined;
  const store0 = {}; g.localStorage = { getItem: (k) => store0[k] || null, setItem: (k, v) => { store0[k] = v; }, removeItem: (k) => { delete store0[k]; }, key: () => null, length: 0 };
  g.BPStore = { auth: { user: () => ({ id: 'u1' }) } };
  const T = createRequire(import.meta.url)('../public/nav-trail.js');
  const out = T.merge([{ href: 'flow.html?id=1', title: 'A', kind: 'event', at: '2026-10-01T00:00:00Z' },
    { href: 'https://evil.example/x.html', title: 'X', kind: 'event', at: '2026-10-02T00:00:00Z' },
    { href: 'leads.html?id=2', title: 'B', kind: 'lead', at: '2026-10-03T00:00:00Z' }]);
  assert.deepEqual(out.map((r) => r.href), ['leads.html?id=2', 'flow.html?id=1']);
});
t('insights: per-event table, sortable, DOM-only rows, finance-gated', () => {
  assert.match(ins, /id="perEventCard"/); assert.match(ins, /aria-sort/);
  assert.match(ins, /canFin && BPStore\.insights\.events/);
  const fn = ins.slice(ins.indexOf('function renderPerEvent'), ins.indexOf('function renderSummary'));
  assert.doesNotMatch(fn, /innerHTML/);
});
t('SQL 0077: additive, ASCII, gated, MANIFEST, APPLY verify rows', () => {
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0077_r3_sync_reprice_profit\.sql/);
  assert.ok(/^[\x00-\x7F]*$/.test(ap) && /^[\x00-\x7F]*$/.test(mig));
  assert.doesNotMatch(mig, /\b(drop table|truncate|delete from)\b/i);
  assert.match(mig, /has_area\('insights', 'view'\)/); assert.match(mig, /has_area\('finance', 'view'\)/);
  assert.match(mig, /exception when others then null;\n  end;\n  return null;/);
  assert.match(ap.trim(), /\) v\(item, ok\)\norder by item;$/);
});
console.log('r3-sync-reprice: ' + n + ' passed');
