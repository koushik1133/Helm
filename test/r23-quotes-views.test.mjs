// R23 — Quotes list: "Cancelled" tab + count, "When" (event date) filter, rule-based smart search,
// clearer saved views (what a view applies, ★ default + · studio together, Cancelled preset).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ✓ ' + name); } catch (e) { fail++; console.log('  ✗ ' + name + '\n    ' + (e && e.stack || e)); } };

const SMART = read('public/quote-smart-filter.js');
const QH = read('public/quotes.html');
const SA = read('public/store-api.js');
const SF = read('public/saved-filters.js');

const smartCtx = vm.createContext({ Date, String, Number }); vm.runInContext(SMART, smartCtx);
const H = smartCtx.HelmQuoteSmart;
const TYPES = ['Wedding', 'Birthday', 'Corporate event'];

await t('range(): today / week (Mon-Sun) / month / next month / next 30 / past, local days', () => {
  const n = new Date(2026, 9, 19, 9, 0);   // Mon 19 Oct 2026
  assert.deepEqual({ ...H.range('today', n) }, { from: '2026-10-19', to: '2026-10-19' });
  assert.deepEqual({ ...H.range('tomorrow', n) }, { from: '2026-10-20', to: '2026-10-20' });
  assert.deepEqual({ ...H.range('week', new Date(2026, 9, 25)) }, { from: '2026-10-19', to: '2026-10-25' }, 'Sunday stays in its week');
  assert.deepEqual({ ...H.range('month', new Date(2026, 1, 10)) }, { from: '2026-02-01', to: '2026-02-28' });
  assert.deepEqual({ ...H.range('nextmonth', new Date(2026, 11, 5)) }, { from: '2027-01-01', to: '2027-01-31' });
  assert.deepEqual({ ...H.range('next30', n) }, { from: '2026-10-19', to: '2026-11-17' });
  assert.deepEqual({ ...H.range('past', new Date(2026, 0, 1)) }, { from: '', to: '2025-12-31' });
  assert.equal(H.range('', n), null); assert.equal(H.range('bogus', n), null);
});

await t('parse(): known phrases only -> filters; anything else stays a normal search', () => {
  const p = H.parse('Cancelled weddings this month', TYPES);
  assert.equal(p.tab, 'cancelled'); assert.equal(p.type, 'Wedding'); assert.equal(p.date, 'month');
  assert.deepEqual([...p.labels], ['Cancelled', 'Wedding', 'This month']);
  assert.equal(H.parse('show me canceled events', TYPES).tab, 'cancelled');
  assert.equal(H.parse('today', TYPES).date, 'today');
  assert.equal(H.parse('overdue', TYPES).tab, 'attention');
  const c = H.parse('corporate events next 30 days', TYPES); assert.equal(c.type, 'Corporate event'); assert.equal(c.date, 'next30');
  for (const x of ['unpaid', 'Rao', 'cancelled Rao', 'cancelled confirmed', 'today tomorrow', '', 'ab', 'x'.repeat(200)]) assert.equal(H.parse(x, TYPES), null, x);
  assert.equal(H.parse('wedding', []), null, 'a type is only known from the type list');
});

await t('store-api: "cancelled" view, date window, Cancelled count (behaviour of the shared rules)', () => {
  const a = SA.indexOf('const QUOTE_VIEWS'), b = SA.indexOf('function sbQuoteView');
  assert.ok(a > 0 && b > a);
  const ctx = vm.createContext({ String }); vm.runInContext(SA.slice(a, b) + ';this.r={QUOTE_VIEWS,quoteInView,quoteInDates,quoteIsArchived};', ctx);
  const { QUOTE_VIEWS, quoteInView, quoteInDates } = ctx.r;
  assert.ok(QUOTE_VIEWS.includes('cancelled'));
  const today = '2026-10-19';
  const cx = { status: 'cancelled', eventDate: '2026-10-25' }, hand = { status: 'cancelled', archivedAt: 'x' }, del = { status: 'cancelled', deletedAt: 'x' };
  const conf = { status: 'confirmed', eventDate: '2026-10-25' };
  assert.equal(quoteInView(cx, 'cancelled', today), true); assert.equal(quoteInView(hand, 'cancelled', today), true);
  assert.equal(quoteInView(del, 'cancelled', today), false); assert.equal(quoteInView(conf, 'cancelled', today), false);
  for (const v of ['active', 'quote', 'confirmed', 'attention']) assert.equal(quoteInView(cx, v, today), false, 'cancelled stays out of ' + v);
  assert.equal(quoteInView(cx, 'archived', today), true, 'and still in the Archive');
  assert.equal(quoteInDates(cx, { dateFrom: '2026-10-01', dateTo: '2026-10-31' }), true);
  assert.equal(quoteInDates(cx, { dateFrom: '2026-11-01' }), false);
  assert.equal(quoteInDates({ eventDate: null }, { dateTo: '2026-10-31' }), false, 'no date = outside a window');
  assert.equal(quoteInDates({ eventDate: null }, {}), true);
  assert.equal(quoteInDates(cx, { dateFrom: "2026-10-01' or 1=1" }), true, 'junk bounds are ignored');
  // server query + count + local mirror
  assert.match(SA, /if \(view === "cancelled"\) return q\.eq\("status", "cancelled"\);/);
  assert.ok(SA.indexOf('if (view === "cancelled") return q.eq') < SA.indexOf('if (shelf) q = q.is("archived_at", null);   // moved quotes'), 'cancelled view keeps hand-archived rows');
  assert.match(SA, /if \(quoteDay\(o\.dateFrom\)\) q = q\.gte\("event_date", o\.dateFrom\);/);
  assert.match(SA, /if \(quoteDay\(o\.dateTo\)\) q = q\.lte\("event_date", o\.dateTo\);/);
  assert.match(SA, /quoteInView\(x, o\.view, today\) && quoteInDates\(x, o\)/);
  assert.match(SA, /async countCancelled\(\)[\s\S]{0,400}\.eq\("status", "cancelled"\)[\s\S]{0,120}is\("deleted_at", null\)/);
});

await t('quotes.html: Cancelled tab + count, When select = smart DATES, script loaded, page() gets the window', () => {
  assert.match(QH, /<button type="button" data-f="cancelled" aria-pressed="false" id="tab_cancelled"[^>]*>Cancelled<span class="tcount" id="cnt_cancelled" hidden><\/span><\/button>/);
  const tabs = [...QH.slice(QH.indexOf('id="tabs"'), QH.indexOf('</div>', QH.indexOf('id="tabs"'))).matchAll(/data-f="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tabs, ['all', 'inprogress', 'quote', 'confirmed', 'attention', 'cancelled', 'archived', 'deleted']);
  const sel = QH.match(/<select id="dateFilter"[^>]*>([\s\S]*?)<\/select>/); assert.ok(sel);
  const opts = [...sel[1].matchAll(/<option value="([a-z0-9]*)">([^<]+)</g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(opts, [['', 'Any date'], ...H.DATES.map((d) => [...d])]);
  assert.ok(QH.indexOf('quote-smart-filter.js?v=') > 0 && QH.indexOf('quote-smart-filter.js?v=') < QH.indexOf('<script>\n'));
  assert.ok(QH.includes('BPStore.quotes.page({ offset, view:viewOf(filter), eventType:typeFilter, search:($("#search").value||"").trim(), sort:"confirmedFirst", ...quoteDateArgs() })'), 'page() gets the date window');
  assert.match(QH, /loadCancelledCount\(\);/);
  assert.match(QH, /\$\("#dateFilter"\)\.addEventListener\("change"/);
  assert.match(QH, /HelmQuoteSmart\.parse\(\$\("#search"\)\.value, types\)/);
});

// the shelf block of quotes.html, run on its own (same harness idea as link-expiry-archive-ui)
const shelfSrc = QH.slice(QH.indexOf('/* ---------- Archive / Deleted shelves (0040)'), QH.indexOf('/* ---------- end Archive / Deleted shelves ---------- */'));
function shelfPage(filter, dateFilter) {
  const els = {}; const el = (id) => els[id] || (els[id] = { id, hidden: false, textContent: '', value: '' });
  const SHELF = { rows: [
    { id: 'h1', status: 'cancelled', shelf: 'archived', reason: 'manual', event_type: 'Wedding', event_date: '2026-10-25' },
    { id: 'a2', status: 'confirmed', shelf: 'archived', reason: 'manual', event_type: 'Wedding', event_date: '2026-12-25' },
    { id: 'd1', status: 'cancelled', shelf: 'deleted', reason: 'manual' },
  ], archived_count: 2, deleted_count: 1 };
  const ctx = { $: (s) => el(s.replace(/^#/, '')), Number, String, Array, Promise, Date, isNaN, filter, typeFilter: '', dateFilter, quotes: [], detailCache: {},
    window: { HelmQuoteSmart: { range: (k) => (k ? { from: '2026-10-01', to: '2026-10-31' } : null) } }, BPStore: { mode: () => 'supabase', quoteShelf: { list: async () => SHELF } } };
  vm.createContext(ctx);
  vm.runInContext(shelfSrc + '\n;Object.assign(this,{shelfPage});', ctx);
  return ctx;
}
await t('Cancelled tab keeps a hand-archived cancelled event, drops a Deleted one; When applies to shelf rows', async () => {
  let c = shelfPage('cancelled', '');
  let r = await c.shelfPage(0, async () => ({ rows: [{ id: 'c1' }, { id: 'h1' }, { id: 'd1' }], hasMore: false, offset: 0 }));
  assert.deepEqual(r.rows.map((x) => x.id), ['c1', 'h1']);
  c = shelfPage('all', ''); r = await c.shelfPage(0, async () => ({ rows: [{ id: 'x1' }, { id: 'h1' }], hasMore: false }));
  assert.deepEqual(r.rows.map((x) => x.id), ['x1'], 'Active still drops shelved rows');
  c = shelfPage('archived', 'month'); r = await c.shelfPage(0, async () => ({ rows: [], hasMore: false }));
  assert.deepEqual(r.rows.map((x) => x.id), ['h1'], 'only the October event is inside the window');
  c = shelfPage('archived', ''); r = await c.shelfPage(0, async () => ({ rows: [], hasMore: false }));
  assert.deepEqual(r.rows.map((x) => x.id), ['h1', 'a2'], 'any date = every archived row');
});

await t('saved views: quotes keep tab + type + When; describe() says what a view applies', () => {
  const doc = { readyState: 'loading', addEventListener() {}, getElementById: () => null };
  const win = { document: doc, setTimeout: () => 0 }; win.globalThis = win;
  const ctx = vm.createContext(win); vm.runInContext(SF, ctx);
  const S = win.HelmSavedFilters;
  assert.deepEqual([...S.PAGES.quotes.sel], ['typeFilter', 'dateFilter']);
  const st = S.clean(S.PAGES.quotes, { tab: 'cancelled', sel: { typeFilter: 'Wedding', dateFilter: 'month' }, q: 'Rao' });
  assert.equal(st.tab, 'cancelled'); assert.equal(st.sel.dateFilter, 'month');
  assert.equal(S.describe(S.PAGES.quotes, st), 'cancelled · Wedding · month · search “Rao”');
  assert.equal(S.describe(S.PAGES.quotes, {}), 'Everything (no filters)');
  assert.ok(S.PAGES.quotes.presets.some((p) => p.key === 'cancelled' && p.state.tab === 'cancelled'));
  assert.match(SF, /\(v\.is_default && mine \? " ★" : ""\) \+ \(v\.shared \? " · studio" : ""\)/);
  assert.match(SF, /c\.title = v\.name \+ " - shows: " \+ describe\(self\.cfg, v\.state\)/);
  assert.match(SF, /sum\.textContent = "Shows: " \+ describe\(this\.cfg, v\.state\)/);
  assert.doesNotMatch(SMART + SF, /innerHTML/);
});

console.log(`\nr23-quotes-views: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
