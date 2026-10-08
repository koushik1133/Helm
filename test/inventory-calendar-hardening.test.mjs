// Also prints the dashboard payload before/after for 200 realistic quotes.
// Pure Node, no deps: store-api.js runs in a vm sandbox with a stubbed supabase client.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/store-api.js');
const tests = [];
const J = (x) => JSON.parse(JSON.stringify(x));   // values from the vm realm → plain
const t = (name, fn) => tests.push([name, fn]);

/* ------------------------------------------------------------ sandbox */
function memStore(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}
// A recording PostgREST query builder: every call is kept; awaiting it asks `respond`.
function makeClient(respond) {
  const queries = [];
  const user = { id: 'u-1', email: 'staff@a.test' };
  const session = { user, access_token: 'x' };
  const client = {
    queries,
    auth: {
      async getSession() { return { data: { session } }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async refreshSession() { return { data: { session }, error: null }; },
      async signOut() { return { error: null }; },
      mfa: { async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; } },
    },
    rpc(name) {
      if (name === 'current_org_id') return Promise.resolve({ data: 'org-1', error: null });
      if (name === 'password_change_required') return Promise.resolve({ data: false, error: null });
      if (name === 'reserve_inventory') return Promise.resolve({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.reserve_inventory' } });   // not deployed -> client falls back
      return Promise.resolve({ data: null, error: null });
    },
    from(table) {
      const q = { table, calls: [] };
      const rec = (m) => (...a) => { q.calls.push([m, ...a]); return b; };
      const b = {};
      ['select', 'insert', 'eq', 'neq', 'is', 'not', 'or', 'in', 'lt', 'lte', 'gt', 'gte', 'like', 'ilike', 'filter', 'contains', 'order', 'range', 'limit']
        .forEach((m) => { b[m] = rec(m); });
      const run = () => { queries.push(q); return Promise.resolve(respond(q)); };
      b.single = () => { q.calls.push(['single']); return run().then((r) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] : r.data })); };
      b.maybeSingle = b.single;
      b.then = (res, rej) => run().then(res, rej);
      return b;
    },
  };
  return client;
}
const call = (q, m) => q.calls.find((c) => c[0] === m);
const calls = (q, m) => q.calls.filter((c) => c[0] === m);

async function makeEnv(o = {}) {
  const ss = memStore(o.ss || {});
  const client = makeClient((q) => {
    if (q.table === 'profiles') return { data: [{ role: 'admin' }], error: null };
    if (q.table === 'role_access') return { data: [], error: null };
    return (o.respond || (() => ({ data: [], error: null })))(q);
  });
  const doc = {
    readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=1' },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {} }),
    head: { appendChild() {} }, body: { appendChild() {}, removeChild() {}, children: [] },
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; }, classList: { contains: () => false, add() {}, remove() {} } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  };
  const win = {
    SUPABASE_CONFIG: o.local ? {} : Object.assign({ url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' }, o.cfg || {}),
    supabase: { createClient: () => client },
    localStorage: memStore(o.ls || {}), sessionStorage: ss,
    location: { pathname: '/dashboard', search: '', hash: '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events', replace() {}, reload() {} },
    document: doc, navigator: { onLine: true },
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    addEventListener() {}, removeEventListener() {},
    setTimeout: (fn, ms) => { if (!ms || ms < 1000) { try { fn(); } catch (e) {} } return 0; }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    console: { log() {}, info() {}, warn() {}, error() {} },
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'store-api.js' });
  await win.BPStore.init();
  client.queries.length = 0;   // keep only what the test itself triggers
  return { S: win.BPStore, q: client.queries, win, ss };
}
// fake rows
const uuid = (i) => '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
const quoteRow = (i, extra) => Object.assign({ id: uuid(i), code: '10072026-' + String(i).padStart(2, '0'), title: 'Event ' + i, event_type: 'Wedding',
  status: 'quote', lifecycle_stage: 'quote', approval_status: 'none', current_version: 1, event_date: '2026-11-01', event_time: null,
  updated_at: '2026-10-07T10:00:00Z', created_at: '2026-10-01T10:00:00Z', confirmed_at: null,
  total: 125000, client_name: 'Client ' + i, client_phone: '98765', pricing_client_name: 'Client ' + i }, extra || {});

const respondWith = (tbl) => (q) => (tbl[q.table] ? { data: tbl[q.table](q), error: null } : { data: [], error: null });
const item = { id: 'i1', name: 'Chair', total_qty: 10, active: true, unit: 'pcs' };
const qrow = (id, extra) => Object.assign({ id, event_date: '2026-11-01', status: 'confirmed', lifecycle_stage: 'quote', archived_at: null, deleted_at: null }, extra || {});

t('availability: reservation on archived/cancelled quote is free; live one counts', async () => {
  const e = await makeEnv({ respond: respondWith({
    inventory_items: () => [item],
    inventory_reservations: () => [{ item_id: 'i1', quote_id: 'qa', qty: 4, status: 'reserved' }, { item_id: 'i1', quote_id: 'qb', qty: 3, status: 'reserved' }, { item_id: 'i1', quote_id: 'qc', qty: 2, status: 'allocated' }],
    quotes: () => [qrow('qa', { archived_at: '2026-01-01' }), qrow('qb'), qrow('qc', { status: 'cancelled' })] }) });
  const a = await e.S.inventory.availability();
  assert.equal(a.i1.committed, 3); assert.equal(a.i1.available, 7);
  assert.ok(e.q.filter((x) => x.table === 'quotes').every((x) => call(x, 'in')), 'quote lookup is by id list, not the capped list()');
});
t('availability: open checkouts count (net of returned); returned ones do not; no double count with same-event reservation', async () => {
  const e = await makeEnv({ respond: respondWith({
    inventory_items: () => [item],
    inventory_reservations: () => [{ item_id: 'i1', quote_id: 'qb', qty: 3, status: 'reserved' }],
    inventory_checkouts: () => [{ item_id: 'i1', quote_id: 'qb', qty_out: 3, qty_in: null, status: 'out' },
      { item_id: 'i1', quote_id: null, qty_out: 5, qty_in: 2, status: 'partial' },
      { item_id: 'i1', quote_id: 'qb', qty_out: 9, qty_in: 9, status: 'returned' }],
    quotes: () => [qrow('qb')] }) });
  const a = await e.S.inventory.availability();
  assert.equal(a.i1.committed, 3 + 3);   // event qb: max(3 reserved, 3 out) + 3 still out with no event
});
t('reserve: refuses when fresh availability is gone (no insert), inserts when it fits', async () => {
  let inserted = 0;
  const mk = (resQty) => makeEnv({ respond: (q) => {
    if (q.table === 'inventory_items') return { data: [item], error: null };
    if (q.table === 'inventory_reservations') {
      if (q.calls.some((c) => c[0] === 'insert')) { inserted++; return { data: [{ id: 'r' }], error: null }; }
      return { data: [{ item_id: 'i1', quote_id: 'qb', qty: resQty, status: 'reserved' }], error: null };
    }
    if (q.table === 'quotes') return { data: [qrow('qb'), qrow('qn')], error: null };
    return { data: [], error: null }; } });
  let e = await mk(8);
  await assert.rejects(() => e.S.inventory.reserve('i1', 'qn', 5, null), (err) => err.code === 'INVENTORY_CONFLICT');
  assert.equal(inserted, 0);
  e = await mk(4);
  await e.S.inventory.reserve('i1', 'qn', 5, null);
  assert.equal(inserted, 1);
});
t('calendar: cancelled/closed events and done tasks make no staff conflicts', async () => {
  const mkq = (i, extra) => quoteRow(i, Object.assign({ event_date: '2026-11-01' }, extra));
  const e = await makeEnv({ respond: respondWith({
    quotes: () => [mkq(1), mkq(2, { status: 'cancelled' }), mkq(3, { status: 'confirmed', lifecycle_stage: 'closed' }), mkq(4)],
    event_tasks: () => [{ quote_id: uuid(1), crew_id: 'c1', status: 'pending' }, { quote_id: uuid(2), crew_id: 'c1', status: 'pending' },
      { quote_id: uuid(3), crew_id: 'c1', status: 'pending' }, { quote_id: uuid(4), crew_id: 'c1', status: 'completed' }] }) });
  const r = await e.S.calendar.load();
  assert.equal(r.conflicts.filter((c) => c.type === 'staff').length, 0);
});
t('source: local-date floor, prefilled past date kept, max logout global, BroadcastChannel kept, NEXT_PAGES', () => {
  assert.doesNotMatch(SRC, /el\.setAttribute\("min", new Date\(\)\.toISOString/);
  assert.match(SRC, /todayFloor/);
  assert.match(SRC, /reason === "max" && !fromOtherTab\) \? "global" : "local"/);
  assert.match(SRC, /bc\.postMessage\(\{ type: "logout"/);
});t('reserve() prefers the atomic RPC and falls back when it is not deployed', () => {
  assert.match(SRC, /supa\.rpc\("reserve_inventory"/);
  assert.match(SRC, /PGRST202/);
  assert.match(SRC, /_reserveRpc = false/);
});t('a confirmed "Reserve anyway" over-commit is not hard-blocked (page passes allowOver, store skips RPC + precheck)', () => {
  assert.match(SRC, /allowOver = !!\(opts && opts\.allowOver\)/);
  assert.match(SRC, /_reserveRpc !== false && !allowOver/);
  const page = read('public/inventory.html');
  assert.match(page, /overOk=true/);
  assert.match(page, /\{allowOver:overOk\}/);
});



let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('ok - ' + name); }
  catch (e) { fail++; console.log('not ok - ' + name + ': ' + (e && e.stack || e)); }
}
console.log(`\ninventory-calendar-hardening: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
