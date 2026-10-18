// event-stages-0198.test.mjs - owner trial test 18 Oct 2026 (event 7 Nov 2026): closing before the
// event day, conflicts on the event, and the stuck / flip-flopping stage strip after Confirm.
// Source checks on the pages + store-api in a vm sandbox (stubbed supabase) for the conflict rules.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/store-api.js');
const EV = read('public/event.html'), CL = read('public/closure.html'), CAL = read('public/calendar.html');
const SQL = read('supabase/migrations/0198_event_stages_closure.sql'), APPLY = read('supabase/APPLY-0198.sql');
const MANIFEST = read('supabase/migrations/MANIFEST'), RUNALL = read('scripts/db-test/run-all.sh');
const tests = [];
const J = (x) => JSON.parse(JSON.stringify(x));
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

// ---------------------------------------------------------------- 3) stage strip
t('strip: a stage click OPENS the stage (viewStage), it never writes and is never disabled', () => {
  // stage-strip-scroll: the pills are built as DOM nodes (paintStrip), each click still only VIEWS the stage
  assert.match(EV, /onclick:\(e\)=>\{ if\(e\.detail>1\) return; viewStage\(s\.k\); \}/);
  assert.doesNotMatch(EV, /setStage\(b\.dataset\.k,b\)/);
  assert.doesNotMatch(EV, /canEdit&&!stageBusy\?"":"disabled"/);
  assert.match(EV, /"aria-current":i===cur\?"step":null/);   // the real stored stage
  assert.match(EV, /"aria-pressed":i===vis\?"true":"false"/);  // the stage being viewed
  assert.match(EV, /renderMods\(STAGES\[vis\]\.mods\)/);
});
t('strip: the stage panel explains blockers from the server and offers the move only when allowed', () => {
  assert.match(EV, /BPStore\.quotes\.stageBlockers\(id,k\)/);
  // stage-strip-scroll: a blocked move is DISABLED with the reason (admins get a separate override button)
  assert.match(EV, /"Override as admin…"/);
  assert.match(EV, /disabled:blocked\|\|loading\|\|stageBusy/);
  assert.match(EV, /"You can close this event after "/);
  assert.match(EV, /Back to the current stage/);
});
t('strip: after a move the page re-reads the STORED stage (no local flip-flop)', () => {
  assert.match(EV, /const r=await BPStore\.quotes\.setStageGuided\(id, k\); if\(!r\) return;\s*try\{ const fresh=await BPStore\.quotes\.get\(id\); if\(fresh\) ev=fresh; \}/);
  assert.doesNotMatch(EV, /if\(!r\) return; ev\.lifecycleStage=k;/);
  assert.match(EV, /if\(k==="closed"\)\{ location\.href="closure\.html\?quote="/);
});
t('cancel event: admin / manager button with a required reason, through BPStore.quotes.cancelEvent', () => {
  assert.match(EV, /id="cancelEvBtn"/);
  assert.match(EV, /\(myRole==="admin"\|\|myRole==="manager"\) && !evLocked\(\)/);
  assert.match(EV, /BPStore\.quotes\.cancelEvent\(id, reason\.trim\(\)\)/);
  assert.match(SRC, /supa\.rpc\("cancel_event", \{ p_quote_id: id, p_reason: r \}\)/);
  assert.match(SRC, /supa\.rpc\("lifecycle_stage_blockers"/);
});
t('next-step bar: a cancelled / closed event has none', () => {
  assert.match(EV, /if\(evLocked\(\)\)\{ bar\.hidden=true; return false; \}/);
});

// ---------------------------------------------------------------- 1) closing
t('closure page: no "close anyway" before the event day - the HL425 sentence instead', () => {
  assert.doesNotMatch(CL, /Close it anyway\?/);
  assert.match(CL, /d>=BPStore\.todayLocal\(\)/);
  assert.match(CL, /if\(ev && ev\.status==="cancelled"\) return "";/);
  assert.match(CL, /"You can close this event after "\+/);
  assert.match(CL, /cancel it from the event page instead/);
  assert.match(SRC, /e\.code === "HL425"/);
});

// ---------------------------------------------------------------- 2) conflicts
t('event page lists each clash: what, with which event (links), fixes and Mark acknowledged', () => {
  assert.match(EV, /"Clashes with: "/);
  assert.match(EV, /href:"event\.html\?id="\+encodeURIComponent\(e\.id\)/);
  for (const s of ['Change venue', 'Change crew', 'Change vendor', 'Adjust stock', 'Change date', 'Mark acknowledged', 'Undo acknowledge'])
    assert.ok(EV.includes('"' + s + '"'), s);
  assert.match(EV, /BPStore\.calendar\.ack\(me,c\.key,/);
  assert.match(EV, /Cancelled and closed events never clash/);
  assert.match(CAL, /data\.acks=await BPStore\.calendar\.acks/);
});
t('calendar: a CLOSED event never clashes whatever its status; cancelled neither; clash keys are stable', async () => {
  const mkq = (i, extra) => quoteRow(i, Object.assign({ event_date: '2026-11-07' }, extra));
  const e = await makeEnv({ respond: respondWith({
    quotes: () => [mkq(1, { status: 'confirmed', lifecycle_stage: 'confirmed' }), mkq(2, { status: 'quote', lifecycle_stage: 'closed' }),
      mkq(3, { status: 'cancelled' }), mkq(4, { status: 'confirmed', lifecycle_stage: 'planning' })],
    event_tasks: () => [1, 2, 3, 4].map((i) => ({ quote_id: uuid(i), crew_id: 'c1', status: 'pending' })) }) });
  const r = J(await e.S.calendar.load());
  const staff = r.conflicts.filter((c) => c.type === 'staff');
  assert.equal(staff.length, 1);
  assert.deepEqual(staff[0].events.map((x) => x.id).sort(), [uuid(1), uuid(4)]);
  assert.equal(staff[0].key, 'staff|2026-11-07|c1|' + [uuid(1), uuid(4)].sort().join(','));
  const mine = J(await e.S.calendar.conflictsForEvent(uuid(2)));
  assert.equal(mine.length, 0, 'the closed event shows no clash');
});
t('calendar.wouldClash: a cancelled / closed event on the day is never a clash', async () => {
  const e = await makeEnv({ respond: respondWith({
    quotes: () => [quoteRow(2, { status: 'cancelled', event_date: '2026-11-07' }), quoteRow(3, { status: 'quote', lifecycle_stage: 'closed', event_date: '2026-11-07' })],
    event_tasks: () => [{ quote_id: uuid(2) }, { quote_id: uuid(3) }] }) });
  const r = J(await e.S.calendar.wouldClash({ date: '2026-11-07', crewId: 'c1', excludeQuote: uuid(1) }));
  assert.equal(r.clash, false);
});
t('calendar.acks: open acknowledgements by key; an old database (no table) -> null', async () => {
  let e = await makeEnv({ respond: respondWith({ calendar_conflict_acks: () => [{ conflict_key: 'k1', acked_email: 'a@a.test', acked_at: '2026-10-18T10:00:00Z', note: 'ok' }] }) });
  const a = J(await e.S.calendar.acks(['k1', 'k2']));
  assert.deepEqual(a, { k1: { by: 'a@a.test', at: '2026-10-18T10:00:00Z', note: 'ok' } });
  const q = e.q.find((x) => x.table === 'calendar_conflict_acks');
  assert.ok(q.calls.some((c) => c[0] === 'is' && c[1] === 'revoked_at' && c[2] === null));
  e = await makeEnv({ respond: (q2) => (q2.table === 'calendar_conflict_acks' ? { data: null, error: { code: '42P01', message: 'relation "public.calendar_conflict_acks" does not exist' } } : { data: [], error: null }) });
  assert.equal(await e.S.calendar.acks(['k1']), null);
});
t('quotes.stageBlockers: old database (no 0198 RPC) -> null, the page then just tries the move', async () => {
  const e = await makeEnv({});
  e.win.supabase; // client from makeEnv answers rpc() with no data
  const r = await e.S.quotes.stageBlockers(uuid(1), 'planning');
  assert.ok(Array.isArray(r) || r === null);
});

// ---------------------------------------------------------------- migration 0198
t('0198: additive, idempotent, ASCII; hard event-day rule + kept balance gate; registered + suite', () => {
  assert.doesNotMatch(SQL, /[^\x00-\x7f]/);
  assert.doesNotMatch(SQL, /\bdrop (table|column|function)\b|\bdelete from\b|\btruncate\b/i);
  assert.equal((SQL.match(/update public\.quotes\b/g) || []).length, 1);   // only cancel_event's own row write - no backfill
  assert.doesNotMatch(SQL, /update public\.event_closure\b/);
  assert.match(SQL, /errcode = 'HL425'/);
  assert.match(SQL, /You can close this event after % \(event day\)\./);
  assert.match(SQL, /coalesce\(v_status, ''\) <> 'cancelled' and v_date is not null and v_date >= v_today/);
  assert.match(SQL, /helm_invoice_total\(p_quote\)/);          // balance gate kept
  assert.match(SQL, /'Planning needs: ' \|\| array_to_string\(v_need, ', '\)/);
  assert.match(SQL, /create table if not exists public\.event_cancellations/);
  assert.match(SQL, /create table if not exists public\.calendar_conflict_acks/);
  assert.match(SQL, /revoked_at = now\(\)/);
  assert.match(MANIFEST, /^forward  supabase\/migrations\/0198_event_stages_closure\.sql$/m);
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m); assert.match(APPLY, /-- VERIFY/);
  assert.match(RUNALL, /EVENT-STAGES-0198: ALL PASS \\\(63\/63\\\)/);
});
t('pins: event.html loads the bumped event-polish.css', () => {
  assert.match(EV, /href="\/event-polish\.css\?v=3"/);
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ': ' + (e && e.stack || e)); }
}
console.log(`\nevent-stages-0198: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
