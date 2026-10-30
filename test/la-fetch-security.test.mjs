// la-fetch-security.test.mjs - live audit 2026-10-18 items 23 / 25 / 44 + security gaps:
//  * list queries never fetch the client approval link (approval_token) or the whole client JSON
//  * one shared, short-lived, copy-on-read cache for start-up reads (quotes / leads / my_profile /
//    trial + demo status / bell_feed / chat directory), dropped by any write from this tab
//  * sidebar badges use HEAD counts, not whole lists
//  * link_expiry_shelf_tick at most once per 10 min per tab; chat_ensure_broadcast only on /chat, once
//  * bell poll: visibility-aware, slower on /chat (realtime drives it there)
//  * calendar event_tasks / event_plan / event_resources reads + the nurture_templates update carry an
//    explicit studio filter; reads are paged with the shared safety cap
//  * ?next= on /login never leaves the site (incl. pretty /<slug>/... paths)
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/store-api.js');
const SHELL = read('public/shell-b.js');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const grab = (re, what) => { const m = re.exec(SRC); assert.ok(m, what + ' not found'); return m[0]; };

/* ------------------------------------------------------------ 1. list columns (audit 23) */
const cols = (name) => { const m = new RegExp('const ' + name + ' = ((?:"[^"]*"\\s*\\+?\\s*)+);').exec(SRC); assert.ok(m, name); return vm.runInNewContext(m[1]); };
t('QUOTE_LIST_COLS: no approval_token, no whole client JSON, only the client fields a list shows', () => {
  const c = cols('QUOTE_LIST_COLS').split(',');
  assert.ok(!c.some((x) => /approval_token/.test(x)), 'approval_token in list columns');
  assert.ok(!c.includes('client'), 'whole client JSON in list columns');
  assert.ok(!c.some((x) => /^pricing_client:pricing->client$/.test(x)), 'whole pricing.client JSON in list columns');
  for (const k of ['client_name:client->>name', 'client_phone:client->>phone', 'client_venue:client->>venue', 'client_address:client->>address',
    'client_city:client->>city', 'approval_status', 'total:pricing->total']) assert.ok(c.includes(k), k + ' missing');
});
t('QUOTE_PAGE_COLS (dashboard / quotes pages) never fetch approval_token either', () => {
  assert.ok(!/approval_token/.test(cols('QUOTE_PAGE_COLS')));
});
// mapQuoteSummary over a narrowed row: the calendar still gets venue / address, the token is never there
const mapSrc = grab(/const nameOnly = [\s\S]*?\n  function mapQuoteSummary\(q\) \{[\s\S]*?\n  \}\n/, 'mapQuoteSummary');
const mapCtx = vm.createContext({});
vm.runInContext(mapSrc + '\nthis.mapQuoteSummary = mapQuoteSummary;', mapCtx);
t('mapQuoteSummary: narrowed list row -> client {name, phone, venue, address, city}; approvalToken absent', () => {
  const r = mapCtx.mapQuoteSummary({ id: 'q1', code: 'C', status: 'quote', approval_status: 'sent', client_name: 'Asha', client_phone: '+91 1',
    client_venue: 'Hall A', client_address: '1 Road', client_city: 'Pune', total: 100, pricing_client_name: 'Asha' });
  assert.deepEqual(JSON.parse(JSON.stringify(r.client)), { name: 'Asha', phone: '+91 1', venue: 'Hall A', address: '1 Road', city: 'Pune' });
  assert.equal(r.approvalToken, undefined);
  assert.equal(r.approvalStatus, 'sent');
  assert.equal(r.pricing.client.name, 'Asha');
  assert.equal(r.total, 100);
});
t('mapQuoteSummary: a full row (get / older select *) is unchanged', () => {
  const r = mapCtx.mapQuoteSummary({ id: 'q1', client: { name: 'B', email: 'b@x.test' }, pricing: { total: 5 }, approval_token: 'tok' });
  assert.equal(r.client.email, 'b@x.test'); assert.equal(r.approvalToken, 'tok'); assert.equal(r.total, 5);
});
t('every list consumer only reads client name / phone / venue / address (no e-mail etc. from list rows)', () => {
  for (const f of ['public/pick-event.js', 'public/builder.js', 'public/chat.html']) {
    const s = read(f);
    assert.doesNotMatch(s, /quotes\.list\(\)[\s\S]{0,400}client\.(email|notes|guests)/, f);
  }
});

/* ------------------------------------------------------------ 2. shared cache (audit 25) */
const memoSrc = grab(/  var _memo = new Map\(\);[\s\S]*?\n  const MEMO_LIST_MS = \d+;/, 'memo block');
function memoEnv(o = {}) {
  const ctx = vm.createContext({ mode: o.mode || 'supabase', currentUser: o.user === undefined ? { id: 'u1' } : o.user, Date, Promise, JSON, structuredClone, Map });
  vm.runInContext(memoSrc.replace('const MEMO_LIST_MS', 'var MEMO_LIST_MS') + '\nthis.memoRead = memoRead; this.memoClear = memoClear;', ctx);
  return ctx;
}
t('memoRead: callers a few seconds apart share ONE read', async () => {
  const E = memoEnv(); let n = 0; const fn = () => { n++; return Promise.resolve([{ id: 1 }]); };
  await E.memoRead('k', 8000, fn); await E.memoRead('k', 8000, fn); await E.memoRead('k', 8000, fn);
  assert.equal(n, 1);
});
t('memoRead: every caller gets its own copy (one page sorting / editing rows cannot change another\'s)', async () => {
  const E = memoEnv(); const fn = () => Promise.resolve([{ id: 1, t: 'a' }]);
  const a = await E.memoRead('k', 8000, fn); a[0].t = 'changed'; a.push({ id: 2 });
  const b = await E.memoRead('k', 8000, fn);
  assert.equal(b.length, 1); assert.equal(b[0].t, 'a');
});
t('memoRead: memoClear (any write from this tab) forces a fresh read', async () => {
  const E = memoEnv(); let n = 0; const fn = () => Promise.resolve(++n);
  assert.equal(await E.memoRead('k', 8000, fn), 1); E.memoClear(); assert.equal(await E.memoRead('k', 8000, fn), 2);
});
t('memoRead: expires after its ttl', async () => {
  const E = memoEnv(); let n = 0; const fn = () => Promise.resolve(++n);
  await E.memoRead('k', 1, fn); await new Promise((r) => setTimeout(r, 5)); assert.equal(await E.memoRead('k', 1, fn), 2);
});
t('memoRead: never shared across users; a failed read is not kept', async () => {
  const E = memoEnv(); let n = 0; const fn = () => Promise.resolve(++n);
  await E.memoRead('k', 8000, fn); E.currentUser = { id: 'u2' }; assert.equal(await E.memoRead('k', 8000, fn), 2);
  let f = 0; const bad = () => { f++; return f === 1 ? Promise.reject(new Error('net')) : Promise.resolve('ok'); };
  await assert.rejects(E.memoRead('b', 8000, bad)); assert.equal(await E.memoRead('b', 8000, bad), 'ok');
});
t('memoRead: local (offline) mode and signed-out never cache (local writes do not pass through fetch)', async () => {
  for (const E of [memoEnv({ mode: 'local' }), memoEnv({ user: null })]) {
    let n = 0; const fn = () => Promise.resolve(++n);
    await E.memoRead('k', 8000, fn); await E.memoRead('k', 8000, fn); assert.equal(n, 2);
  }
});
t('any write through the shared fetch drops the cache before AND after it runs; sign-in changes drop it too', () => {
  const cf = grab(/function coalescedFetch\(input, init\) \{[\s\S]*?\n  \}\n/, 'coalescedFetch');
  assert.match(cf, /if \(!isRead\) \{\s*readCache\.clear\(\); memoClear\(\);[\s\S]*?wp\.then\(after, after\); return wp;/);
  assert.match(SRC, /function sessClear\(\) \{[^\n]*swrClear\(\); memoClear\(\); \}/);
  assert.match(SRC, /obj\[k\] = function \(\) \{[^\n]*memoClear\(\); return fn\.apply/);
});
t('the start-up reads go through the shared cache', () => {
  assert.match(SRC, /list: \(\) => memoRead\("quotes\.list", MEMO_LIST_MS, \(\) => shareInflight\("quotes\.list"/);
  assert.match(SRC, /return memoRead\("leads\.list", MEMO_LIST_MS, \(\) => shareInflight\("leads\.list"/);
  assert.match(SRC, /return memoRead\("profile\.mine", 30000, \(\) => profile\._mineFetch\(\)\);/);
  assert.match(SRC, /memoRead\("trialorg", 15000, \(\) => swr\("trialorg"/);
  assert.match(SRC, /trial: \(\) => \(supa \? (?:trialSignedIn\(\)\.then\(\(ok\) => \(ok \? )?memoRead\("trial", 15000, \(\) => swr\("trial"/);   // anon-42501: signed-out pages skip it
  assert.match(SRC, /status: \(\) => \(supa \? memoRead\("demo", 15000, \(\) => swr\("demo"/);
  assert.match(SRC, /feed: \(limit\) => memoRead\("bell\.feed:" \+ \(limit \|\| ""\), 5000, \(\) => rpc\("bell_feed"/);
  assert.match(SRC, /return memoRead\("chat\.roster", 60000, \(\) => chat\._rosterFetch\(\)\);/);
});

t('boot-time STABLE RPCs coalesce as reads (they no longer drop the page\'s shared reads); writes still do', () => {
  const re = /const READ_RPCS = (\/[^\n]+\/);/.exec(SRC); const R = vm.runInNewContext(re[1]);
  const u = (n) => 'https://x.supabase.co/rest/v1/rpc/' + n;
  for (const n of ['my_trial_org', 'my_upgrade_status', 'my_trial_limits', 'my_trial_access', 'my_seat_usage', 'my_notification_prefs',
    'my_notification_mutes', 'my_studio_route', 'my_tasks', 'list_quote_shelf', 'chat_my_mentions', 'privacy_pin_status', 'bell_feed', 'my_profile'])
    assert.ok(R.test(u(n)), n + ' should be a read');
  for (const n of ['link_expiry_shelf_tick', 'chat_ensure_broadcast', 'update_my_profile', 'privacy_pin_check', 'privacy_pin_set', 'my_start_trial',
    'my_studio_account', 'my_checkout_status', 'mark_notifications_seen', 'my_trial_org_x'])
    assert.ok(!R.test(u(n)), n + ' must not be treated as a read');
});

/* ------------------------------------------------------------ 3. sidebar badges = HEAD counts */
t('store: leads.countNew + quotes.countAwaiting are HEAD counts with the badge rules', () => {
  assert.match(SRC, /async countNew\(\) \{\s*if \(mode === "supabase"\) return sbCount\(supa\.from\("leads"\)\.select\("id", \{ count: "exact", head: true \}\)\.or\("status\.is\.null,status\.eq\.new"\)\);/);
  const ca = grab(/async countAwaiting\(\) \{[\s\S]*?\n    \},/, 'countAwaiting');
  assert.match(ca, /select\("id", \{ count: "exact", head: true \}\)\.eq\("status", "quote"\)\.in\("approval_status", \["sent", "viewed"\]\)/);
  assert.match(ca, /if \(shelf\) q = q\.is\("archived_at", null\)\.is\("deleted_at", null\)/);
});
t('count methods are treated as reads (they do not drop shared reads like a write would)', () => {
  const re = /const READ_NAME = (\/[^\n]+\/);/.exec(SRC); const READ = vm.runInNewContext(re[1]);
  assert.ok(READ.test('countNew') && READ.test('countAwaiting'));
});
t('shell-b: sidebar badges use the counts when the store has them (no full lead / quote list per page)', () => {
  assert.match(SHELL, /typeof B\.leads\.countNew === "function"\) return Promise\.resolve\(B\.leads\.countNew\(\)\)\.then\(function \(n\) \{ railCount\("leads", n\); \}\)/);
  assert.match(SHELL, /typeof B\.quotes\.countAwaiting === "function"\) return Promise\.resolve\(B\.quotes\.countAwaiting\(\)\)\.then\(function \(n\) \{ railCount\("quotes", n\); \}\)/);
});

/* ------------------------------------------------------------ 4. page-open writes (audit 44) */
const tickSrc = grab(/    tick\(o\) \{[\s\S]*?\n    \},/, 'quoteShelf.tick');
function tickEnv(ss) {
  const calls = []; const store = new Map(Object.entries(ss || {}));
  const ctx = vm.createContext({ currentUser: { id: 'u1' }, Date, Promise, Number, String, SHELF_TICK_MS: 600000,
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    rpc: (n) => { calls.push(n); return Promise.resolve({ moved: 1 }); } });
  vm.runInContext('this.shelf = {' + tickSrc + '};', ctx);
  return { ctx, calls, store };
}
t('link_expiry_shelf_tick: at most once per 10 minutes per tab (Dashboard + Quotes opens share it)', async () => {
  const E = tickEnv();
  assert.deepEqual(JSON.parse(JSON.stringify(await E.ctx.shelf.tick())), { moved: 1 });
  const again = await E.ctx.shelf.tick();
  assert.equal(again.skipped, true); assert.equal(again.moved, 0);
  assert.deepEqual(E.calls, ['link_expiry_shelf_tick']);
  const old = tickEnv({ 'bp_shelf_tick:u1': String(Date.now() - 11 * 60000) }); await old.ctx.shelf.tick();
  assert.deepEqual(old.calls, ['link_expiry_shelf_tick']);
  const forced = tickEnv({ 'bp_shelf_tick:u1': String(Date.now()) }); await forced.ctx.shelf.tick({ force: true });
  assert.deepEqual(forced.calls, ['link_expiry_shelf_tick']);
  assert.match(SRC, /const SHELF_TICK_MS = 10 \* 60000;/);
  assert.match(SRC, /\|link_expiry_shelf_tick\)\/;/, 'the tick keeps the per-tab settings cache (it only moves quotes)');
});
t('chat_ensure_broadcast: only on the Chat page, once per tab session', () => {
  const blk = grab(/if \(!chatBcastEnsured && pageKey\(\) === "chat"\) \{[\s\S]*?\n      \}/, 'ensure block');
  assert.match(blk, /sessionStorage\.getItem\(bk\) === "1"/);
  assert.match(blk, /await rpc\("chat_ensure_broadcast"\); chatBcastEnsured = true; try \{ sessionStorage\.setItem\(bk, "1"\)/);
  assert.equal((SRC.match(/rpc\("chat_ensure_broadcast"\)/g) || []).length, 1, 'no other caller');
});
t('bell poll: never while hidden, 90 s on Chat with realtime, catch-up on return, listener removed on teardown', () => {
  assert.match(SRC, /const pollMs = \(\) => \(pageKey\(\) === "chat" && csub \? 90000 : 30000\);/);
  assert.match(SRC, /setInterval\(\(\) => \{ if \(kicked && !document\.hidden && !isOpen && Date\.now\(\) >= feedBackoffUntil && Date\.now\(\) - lastRf >= pollMs\(\) - 1000\) refresh\(\); \}, 30000\)/);
  assert.match(SRC, /document\.addEventListener\("visibilitychange", onVis\);/);
  assert.match(SRC, /document\.removeEventListener\("visibilitychange", onVis\);/);
  assert.match(SRC, /const refreshNow = async \(\) => \{ lastRf = Date\.now\(\);/);
});

/* ------------------------------------------------------------ 5. explicit studio filters */
t('calendar: event_tasks / event_plan / event_resources reads name the studio and are paged with the cap', () => {
  const cal = grab(/const calendar = \{[\s\S]*?config\.getPricing\(\)/, 'calendar.load');
  assert.match(cal, /sbAll\(\(\) => supa\.from\("event_tasks"\)\.select\("id,quote_id,crew_id,title,status"\)\.eq\("org_id", org\)\.not\("crew_id", "is", null\)\.order\("id"\)\)/);
  assert.match(cal, /sbAll\(\(\) => supa\.from\("event_plan"\)\.select\("quote_id,venue_name,venue_address"\)\.eq\("org_id", org\)\.order\("quote_id"\)\)/);
  assert.equal((cal.match(/const org = await orgIdStrict\(\); if \(!org\) return \[\];/g) || []).length, 2);
  assert.match(SRC, /return sbAll\(\(\) => supa\.from\("event_resources"\)\.select\("\*"\)\.eq\("org_id", org\)\.order\("id"\)\); \}/);
  assert.doesNotMatch(SRC, /supa\.from\("event_resources"\)\.select\("\*"\); if \(error\)/);
});
t('nurture_templates update is scoped to this studio (org_id + occasion_type)', () => {
  assert.match(SRC, /supa\.from\("nurture_templates"\)\.update\(\{ \.\.\.patch, updated_at: now\(\) \}\)\.eq\("org_id", org\)\.eq\("occasion_type", type\)/);
  assert.doesNotMatch(SRC, /from\("nurture_templates"\)\.update\([^)]*\)\)?\.eq\("occasion_type"/);
});

/* ------------------------------------------------------------ 6. /login?next= stays on the site */
function nextEnv() {
  const huSrc = /var HelmUrl = \(function \(global\) \{[\s\S]*?\n\}\)\(window\);/.exec(SRC)[0];
  const np = /const NEXT_PAGES = \[[^\]]*\];/.exec(SRC)[0];
  const sn = grab(/  function safeNext\(raw\) \{[\s\S]*?\n  \}\n/, 'safeNext');
  const ctx = vm.createContext({ window: { location: { pathname: '/login', search: '', hostname: 'www.helm.events' } }, sessionStorage: { getItem: () => null, setItem() {} }, URLSearchParams, encodeURIComponent, decodeURIComponent });
  vm.runInContext(huSrc + '\n' + np.replace('const ', 'var ') + '\n' + sn + '\nthis.safeNext = safeNext;', ctx);
  return ctx.safeNext;
}
t('/login?next=: off-site and look-alike targets fall back to the dashboard; own pretty paths stay relative', () => {
  const safeNext = nextEnv();
  for (const raw of ['https://evil.example', 'https://evil.example/abcd/dashboard', '//evil.example', '//evil.example/abcd/quotes', '/\\evil.example',
    '/evil.example/dashboard', '/%2F%2Fevil.example', 'https:%2F%2Fevil.example', '/abcd/dashboard/../../https://evil.example', 'javascript:alert(1)']) {
    const out = safeNext(raw);
    assert.ok(!/^(\/\/|[a-z][a-z0-9+.-]*:|\\)/i.test(out) && !/evil/.test(out), raw + ' -> ' + out);
  }
  const own = safeNext('/abcd/quotes');
  assert.ok(own.charAt(0) === '/' && own.charAt(1) !== '/' && /abcd/.test(own), own);
});

/* ------------------------------------------------------------ 7. DB migration 0204 is wired */
t('0204: in the MANIFEST, has an APPLY with VERIFY, and its DB suite runs in run-all.sh', () => {
  assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0204_anon_grant_tidy\.sql\n?/);
  const apply = read('supabase/APPLY-0204.sql');
  assert.match(apply, /^-- APPLY-0204\.sql/); assert.match(apply, /\nbegin;\n/); assert.match(apply, /\ncommit;\n/); assert.match(apply, /-- VERIFY/);
  assert.doesNotMatch(apply, /create temp|temporary table/i, 'no session state in an editor paste');
  assert.match(read('scripts/db-test/run-all.sh'), /run "anon-grant-tidy-0204" "ANON-GRANT-TIDY-0204: ALL PASS \\\(28\/28\\\)"/);
  const mig = read('supabase/migrations/0204_anon_grant_tidy.sql');
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(mig) && /^[\x09\x0a\x0d\x20-\x7e]*$/.test(apply), 'ASCII only');
  assert.doesNotMatch(mig, /\b(drop|delete|truncate)\b\s+(table|policy|function|from)/i, 'nothing dropped / deleted');
  assert.match(mig, /revoke all on table public\.%I from anon/);
  assert.match(mig, /alter policy %I on public\.%I to authenticated/);
  assert.match(mig, /p\.permissive = 'PERMISSIVE'/);
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
console.log(`la-fetch-security: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
