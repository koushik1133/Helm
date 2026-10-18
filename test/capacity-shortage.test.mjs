// 0197 (owner 2026-10): over-capacity decision on a quote + stock-shortage sourcing on "Reserve for this
// event" + the self-explanatory starter-list button (hidden in the free trial, like Excel import).
// Pure helpers run in a vm; store-api.js runs in a vm sandbox with a stubbed supabase client.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const J = (x) => JSON.parse(JSON.stringify(x));
const tests = []; const t = (n, f) => tests.push([n, f]);

/* ---------------------------------------------------------------- pure module */
const mx = { window: {} }; mx.globalThis = mx; vm.createContext(mx);
vm.runInContext(read('public/capacity-shortage.js'), mx);
const C = mx.window.HelmCapacity, SH = mx.window.HelmShortage;
const vx = { window: {} }; vx.globalThis = vx; vm.createContext(vx);
vm.runInContext(read('public/venues-core.js'), vx);
const V = vx.window.HelmVenues;

const grounds = { id: 'v1', name: 'Grounds', seated_capacity: 40000, floating_capacity: 10000, active: true };
t('venue capacity is seated + floating (40,000 + 10,000 = 50,000)', () => {
  assert.deepEqual(J(V.capacity(grounds)), { seated: 40000, floating: 10000, total: 50000 });
  assert.equal(C.venueTotal(grounds), 50000);
  assert.equal(C.capText({ seated: 40000, floating: 10000, total: 50000 }), '40,000 seated + 10,000 floating = 50,000');
  assert.equal(C.capText({ seated: 0, floating: 2000, total: 2000 }), '2,000 floating');
  const w = V.warnings(grounds, { guests: 60000 }).find((x) => x.code === 'capacity');
  assert.ok(w && w.level === 'warn'); assert.match(w.msg, /60,000 guests is more than this venue holds \(40,000 seated \+ 10,000 floating = 50,000\) - 10,000 won't fit/);
  assert.ok(!V.warnings(grounds, { guests: 50000 }).some((x) => x.code === 'capacity'));
});
t('venues to move to: active only, biggest first, fits flag, current venue left out', () => {
  const list = [grounds, { id: 'v2', name: 'Small', seated_capacity: 300, active: true }, { id: 'v3', name: 'Huge', seated_capacity: 70000, floating_capacity: 5000, active: true },
    { id: 'v4', name: 'Closed', seated_capacity: 99999, active: false }, { id: 'v5', name: 'No size', active: true }];
  const s = J(C.sortVenues(list, 60000, 'v1'));
  assert.deepEqual(s.map((x) => x.venue.id), ['v3', 'v2']);
  assert.deepEqual(s.map((x) => x.fits), [true, false]); assert.equal(s[0].total, 75000);
});
t('decision payloads: proceed carries the note, extend the extra space + line, venue the new venue', () => {
  const st = { guests: 60000, total: 50000, short: 10000, venue: grounds };
  assert.deepEqual(J(C.decisionPayload('proceed', st, { note: '  Standing room ok  ' })),
    { choice: 'proceed', guests: 60000, capacity: 50000, venue_id: 'v1', venue_name: 'Grounds', note: 'Standing room ok' });
  const ex = J(C.decisionPayload('extend', st, { extra: 10000, line: { label: 'Overflow tent', qty: 2, rate: 75000, source: 'vendor', vendor_id: 'x' } }));
  assert.equal(ex.extra_capacity, 10000); assert.equal(ex.line.label, 'Overflow tent'); assert.equal(ex.venue_id, 'v1');
  const vn = J(C.decisionPayload('venue', st, { venue: { id: 'v3', name: 'Huge', seated_capacity: 70000, floating_capacity: 5000 } }));
  assert.equal(vn.venue_id, 'v3'); assert.equal(vn.capacity, 75000);
  assert.equal(C.headline({ short: 10000 }), "10,000 guests won't fit"); assert.equal(C.headline({ short: 1 }), "1 guest won't fit");
  assert.equal(C.whyText('send'), 'send the quote'); assert.equal(C.whyText('confirm'), 'confirm the booking'); assert.equal(C.whyText('pdf'), 'make the quote PDF');
});
t('shortage split + headline: only 20 free, short by 10; never negative', () => {
  assert.deepEqual(J(SH.split(30, 20)), { take: 20, short: 10 });
  assert.deepEqual(J(SH.split(5, -3)), { take: 0, short: 5 });
  assert.deepEqual(J(SH.split(4, 20)), { take: 4, short: 0 });
  assert.equal(SH.headline({ unit: 'pcs' }, 20, 10, '28 Nov 2026'), 'Only 20 pcs free on 28 Nov 2026 — short by 10');
  assert.equal(SH.headline({}, 0, 30, ''), 'Nothing free — short by 30');
});
t('vendors filtered by the item category first (category or services), inactive left out', () => {
  const vs = [{ id: 'a', name: 'Cool Rentals', category: 'Cooling', active: true }, { id: 'b', name: 'Tent House', category: 'Tents', active: true },
    { id: 'c', name: 'All-in-one', category: 'General', services: ['cooling', 'lights'], active: true }, { id: 'd', name: 'Old', category: 'Cooling', active: false }];
  const g = J(SH.vendorsFor(vs, { category: 'Cooling' }));
  assert.deepEqual(g.matched.map((v) => v.id), ['a', 'c']); assert.deepEqual(g.others.map((v) => v.id), ['b']);
  assert.deepEqual(J(SH.vendorsFor(vs, {})).others.map((v) => v.id), ['a', 'b', 'c']);
});

/* ---------------------------------------------------------------- store-api sandbox */
const SRC = read('public/store-api.js');
function memStore(init) { const m = new Map(Object.entries(init || {})); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function makeClient(respond, rpcs) {
  const queries = [], rpcCalls = [];
  const user = { id: 'u-1', email: 'staff@a.test' }, session = { user, access_token: 'x' };
  const client = { queries, rpcCalls,
    auth: { async getSession() { return { data: { session } }; }, onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async refreshSession() { return { data: { session }, error: null }; }, async signOut() { return { error: null }; },
      mfa: { async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; } } },
    rpc(name, args) {
      if (name === 'current_org_id') return Promise.resolve({ data: 'org-1', error: null });
      if (name === 'password_change_required') return Promise.resolve({ data: false, error: null });
      rpcCalls.push([name, args]);
      if (rpcs && rpcs[name]) return Promise.resolve(rpcs[name](args));
      return Promise.resolve({ data: null, error: null });
    },
    from(table) {
      const q = { table, calls: [] }; const b = {};
      const rec = (m) => (...a) => { q.calls.push([m, ...a]); return b; };
      ['select', 'insert', 'update', 'eq', 'neq', 'is', 'not', 'or', 'in', 'lt', 'lte', 'gt', 'gte', 'like', 'ilike', 'filter', 'contains', 'order', 'range', 'limit'].forEach((m) => { b[m] = rec(m); });
      const run = () => { queries.push(q); return Promise.resolve(respond(q)); };
      b.single = () => { q.calls.push(['single']); return run().then((r) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] : r.data })); };
      b.maybeSingle = b.single; b.then = (res, rej) => run().then(res, rej);
      return b;
    } };
  return client;
}
async function makeEnv(o = {}) {
  const client = makeClient((q) => {
    if (q.table === 'profiles') return { data: [{ role: 'admin' }], error: null };
    if (q.table === 'role_access') return { data: [], error: null };
    return (o.respond || (() => ({ data: [], error: null })))(q);
  }, o.rpcs);
  const doc = { readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=247' },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {} }),
    head: { appendChild() {} }, body: { appendChild() {}, removeChild() {}, children: [] },
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; }, classList: { contains: () => false, add() {}, remove() {} } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  const win = { SUPABASE_CONFIG: { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' }, supabase: { createClient: () => client },
    localStorage: memStore(), sessionStorage: memStore(),
    location: { pathname: '/dashboard', search: '', hash: '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events', replace() {}, reload() {} },
    document: doc, navigator: { onLine: true }, fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    addEventListener() {}, removeEventListener() {}, setTimeout: (fn, ms) => { if (!ms || ms < 1000) { try { fn(); } catch (e) {} } return 0; }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {}, atob: (b) => Buffer.from(b, 'base64').toString('binary'), console: { log() {}, info() {}, warn() {}, error() {} } };
  win.window = win; win.globalThis = win;
  vm.createContext(win); vm.runInContext(SRC, win, { filename: 'store-api.js' });
  await win.BPStore.init(); client.queries.length = 0; client.rpcCalls.length = 0;
  return { S: win.BPStore, q: client.queries, rpc: client.rpcCalls };
}
const missing = () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });

t('capacityStatus: over until a decision for THIS venue covers the guests', async () => {
  const { S } = await makeEnv();
  const q = { client: { guests: 60000, venueId: 'v1' } };
  const st = J(S.capacityStatus(q, grounds));
  assert.equal(st.over, true); assert.equal(st.short, 10000); assert.equal(st.total, 50000); assert.equal(st.resolved, false);
  assert.equal(S.capacityStatus({ client: { guests: 50000 } }, grounds).over, false);
  assert.equal(S.capacityStatus(q, null).over, false, 'no linked venue: nothing to check');
  const pro = { ...q, capacityDecision: { choice: 'proceed', guests: 60000, venue_id: 'v1', note: 'ok' } };
  assert.equal(S.capacityStatus(pro, grounds).resolved, true);
  assert.equal(S.capacityStatus(pro, grounds, 61000).resolved, false, 'more guests than recorded: ask again');
  assert.equal(S.capacityStatus({ ...pro, capacityDecision: { ...pro.capacityDecision, venue_id: 'v9' } }, grounds).resolved, false, 'another venue: ask again');
  const ext = { ...q, capacityDecision: { choice: 'extend', guests: 60000, extra_capacity: 10000, venue_id: 'v1' } };
  assert.equal(S.capacityStatus(ext, grounds).resolved, true); assert.equal(S.capacityStatus(ext, grounds, 60001).resolved, false);
  assert.equal(S.capacityStatus({ ...q, capacityDecision: { choice: 'reduce', guests: 50000, venue_id: 'v1' } }, grounds).resolved, false, 'reduce resolves by the guest count itself');
});
t('shortageText: sourcing from <vendor> / outsource / unsourced', async () => {
  const { S } = await makeEnv();
  assert.equal(S.shortageText({ qty: 10, source: 'vendor', label: 'Short: 10 x Air Cooler / Fan' }, { vendorName: 'Cool Rentals', bookingStatus: 'enquiry' }),
    'Short: 10 × Air Cooler / Fan — sourcing from Cool Rentals (enquiry)');
  assert.equal(S.shortageText({ qty: 3, source: 'buy' }, { itemName: 'Tent' }), 'Short: 3 × Tent — outsource / buy');
  assert.equal(S.shortageText({ qty: 5, source: 'none', label: 'Short: 5 x Fan' }), 'Short: 5 × Fan — unsourced');
});
t('setCapacityDecision -> set_quote_capacity_decision RPC; get() maps capacity_decision', async () => {
  const e = await makeEnv({ rpcs: { set_quote_capacity_decision: (a) => ({ data: Object.assign({ decided_at: 'now' }, a.p_decision), error: null }) },
    respond: (q) => q.table === 'quotes' ? { data: [{ id: '00000000-0000-4000-8000-000000000001', code: 'C', client: {}, pricing: {}, capacity_decision: { choice: 'proceed' } }], error: null } : { data: [], error: null } });
  const d = await e.S.quotes.setCapacityDecision('q1', { choice: 'proceed', note: 'fine', guests: 60000 });
  assert.equal(e.rpc[0][0], 'set_quote_capacity_decision'); assert.equal(e.rpc[0][1].p_quote, 'q1'); assert.equal(d.choice, 'proceed');
  await e.S.quotes.setCapacityDecision('q1', null); assert.equal(e.rpc[1][1].p_decision, null);
  const g = await e.S.quotes.get('00000000-0000-4000-8000-000000000001'); assert.equal(g.capacityDecision.choice, 'proceed');
});
t('reserveWithSourcing: one RPC with the source, vendor and rate', async () => {
  const e = await makeEnv({ rpcs: { reserve_inventory_with_sourcing: () => ({ data: { reserved: 20, short: 10, source: 'vendor' }, error: null }) } });
  const r = await e.S.inventory.reserveWithSourcing('i1', 'q1', 30, 'hall', { source: 'vendor', vendorId: 'v1', rate: '500', sourceNote: 'by 4pm' });
  assert.equal(r.reserved, 20); const [name, a] = e.rpc[0];
  assert.equal(name, 'reserve_inventory_with_sourcing');
  assert.deepEqual(J(a), { p_item: 'i1', p_quote: 'q1', p_qty: 30, p_note: 'hall', p_source: 'vendor', p_vendor: 'v1', p_rate: 500, p_source_note: 'by 4pm' });
  await e.S.inventory.reserveWithSourcing('i1', 'q1', 3, null, { source: 'buy', vendorId: 'v1' });
  assert.equal(e.rpc[1][1].p_vendor, null, 'vendor only for source vendor'); assert.equal(e.rpc[1][1].p_source, 'buy');
});
t('reserveWithSourcing without 0197: reserves only the free stock, then the shortage request + vendor booking', async () => {
  const ins = [];
  const e = await makeEnv({ rpcs: { reserve_inventory_with_sourcing: missing, reserve_inventory: (a) => { ins.push(['res', a.p_qty]); return { data: { id: 'r1' }, error: null }; } },
    respond: (q) => {
      const i = q.calls.find((c) => c[0] === 'insert'); if (i) { ins.push([q.table, J(i[1])]); return { data: [{ id: q.table + '-1' }], error: null }; }
      if (q.table === 'inventory_items') return { data: [{ id: 'i1', name: 'Air Cooler', total_qty: 20, active: true }], error: null };
      if (q.table === 'quotes') return { data: [{ id: 'q1', event_date: '2026-11-28', status: 'quote' }], error: null };
      return { data: [], error: null };
    } });
  const r = await e.S.inventory.reserveWithSourcing('i1', 'q1', 30, null, { source: 'vendor', vendorId: 'v1', vendorName: 'Cool Rentals', rate: 500 });
  assert.equal(r.reserved, 20); assert.equal(r.short, 10);
  assert.deepEqual(ins[0], ['res', 20], 'only the free 20 go through reserve_inventory');
  const bk = ins.find((x) => x[0] === 'event_resources'); assert.ok(bk); assert.equal(bk[1].cost, 5000); assert.equal(bk[1].qty, 10); assert.equal(bk[1].status, 'enquiry');
  const rq = ins.find((x) => x[0] === 'event_stock_requests'); assert.ok(rq); assert.equal(rq[1].qty, 10); assert.match(rq[1].label, /^Short: 10 x Air Cooler/); assert.match(rq[1].note, /^Sourcing from Cool Rentals/);
});
t('readiness has "Guests fit the venue" + "Stock sourced"; calendar lists shortages', async () => {
  const qid = '00000000-0000-4000-8000-000000000007';
  const e = await makeEnv({ respond: (q) => {
    if (q.table === 'quotes') return { data: [{ id: qid, code: 'C-7', title: 'Mela', status: 'confirmed', lifecycle_stage: 'confirmed', event_date: '2026-11-28', client: { guests: 60000, venueId: 'v1' }, pricing: {} }], error: null };
    if (q.table === 'venues') return { data: [grounds], error: null };
    if (q.table === 'event_stock_requests') return { data: [{ id: 's1', quote_id: qid, item_id: 'i1', label: 'Short: 10 x Air Cooler / Fan', qty: 10, status: 'requested', source: 'vendor', vendor_id: 'vd', booking_id: 'b1' },
      { id: 's2', quote_id: qid, item_id: 'i1', label: 'Short: 5 x Air Cooler / Fan', qty: 5, status: 'requested', source: 'none' }], error: null };
    if (q.table === 'inventory_items') return { data: [{ id: 'i1', name: 'Air Cooler / Fan', total_qty: 20, active: true }], error: null };
    if (q.table === 'vendors') return { data: [{ id: 'vd', name: 'Cool Rentals', active: true }], error: null };
    if (q.table === 'event_resources') return { data: [{ id: 'b1', quote_id: qid, vendor_id: 'vd', status: 'enquiry', label: 'x' }], error: null };
    return { data: [], error: null };
  } });
  const r = await e.S.readiness.check(qid);
  const cap = r.checks.find((c) => c.key === 'capacity'), st = r.checks.find((c) => c.key === 'stock');
  assert.ok(cap && cap.critical && !cap.ok); assert.match(cap.detail, /10,000 guests won't fit/);
  assert.ok(st && st.critical && !st.ok, 'one shortage is unsourced');
  assert.match(st.detail, /Short: 10 × Air Cooler \/ Fan — sourcing from Cool Rentals \(enquiry\)/); assert.match(st.detail, /Short: 5 × Air Cooler \/ Fan — unsourced/);
  const cal = await e.S.calendar.load();
  assert.equal(cal.shortages.length, 2); assert.equal(cal.shortages[0].date, '2026-11-28');
  assert.match(cal.shortages[0].text, /sourcing from Cool Rentals/);
  assert.equal(cal.agenda[0].shortages.length, 2);
});

/* ---------------------------------------------------------------- wiring */
t('gates: quote flow (send / PDF / confirm), quotes Confirm & lock; workspace issues mounted', () => {
  const flow = read('public/flow.html'), qs = read('public/quotes.html'), ev = read('public/event.html');
  assert.match(flow, /HelmCapacity\.gate\(\{ quoteId:id, quote:ev, why:"send" \}\)/);
  assert.match(flow, /HelmCapacity\.gate\(\{ quoteId:id, quote:ev, why:"pdf" \}\)/);
  assert.match(flow, /HelmCapacity\.gate\(\{ quoteId:id, quote:ev, why:"confirm" \}\)/);
  assert.match(flow, /<script src="capacity-shortage\.js\?v=\d+"><\/script>/);
  assert.match(qs, /confirmIt && window\.HelmCapacity && !\(await HelmCapacity\.gate\(\{ quoteId:cmId/);
  assert.match(ev, /<div id="capIssues"/); assert.match(ev, /HelmCapacity\.mountIssues\(\$\("#capIssues"\)/);
  const js = read('public/capacity-shortage.js');
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write/, 'DOM nodes only');
  for (const s of ['Change venue', 'Reduce guest count', 'Extend the space', 'Proceed anyway with a note']) assert.ok(js.includes(s), s);
});
t('inventory: shortage panel replaces "Reserve anyway"; starter list renamed + confirm + hidden in trial', () => {
  const inv = read('public/inventory.html'), css = read('public/trial-lock.css');
  assert.doesNotMatch(inv, /Reserve anyway|allowOver:overOk/);
  assert.match(inv, /<div id="rvShort" class="rvs"/); assert.match(inv, /HelmShortage\.renderList\(\$\("#rvShortList"\)/);
  assert.match(inv, />Add common event items \(starter list\)<\/button>/); assert.doesNotMatch(inv, />Load starter items</);
  assert.match(inv, /id="seedBtn"[^>]*title="Adds a ready-made list of common event items/);
  assert.match(inv, /title:"Add common event items\?"/); assert.match(inv, /starterSummary\(pick\)/);
  assert.match(inv, /\$\("#seedBtn"\)\.hidden=!canEdit\|\|inTrial\(\); \$\("#importBtn"\)\.hidden=!canEdit\|\|!window\.HelmImport\|\|inTrial\(\);/);
  assert.match(inv, /if\(inTrial\(\)\)\{ if\(window\.HelmTrialLock\) HelmTrialLock\.note\(\); return; \}/);
  assert.match(css, /html\.helm-trial #seedBtn, html\.helm-trial #firstSeed/); assert.match(css, /html\.helm-trial:not\(\.tl-budget\) #importBtn/);
});
t('0197 SQL: additive + idempotent, ASCII, nullable columns only, in MANIFEST + APPLY with VERIFY', () => {
  const m = read('supabase/migrations/0197_capacity_and_stock_shortage.sql'), ap = read('supabase/APPLY-0197.sql'), man = read('supabase/migrations/MANIFEST');
  assert.ok(/^[\x00-\x7f]*$/.test(m) && /^[\x00-\x7f]*$/.test(ap), 'ASCII only');
  assert.doesNotMatch(m.replace(/^\s*--.*$/gm, ''), /\b(drop\s+table|drop\s+column|delete\s+from|truncate)\b/i);
  assert.equal((m.match(/add column if not exists/g) || []).length, 4); assert.doesNotMatch(m, /not null default|set not null/i);
  assert.match(man, /forward {2}supabase\/migrations\/0197_capacity_and_stock_shortage\.sql/);
  assert.match(ap, /^begin;/m); assert.match(ap, /^commit;/m); assert.match(ap, /-- VERIFY/); assert.ok(ap.includes(m.trim().split('\n').slice(-3).join('\n')));
});

let n = 0;
for (const [name, fn] of tests) { try { await fn(); n++; } catch (e) { console.error('FAIL - ' + name); throw e; } }
console.log('capacity-shortage: ' + n + '/' + tests.length + ' passed');
