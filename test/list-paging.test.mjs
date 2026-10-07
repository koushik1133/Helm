// list-paging.test.mjs — list views never download a whole table (perf, Oct 2026).
// The production DB is ~250 ms from its users, so every list read is paged and light:
//  * store-api list pages ask for limit+1 rows (range) with ONLY the columns a list shows
//    (quotes: no pricing JSON — just its total + client), keep sort / filters / search on
//    the server (ilike, with % _ \ escaped), and mirror the same contract offline
//  * KPI counters are HEAD count queries (no rows travel)
//  * chat history: latest 50, older pages by keyset (created_at, id) on scroll-up
//  * the audit log pages by keyset; the CRM archive drops the snapshot JSON
//  * BPUI.pager: Load more + IntersectionObserver auto-load, loading / end states,
//    stale responses after a reset are dropped, repeated rows are skipped
//  * the pages use the paged APIs (no unbounded quotes.list() on the dashboard / quotes list)
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
      return Promise.resolve({ data: null, error: null });
    },
    from(table) {
      const q = { table, calls: [] };
      const rec = (m) => (...a) => { q.calls.push([m, ...a]); return b; };
      const b = {};
      ['select', 'eq', 'neq', 'is', 'not', 'or', 'in', 'lt', 'lte', 'gt', 'gte', 'like', 'ilike', 'filter', 'contains', 'order', 'range', 'limit']
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

/* ------------------------------------------------------------ quotes */
t('quotes.page: light columns only (no pricing JSON), limit+1 via range, newest first', async () => {
  const e = await makeEnv({ respond: () => ({ data: Array.from({ length: 26 }, (_, i) => quoteRow(i)), error: null }) });
  const p = await e.S.quotes.page({});
  const q = e.q.find((x) => x.table === 'quotes');
  const cols = call(q, 'select')[1];
  assert.ok(!/(^|,)pricing(,|$)/.test(cols) && !/\*/.test(cols), 'never the whole pricing column / select *: ' + cols);
  assert.match(cols, /total:pricing->total/);
  assert.match(cols, /client_name:client->>name/);
  assert.doesNotMatch(cols, /(^|,)client(,|$)/, 'not the whole client JSON either');
  assert.deepEqual(call(q, 'range').slice(1), [0, 25], 'first page = rows 0..25 (25 + 1 to learn hasMore)');
  assert.deepEqual(calls(q, 'order').map((c) => [c[1], c[2].ascending]), [['updated_at', false], ['id', false]]);
  assert.equal(p.rows.length, 25); assert.equal(p.hasMore, true); assert.equal(p.offset, 25);
  assert.equal(p.rows[0].total, 125000); assert.equal(p.rows[0].pricing.total, 125000);
  assert.equal(p.rows[0].pricing.client.name, 'Client 0'); assert.equal(p.rows[0].client.name, 'Client 0');
});
t('quotes.page: next page offset, configurable page size, end of list', async () => {
  const e = await makeEnv({ cfg: { pageSize: 10 }, respond: () => ({ data: Array.from({ length: 4 }, (_, i) => quoteRow(i)), error: null }) });
  assert.equal(e.S.quotes.PAGE_SIZE, 10);
  const p = await e.S.quotes.page({ offset: 30 });
  assert.deepEqual(call(e.q[0], 'range').slice(1), [30, 40]);
  assert.equal(p.hasMore, false); assert.equal(p.offset, 34);
});
t('quotes.page: tab views + type + search run on the server; confirmed-first sort', async () => {
  const e = await makeEnv({ ss: { bp_q_shelf: '1' } });
  await e.S.quotes.page({ view: 'active', eventType: 'Wed_ding', search: ' 50%_off\\x ', sort: 'confirmedFirst' });
  const q = e.q[0];
  assert.deepEqual(call(q, 'neq').slice(1), ['status', 'cancelled']);
  const ors = calls(q, 'or').map((c) => c[1]);
  assert.ok(ors.includes('lifecycle_stage.is.null,lifecycle_stage.neq.closed,status.neq.confirmed'), 'not closed+confirmed');
  assert.ok(calls(q, 'is').some((c) => c[1] === 'archived_at' && c[2] === null) && calls(q, 'is').some((c) => c[1] === 'deleted_at' && c[2] === null), 'shelved quotes stay out (0040)');
  assert.deepEqual(call(q, 'ilike').slice(1), ['event_type', 'Wed\\_ding'], 'type = case-insensitive exact, _ escaped');
  const s = ors.find((x) => x.includes('ilike'));
  assert.equal(s, 'code.ilike."%50\\\\%\\\\_off\\\\\\\\x%",title.ilike."%50\\\\%\\\\_off\\\\\\\\x%",client->>name.ilike."%50\\\\%\\\\_off\\\\\\\\x%"',
    'trimmed, % _ \\ escaped for LIKE, then quoted for or=()');
  assert.deepEqual(calls(q, 'order').map((c) => [c[1], c[2].ascending]), [['status', true], ['updated_at', false], ['id', false]]);
  const e2 = await makeEnv({ ss: { bp_q_shelf: '1' } });
  await e2.S.quotes.page({ view: 'archived', sort: 'confirmedFirst' });
  assert.ok(calls(e2.q[0], 'or').some((c) => c[1] === 'status.eq.cancelled,and(lifecycle_stage.eq.closed,status.eq.confirmed),archived_at.not.is.null'));
  assert.deepEqual(call(e2.q[0], 'order').slice(1, 2), ['status']); assert.equal(call(e2.q[0], 'order')[2].ascending, false, 'archive: closed-confirmed above cancelled');
  const e3 = await makeEnv({ ss: { bp_q_shelf: '1' } });
  await e3.S.quotes.page({ view: 'attention' });
  assert.ok(call(e3.q[0], 'lt') && call(e3.q[0], 'lt')[1] === 'event_date' && /^\d{4}-\d\d-\d\d$/.test(call(e3.q[0], 'lt')[2]));
  const e4 = await makeEnv({ ss: { bp_q_shelf: '1' } });
  await e4.S.quotes.page({ search: '*' });
  assert.ok(!calls(e4.q[0], 'or').length, 'a search of only * (PostgREST wildcard) is blank, not "match all"');
});
t('quotes.page: a database without the 0040 columns → retried without them, remembered for the tab', async () => {
  let n = 0;
  const e = await makeEnv({ respond: (q) => { n++; const c = call(q, 'select')[1];
    return /archived_at/.test(c) ? { data: null, error: { code: '42703', message: 'column quotes.archived_at does not exist' } } : { data: [quoteRow(1)], error: null }; } });
  const p = await e.S.quotes.page({ view: 'active' });
  assert.equal(p.rows.length, 1); assert.equal(n, 2);
  assert.equal(e.ss.getItem('bp_q_shelf'), '0');
  assert.ok(!calls(e.q[1], 'is').length, 'retry names no shelf column');
  await e.S.quotes.page({ view: 'active' });
  assert.equal(n, 3, 'next page goes straight to the old-schema query');
});
t('0040 present: moved quotes (archived_at / deleted_at) are excluded server-side from page / list / counts / dashboard', async () => {
  const e = await makeEnv({ respond: (q) => ({ data: q.calls.some((c) => c[0] === 'select' && c[2] && c[2].head) ? null : [quoteRow(1, { archived_at: null, deleted_at: null })], error: null, count: 3 }) });
  const moved = (q) => ['archived_at', 'deleted_at'].every((col) => calls(q, 'is').some((c) => c[1] === col && c[2] === null));
  await e.S.quotes.page({ sort: 'updated' });                 // dashboard "Your quotes" (view all)
  await e.S.quotes.page({ view: 'active' });
  await e.S.quotes.list();
  await e.S.quotes.counts();
  assert.equal(e.q.length, 6, 'one request each (+3 HEAD counts), no retries');
  e.q.forEach((q, i) => assert.ok(moved(q), 'query ' + i + ' excludes moved quotes'));
  assert.match(call(e.q[0], 'select')[1], /archived_at/);
  assert.equal(e.ss.getItem('bp_q_shelf'), '1', 'capability learned once per tab');
  const a = await makeEnv({ ss: { bp_q_shelf: '1' } });
  await a.S.quotes.page({ view: 'archived' }); await a.S.quotes.page({ view: 'deleted' });
  assert.ok(!calls(a.q[0], 'is').some((c) => c[1] === 'archived_at'), 'Archive tab keeps flagged-archived rows');
  assert.ok(calls(a.q[1], 'not').some((c) => c[1] === 'deleted_at'), 'Deleted tab = flagged deleted');
});
t('0040 absent (400 / 42703): page / list / counts retry once without the filter and keep working', async () => {
  let n = 0;
  const e = await makeEnv({ respond: (q) => { n++;
    const usesShelf = q.calls.some((c) => (c[0] === 'is' || c[0] === 'not') && /archived_at|deleted_at/.test(c[1])) || /archived_at/.test(call(q, 'select')[1]);
    if (usesShelf) return { data: null, error: { code: '42703', message: 'column quotes.deleted_at does not exist' } };
    return { data: call(q, 'select')[2] && call(q, 'select')[2].head ? null : [quoteRow(1)], error: null, count: 2 }; } });
  const l = await e.S.quotes.list();
  assert.equal(l.length, 1); assert.equal(e.ss.getItem('bp_q_shelf'), '0');
  assert.doesNotMatch(call(e.q[1], 'select')[1], /\*/, 'falls back to the light columns, not select *');
  const before = n;
  const p = await e.S.quotes.page({ sort: 'updated' });
  const c = await e.S.quotes.counts();
  assert.equal(p.rows.length, 1); assert.equal(c.total, 2);
  assert.equal(n - before, 4, 'after the first probe: no more failing requests (1 page + 3 counts)');
  e.q.slice(2).forEach((q) => assert.ok(!calls(q, 'is').length, 'no shelf filter on a pre-0040 database'));
  await e.S.quotes.page({ view: 'deleted' });   // pre-0040 there is no Deleted shelf: ask for an impossible id (→ empty)
  assert.deepEqual(J(call(e.q[e.q.length - 1], 'eq').slice(1)), ['id', '00000000-0000-0000-0000-000000000000']);
});
t('quotes.counts: HEAD count queries only (no rows), moved quotes excluded', async () => {
  const e = await makeEnv({ ss: { bp_q_shelf: '1' }, respond: (q) => ({ data: null, error: null,
    count: call(q, 'eq') ? (call(q, 'eq')[2] === 'confirmed' ? 40 : 9) : 120 }) });
  const c = await e.S.quotes.counts();
  assert.deepEqual(JSON.parse(JSON.stringify(c)), { total: 120, confirmed: 40, cancelled: 9, quote: 71 });
  assert.equal(e.q.length, 3);
  e.q.forEach((q) => { const s = call(q, 'select'); assert.equal(s[1], 'id'); assert.equal(s[2].head, true); assert.equal(s[2].count, 'exact');
    assert.ok(calls(q, 'is').some((x) => x[1] === 'deleted_at') && calls(q, 'is').some((x) => x[1] === 'archived_at')); });
});
t('quotes.list (pickers / calendar) is light too; nextCodeFor reads only that day\'s codes', async () => {
  const e = await makeEnv({ respond: (q) => (call(q, 'like') ? { data: [{ code: '10072026-01' }, { code: '10072026-07' }], error: null } : { data: [quoteRow(1)], error: null }) });
  await e.S.quotes.list();
  assert.doesNotMatch(call(e.q[0], 'select')[1], /\*|(^|,)pricing(,|$)/);
  const code = await e.S.quotes.nextCodeFor(new Date(2026, 9, 7));
  assert.equal(code, '10072026-08');
  assert.deepEqual(call(e.q[1], 'like').slice(1), ['code', '10072026-%']);
  assert.equal(call(e.q[1], 'select')[1], 'code');
});
t('offline (localStorage) mode mirrors page / counts / filters / search / order', async () => {
  const mk = (i, o) => Object.assign({ id: 'q' + String(i).padStart(3, '0'), code: 'C' + i, title: 'T' + i, eventType: i % 2 ? 'Wedding' : 'Corporate',
    status: 'quote', updatedAt: '2026-10-' + String(1 + (i % 28)).padStart(2, '0') + 'T00:00:00Z', pricing: { total: i }, client: { name: 'N' + i }, versions: [] }, o || {});
  const rows = Array.from({ length: 40 }, (_, i) => mk(i));
  rows[3].status = 'confirmed'; rows[4].status = 'cancelled'; rows[5].status = 'confirmed'; rows[5].lifecycleStage = 'closed';
  const e = await makeEnv({ local: true, ls: { 'bps.quotes': JSON.stringify(rows) } });
  assert.equal(e.S.mode(), 'local');
  const p1 = await e.S.quotes.page({ view: 'active', sort: 'confirmedFirst' });
  assert.equal(p1.rows.length, 25); assert.equal(p1.hasMore, true);
  assert.equal(p1.rows[0].status, 'confirmed', 'confirmed first');
  assert.ok(!p1.rows.some((r) => r.id === 'q004' || r.id === 'q005'), 'archived excluded from active');
  const p2 = await e.S.quotes.page({ view: 'active', sort: 'confirmedFirst', offset: p1.offset });
  assert.equal(p1.rows.length + p2.rows.length, 38); assert.equal(p2.hasMore, false);
  const arch = await e.S.quotes.page({ view: 'archived', sort: 'confirmedFirst' });
  assert.deepEqual(J(arch.rows.map((r) => r.id)), ['q005', 'q004']);
  const s = await e.S.quotes.page({ search: 'n1', eventType: 'wedding' });
  assert.ok(s.rows.length && s.rows.every((r) => /N1/.test(r.client.name) && r.eventType === 'Wedding'));
  const c = await e.S.quotes.counts();
  assert.equal(c.total, 40); assert.equal(c.confirmed, 2); assert.equal(c.cancelled, 1);
  assert.equal(e.q.length, 0, 'no network in offline mode');
});

/* ------------------------------------------------------------ chat */
t('chat.thread: the LATEST 50 (desc + limit 51, shown oldest→newest), hasMore', async () => {
  const msgs = Array.from({ length: 51 }, (_, i) => ({ id: 'm' + String(100 - i).padStart(3, '0'), created_at: '2026-10-07T10:' + String(59 - i).padStart(2, '0') + ':00Z' }));
  const e = await makeEnv({ respond: (q) => (q.table === 'chat_messages' ? { data: msgs, error: null } : { data: [], error: null }) });
  const th = await e.S.chat.thread('c1');
  const q = e.q.find((x) => x.table === 'chat_messages');
  assert.deepEqual(calls(q, 'order').map((c) => [c[1], c[2].ascending]), [['created_at', false], ['id', false]]);
  assert.equal(call(q, 'limit')[1], 51);
  assert.equal(th.messages.length, 50); assert.equal(th.hasMore, true);
  assert.ok(th.messages[0].created_at < th.messages[49].created_at, 'oldest → newest for rendering');
  assert.equal(th.messages[49].id, 'm100', 'the newest message is included');
  assert.ok(e.q.some((x) => x.table === 'chat_reactions') && e.q.some((x) => x.table === 'chat_members'));
});
t('chat.thread: older page by keyset (before a message), light preview mode skips reactions', async () => {
  const e = await makeEnv();
  await e.S.chat.thread('c1', 50, { before: { id: 'm050', created_at: '2026-10-07T10:00:00.5+00:00' } });
  const q = e.q.find((x) => x.table === 'chat_messages');
  assert.equal(call(q, 'or')[1], 'created_at.lt."2026-10-07T10:00:00.5+00:00",and(created_at.eq."2026-10-07T10:00:00.5+00:00",id.lt."m050")');
  assert.ok(!e.q.some((x) => x.table === 'chat_members'), 'members are not re-read for history pages');
  const e2 = await makeEnv({ respond: (q) => (q.table === 'chat_messages' ? { data: [{ id: 'a', created_at: 'x' }], error: null } : { data: [], error: null }) });
  await e2.S.chat.thread('c1', 80, { light: true });
  assert.equal(call(e2.q[0], 'limit')[1], 81);
  assert.ok(!e2.q.some((x) => x.table === 'chat_reactions'));
  const e3 = await makeEnv();
  await e3.S.chat.thread('c1', 50, { since: '2026-10-01T00:00:00Z' });
  assert.deepEqual(call(e3.q[0], 'gte').slice(1), ['created_at', '2026-10-01T00:00:00Z']);
});
t('chat.thread offline: same windows over localStorage', async () => {
  const m = Array.from({ length: 70 }, (_, i) => ({ id: 'm' + String(i).padStart(3, '0'), conversation_id: 'c1', created_at: '2026-10-07T10:' + String(i % 60).padStart(2, '0') + ':' + (i < 60 ? '00' : '30') + 'Z' }));
  const e = await makeEnv({ local: true, ls: { bp_chat_msg: JSON.stringify(m), bp_chat_conv: JSON.stringify([{ id: 'c1', members: [] }]) } });
  const a = await e.S.chat.thread('c1');
  assert.equal(a.messages.length, 50); assert.equal(a.hasMore, true);
  const b = await e.S.chat.thread('c1', 50, { before: a.messages[0] });
  assert.equal(b.messages.length, 20); assert.equal(b.hasMore, false);
  assert.ok(b.messages[19].created_at <= a.messages[0].created_at);
  assert.equal(new Set(a.messages.concat(b.messages).map((x) => x.id)).size, 70, 'no gaps, no repeats');
});

/* ------------------------------------------------------------ other lists */
t('audit.page: keyset on (at, id), server search, 50 per page; areas no longer read the whole log', async () => {
  const e = await makeEnv();
  await e.S.audit.page({ limit: 50, search: 'quo_te', after: { at: '2026-10-07T10:00:00+00:00', id: 'a9' } });
  const q = e.q[0];
  assert.equal(call(q, 'limit')[1], 51);
  const ors = calls(q, 'or').map((c) => c[1]);
  assert.ok(ors.includes('at.lt."2026-10-07T10:00:00+00:00",and(at.eq."2026-10-07T10:00:00+00:00",id.lt."a9")'));
  assert.ok(ors.some((x) => /^actor_email\.ilike\."%quo\\\\_te%"/.test(x) && x.includes('changed->>code.ilike')));
  await e.S.audit.entities();
  assert.equal(call(e.q[1], 'limit')[1], 1000);
});
t('leads.page: one stage column, column total from the same request, server search', async () => {
  const e = await makeEnv({ respond: () => ({ data: [{ id: 'l1', status: 'new' }], error: null, count: 61 }) });
  const p = await e.S.leads.page({ status: 'new', search: 'ravi', count: true });
  const q = e.q[0];
  assert.deepEqual(J(call(q, 'select')[2]), { count: 'exact' });
  assert.deepEqual(call(q, 'eq').slice(1), ['status', 'new']);
  assert.match(call(q, 'or')[1], /^name\.ilike\."%ravi%",phone\.ilike/);
  assert.equal(p.total, 61);
  await e.S.leads.contacts();
  assert.equal(call(e.q[1], 'select')[1], 'id,name,phone,email', 'duplicate check reads four short columns');
});
t('CRM archive: no snapshot JSON; "latest per lead" keeps only each lead\'s newest snapshot', async () => {
  const page = [{ id: 'r1', lead_id: 'L1', archived_at: '3' }, { id: 'r2', lead_id: 'L2', archived_at: '2' }, { id: 'r3', lead_id: null, archived_at: '1' }];
  const e = await makeEnv({ respond: (q) => (call(q, 'in') ? { data: [{ id: 'r9', lead_id: 'L1' }, { id: 'r1', lead_id: 'L1' }, { id: 'r2', lead_id: 'L2' }], error: null } : { data: page, error: null }) });
  const p = await e.S.leads.archivePage({ latest: true, stage: 'won' });
  assert.doesNotMatch(call(e.q[0], 'select')[1], /snapshot|\*/);
  assert.deepEqual(call(e.q[0], 'eq').slice(1), ['status', 'won']);
  assert.deepEqual(J(p.rows.map((r) => r.id)), ['r2', 'r3'], 'r1 is not L1\'s newest snapshot (r9 is) → dropped');
});
t('nurture / staff / vendors pages: ordered, limited, filters on the server; due badge is a HEAD count', async () => {
  const e = await makeEnv();
  await e.S.nurture.page({});
  assert.deepEqual(call(e.q[0], 'range').slice(1), [0, 25]);
  await e.S.nurture.dueCount('2026-10-07');
  assert.equal(call(e.q[1], 'select')[2].head, true); assert.deepEqual(call(e.q[1], 'lte').slice(1), ['next_followup', '2026-10-07']);
  await e.S.staff.page({ dept: 'Stage', skill: 'Rigging', ids: ['a', 'b'], search: 'mo' });
  const s = e.q[2];
  assert.deepEqual(call(s, 'filter').slice(1), ['skills', 'cs', '["Rigging"]'], 'jsonb array containment');
  assert.deepEqual(call(s, 'in').slice(1), ['id', ['a', 'b']]);
  assert.match(call(s, 'or')[1], /,skills\.cs\."\[\\"mo\\"\]"$/);
  await e.S.vendors.page({ kind: 'rental', search: 'tent' });
  assert.deepEqual(call(e.q[3], 'eq', 1), ['eq', 'active', true]);
  assert.match(call(e.q[3], 'or')[1], /services\.cs\./);
  assert.deepEqual(call(e.q[3], 'range').slice(1), [0, 25]);
});

/* ------------------------------------------------------------ BPUI.pager */
// lift pager() out of the BPUI block and drive it with a tiny fake DOM
function fnSrc(src, name) {
  const start = src.indexOf('  function ' + name + '('); assert.ok(start >= 0, name);
  let i = src.indexOf('{', src.indexOf(')', start)), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; }
  return src.slice(start, i + 1);
}
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.hidden = false; this.parentNode = null; this.listeners = {}; this.textContent = ''; this.isConnected = true; this.offsetParent = {}; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'hidden') this.hidden = true; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  insertBefore(c, ref) { c.parentNode = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  removeChild(c) { this.children = this.children.filter((x) => x !== c); c.parentNode = null; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  click() { (this.listeners.click || []).forEach((f) => f()); }
  getBoundingClientRect() { return { top: this.top == null ? 5000 : this.top, bottom: (this.top == null ? 5000 : this.top) + 20 }; }
  text() { return (this.textContent || '') + this.children.map((c) => c.text()).join(''); }
  find(pred) { if (pred(this)) return this; for (const c of this.children) { const f = c.find(pred); if (f) return f; } return null; }
}
function makePager(opts) {
  const ios = [];
  const ctx = {
    doc: { createElement: (t) => new El(t), createTextNode: (s) => { const n = new El('#text'); n.textContent = s; return n; } },
    global: { innerHeight: 800, IntersectionObserver: function (cb) { const o = { cb, observe(el) { o.el = el; }, disconnect() {} }; ios.push(o); return o; } },
    setTimeout: (f) => f(), clearTimeout() {}, injectCSS() {}, friendlyError: (e) => String((e && e.message) || e),
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc(SRC, 'h') + fnSrc(SRC, 'pager') + '; globalThis.pager = pager;', ctx);
  const host = new El('div'), list = new El('div'); host.appendChild(list);
  const p = ctx.pager(Object.assign({ after: list }, opts));
  return { p, foot: p.el, ios };
}
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };
const deferred = () => { let res, rej; const p = new Promise((a, b) => { res = a; rej = b; }); return { p, res, rej }; };

t('pager: reset → first page, Load more → next offset (appended), end of list', async () => {
  const seen = [], painted = [];
  const pages = { 0: { rows: [{ id: 1 }, { id: 2 }], hasMore: true, offset: 2 }, 2: { rows: [{ id: 3 }], hasMore: false, offset: 3 } };
  const { p, foot } = makePager({ fetch: (off) => { seen.push(off); return Promise.resolve(pages[off]); }, render: (rows, info) => painted.push([rows.map((r) => r.id), info.reset, info.all.length]) });
  assert.equal(foot.parentNode.children.indexOf(foot), 1, 'footer sits right after the list');
  await p.reset();
  assert.deepEqual(painted[0], [[1, 2], true, 2]);
  const btn = foot.find((n) => n.attrs['data-bpui-more'] != null); assert.ok(btn, 'Load more button');
  btn.click(); await flush();
  assert.deepEqual(seen, [0, 2]);
  assert.deepEqual(painted[1], [[3], false, 3]);
  assert.match(foot.text(), /End of list · 3 shown/);
  assert.equal(p.hasMore(), false);
});
t('pager: shows a loading row while a page is in flight', async () => {
  const d = deferred();
  const { p, foot } = makePager({ fetch: () => d.p, render() {} });
  const r = p.reset();
  assert.equal(foot.hidden, false); assert.match(foot.text(), /Loading/);
  assert.equal(p.loading(), true);
  d.res({ rows: [], hasMore: false, offset: 0 }); await r;
  assert.equal(foot.hidden, true, 'empty list → the page shows its own empty state');
});
t('pager: a response from before the latest reset is dropped (fast typing never paints stale rows)', async () => {
  const a = deferred(), b = deferred(); let n = 0; const painted = [];
  const { p } = makePager({ fetch: () => (n++ === 0 ? a.p : b.p), render: (rows) => painted.push(rows.map((r) => r.id)) });
  p.reset(); const second = p.reset();
  b.res({ rows: [{ id: 'new' }], hasMore: false, offset: 1 }); await second;
  a.res({ rows: [{ id: 'old' }], hasMore: false, offset: 1 }); await flush();
  assert.deepEqual(painted, [['new']]);
  assert.deepEqual(J(p.rows().map((r) => r.id)), ['new']);
});
t('pager: rows repeated across pages are skipped; IntersectionObserver auto-loads; errors offer Retry', async () => {
  let fail = true;
  const pages = { 0: { rows: [{ id: 1 }, { id: 2 }], hasMore: true, offset: 2 }, 2: { rows: [{ id: 2 }, { id: 3 }], hasMore: true, offset: 4 }, 4: { rows: [{ id: 4 }], hasMore: false, offset: 5 } };
  const { p, foot, ios } = makePager({ fetch: (off) => (off === 4 && fail ? Promise.reject(new Error('Failed to fetch')) : Promise.resolve(pages[off])), render() {} });
  await p.reset();
  assert.equal(ios.length, 1); assert.equal(ios[0].el, foot, 'the footer is observed');
  ios[0].cb([{ isIntersecting: true }]); await flush();
  assert.deepEqual(J(p.rows().map((r) => r.id)), [1, 2, 3], 'id 2 (shifted by a new insert) shown once');
  ios[0].cb([{ isIntersecting: true }]); await flush();
  assert.match(foot.text(), /Couldn’t load more/);
  fail = false; foot.find((n) => n.tag === 'button').click(); await flush();
  assert.deepEqual(J(p.rows().map((r) => r.id)), [1, 2, 3, 4]);
  p.remove(3); assert.deepEqual(J(p.rows().map((r) => r.id)), [1, 2, 4]);
});
t('pager: a first-page error rejects reset() so the page can show its own error card', async () => {
  const { p } = makePager({ fetch: () => Promise.reject(new Error('boom')), render() {} });
  await assert.rejects(p.reset(), /boom/);
});

/* ------------------------------------------------------------ pages */
const page = (f) => read('public/' + f);
t('dashboard: "Your quotes" is paged; KPIs from counts(); no unbounded quotes.list()', () => {
  const h = page('dashboard.html');
  assert.doesNotMatch(h, /quotes\.list\(/);
  assert.match(h, /BPUI\.pager\(\{ after: \$\("#elist"\)/);
  assert.match(h, /BPStore\.quotes\.page\(\{ offset, sort: "updated" \}\)/);
  assert.match(h, /BPStore\.quotes\.counts\(\)/);
  assert.match(h, /BPStore\.quotes\.nextCodeFor\(\)/);
});
t('quotes list: server-paged tabs / type / search (debounced 300 ms)', () => {
  const h = page('quotes.html');
  assert.doesNotMatch(h, /quotes\.list\(/);
  assert.match(h, /BPStore\.quotes\.page\(\{ offset, view:viewOf\(filter\), eventType:typeFilter, search:/);
  assert.match(h, /\$\("#search"\)\.addEventListener\("input",BPUI\.debounce\(reloadQuiet,300\)\)/);
  assert.match(h, /BPStore\.quotes\.eventTypes\(\)/);
});
t('chat: latest 50 on open, older on scroll-up keeping the reader\'s place', () => {
  const h = page('chat.html');
  assert.match(h, /const THREAD_PAGE=50;/);
  assert.match(h, /BPStore\.chat\.thread\(conv,THREAD_PAGE,\{before:first\}\)/);
  assert.match(h, /fromBottom=host\.scrollHeight-host\.scrollTop/);
  assert.match(h, /host\.scrollTop=Math\.max\(0,host\.scrollHeight-o\.keepFromBottom\)/);
  assert.match(h, /h\.scrollTop<120&&thread\.hasMore/);
  assert.doesNotMatch(h, /chat\.thread\(activeId\)/);
});
t('leads / crm / nurture / staff / vendors / audit use the paged APIs', () => {
  assert.match(page('leads.html'), /BPStore\.leads\.page\(\{status:s\.k, search:term, count:true/);
  assert.doesNotMatch(page('leads.html'), /leads\.list\(/);
  assert.match(page('crm.html'), /BPStore\.leads\.archivePage\(/);
  assert.doesNotMatch(page('crm.html'), /leads\.archive\(\)/);
  assert.match(page('nurture.html'), /BPStore\.nurture\.page\(\{ offset \}\)/);
  assert.match(page('nurture.html'), /BPStore\.nurture\.dueCount\(td\)/);
  assert.match(page('staff.html'), /BPStore\.staff\.page\(/);
  assert.doesNotMatch(page('staff.html'), /staff\.list\(/);
  assert.match(page('vendors.html'), /BPStore\.vendors\.page\(/);
  assert.doesNotMatch(page('vendors.html'), /bookings\.listAll\(\)|quotes\.list\(\)/);
  assert.match(page('audit.html'), /BPStore\.audit\.page\(/);
});

/* ------------------------------------------------------------ payload: before / after */
t('dashboard payload for 200 realistic quotes: before (select * every row) vs after (one light page)', async () => {
  // a realistic stored quote: client + priced snapshot (inputs + server-computed breakdown + client copy)
  const P = (await makeEnv()).S.pricing;
  const full = (i) => {
    const client = { name: 'Client ' + i + ' Sharma', company: 'Sharma Events Pvt Ltd', email: 'client' + i + '@example.in', phone: '+91 98765 4' + String(i).padStart(4, '0'),
      eventDate: '2026-11-' + String(1 + (i % 28)).padStart(2, '0'), venue: 'Grand Palace Banquet Hall', address: 'Plot 12, Road No. 36, Jubilee Hills, Hyderabad 500033', notes: 'Stage facing east; VIP seating front 3 rows.' };
    const pricing = { chairs: 450, chairPrice: 200, guests: 450, platePrice: 650, gstPct: 18, other: 85000, serviceChargePct: 5, discount: 10000, discountPct: 0,
      couponCode: 'WED10', coupon: { kind: 'percent', value: 10 }, placeOfSupply: 'intra', currency: 'INR',
      catering: { mode: 'inhouse', vendor: 'Spice Route Caterers', amount: 25000, gstPct: 5 },
      // décor / equipment lines folded in from the layout (builder) — 8 typical lines
      items: Array.from({ length: 8 }, (_, k) => ({ label: 'Décor / equipment ' + k, qty: 1 + k, rate: 1500 + k * 250, amount: (1 + k) * (1500 + k * 250) })),
      client };
    pricing.computed = J(P.quoteTotal(pricing)); pricing.total = pricing.computed.total;
    return { id: uuid(i), code: '1107' + '2026-' + String(i).padStart(2, '0'), title: 'Sharma Wedding Reception ' + i, event_type: 'Wedding', status: i % 3 ? 'quote' : 'confirmed',
      client, pricing, current_version: 3, created_at: '2026-09-01T10:00:00.000000+00:00', updated_at: '2026-10-0' + (1 + (i % 7)) + 'T10:00:00.000000+00:00',
      confirmed_at: i % 3 ? null : '2026-10-02T10:00:00+00:00', confirmed_by: i % 3 ? null : uuid(900), approval_token: uuid(500 + i), approval_status: 'sent',
      manager_id: uuid(901), lifecycle_stage: 'quote', event_date: '2026-11-01', event_time: '18:30', org_id: uuid(999),
      approval_token_expires_at: '2026-11-01T00:00:00+00:00', approval_token_revoked_at: null };
  };
  const all = Array.from({ length: 200 }, (_, i) => full(i));
  // what PostgREST returns for a select list: plain columns + alias:col->a->>b json paths
  const project = (row, sel) => { const o = {}; sel.split(',').forEach((c) => { const m = /^(\w+):(\w+)((?:->>?\w+)+)$/.exec(c);
    if (!m) { o[c] = row[c] === undefined ? null : row[c]; return; }
    let v = row[m[2]]; m[3].split(/->>?/).filter(Boolean).forEach((k) => { v = v == null ? null : v[k]; }); o[m[1]] = v === undefined ? null : v; }); return o; };
  // project like PostgREST does for QUOTE_LIST_COLS (+ 0040 shelf columns)
  const e = await makeEnv({ ss: { bp_q_shelf: '1' }, respond: (q) => {
    const sel = call(q, 'select')[1]; const r = call(q, 'range');
    return { data: all.slice(r[1], r[2] + 1).map((row) => project(row, sel)), error: null }; } });
  await e.S.quotes.page({ sort: 'updated' });
  const sel = call(e.q[0], 'select')[1];
  const r = call(e.q[0], 'range');
  const afterRows = all.slice(r[1], r[2] + 1).map((row) => project(row, sel));
  const before = Buffer.byteLength(JSON.stringify(all));
  const after = Buffer.byteLength(JSON.stringify(afterRows));   // + 3 HEAD counts (no body) + today's codes (a few bytes)
  const kb = (n) => (n / 1024).toFixed(1) + ' KB';
  console.log(`   dashboard quotes payload, 200 quotes: before ${kb(before)} (${all.length} rows, select *) → after ${kb(after)} (${afterRows.length} rows, light columns) = ${(100 - after / before * 100).toFixed(1)}% smaller`);
  assert.ok(after * 10 < before, 'at least 10x smaller');
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('ok - ' + name); }
  catch (e) { fail++; console.log('not ok - ' + name + ': ' + (e && e.stack || e)); }
}
console.log(`\nlist-paging: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
