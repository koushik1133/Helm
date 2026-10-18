// 0183: post-trial policy 1 / 6 / 10 - an ended, unpaid free trial is READ-ONLY for everyone (owner + invited members).
//  * SQL: ASCII, additive, status-based trial rule, owner's text in the guard, members no longer blocked, MANIFEST,
//    APPLY = migration verbatim + VERIFY, DB suite in run-all
//  * trial.js: read-only strip (owner's words, Upgrade for admins, note for members), staff note, html.helm-read-only
//  * store-api: edit helpers answer false while read-only, friendly 'trial_ended' text, trialOrg.readOnly()
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const require = createRequire(import.meta.url);
let fail = 0, n = 0; const t = (name, f) => { try { f(); n++; console.log('  ok ' + name); } catch (e) { fail++; console.log('  FAIL ' + name); console.log(e.message); } };
const MIG = read('supabase/migrations/0183_trial_expiry_read_only.sql'), APPLY = read('supabase/APPLY-0183.sql');
const TJS = read('public/trial.js'), API = read('public/store-api.js');
const trial = require('../public/trial.js');
const TEXT = 'Your trial has ended. Your data is preserved and available in read-only mode. Upgrade now to continue creating and editing records.';
const code = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const fnBody = (src, name) => { const at = src.indexOf('function public.' + name + '('); assert.ok(at >= 0, name + ' missing');
  const a = src.indexOf('$$', at); return src.slice(at, src.indexOf('$$;', a + 2) + 3); };

t('SQL: ASCII only, additive (no drop table / delete / truncate / alter table / row updates)', () => {
  assert.ok(/^[\x00-\x7F]*$/.test(MIG) && /^[\x00-\x7F]*$/.test(APPLY));
  const c = code(MIG).toLowerCase();
  assert.ok(!/\bdrop\s+(table|column|function|trigger|index|view|schema)\b/.test(c));
  assert.ok(!/\bdelete\s+from\b/.test(c)); assert.ok(!/\btruncate\b/.test(c)); assert.ok(!/\balter\s+table\b/.test(c));
  assert.ok(!/\bupdate\s+public\./.test(c), 'no row is changed');
});
t('trial rule is status-based (studio_subscriptions), never trial_ends_at alone; ever-paid never locked', () => {
  const b = fnBody(MIG, '_trial_locked');
  assert.match(b, /join public\.studio_subscriptions s on s\.org_id = o\.id/);
  assert.match(b, /s\.status = 'trial'/);
  assert.match(b, /s\.status in \('past_due', 'cancelled'\) and s\.trial_ends_at is not null\s+and s\.current_period_end is null/);
  assert.match(b, /not exists \(select 1 from public\.subscription_payments sp where sp\.org_id = p_org and sp\.voided_at is null\)/);
  assert.match(b, /_trial_effective_end\(p_org\) <= now\(\)/);
  assert.match(b, /not coalesce\(o\.is_sample_master, false\)/);
  assert.ok(!/o\.trial_ends_at is not null and o\.trial_ends_at <= now\(\)/.test(b), 'the 0116 date-only rule is gone');
});
t('extension: effective end = later of the studio date and the end of the subscription date', () => {
  const b = fnBody(MIG, '_trial_effective_end');
  assert.match(b, /greatest\(o\.trial_ends_at, \(\(s\.trial_ends_at \+ 1\)::timestamp at time zone 'UTC'\)\)/);
});
t('invited members are no longer blocked; current_org_id untouched', () => {
  assert.match(fnBody(MIG, '_trial_member_blocked'), /select false;/);
  assert.ok(!/function public\.current_org_id\(\)/.test(MIG), 'current_org_id is not re-issued');
  assert.match(fnBody(MIG, 'my_trial_access'), /'blocked', false/);
});
t('read-only guard: owner text, 25006 trial_ended, suspended + payment_pending kept, own rows only', () => {
  const g = fnBody(MIG, 'tg_studio_read_only');
  assert.ok(g.includes("'" + TEXT + "'"));
  assert.match(g, /using errcode = '25006', hint = 'trial_ended'/);
  assert.match(g, /hint = 'studio_suspended'/); assert.match(g, /hint = 'payment_pending'/);
  assert.match(g, /tg_table_name in \('studio_account', 'notifications'\)/);
  assert.match(g, /tg_table_name = 'profiles'\s+and \(v_new is null or v_new ->> 'id' = v_uid\) and \(v_old is null or v_old ->> 'id' = v_uid\)/);
  assert.match(g, /\(v_new - 'last_read_at'\) = \(v_old - 'last_read_at'\)/);
  assert.match(g, /not v_free and public\._trial_locked\(o\) and not public\.is_platform_admin\(\)/);
});
t('my_trial_org: status-based is_trial_org, effective end, read_only; grants unchanged', () => {
  const b = fnBody(MIG, 'my_trial_org');
  assert.match(b, /'read_only', v_locked/); assert.match(b, /'ends_at', v_end/);
  assert.match(b, /'is_trial_org', false, 'read_only', false/);
  assert.match(MIG, /grant execute on function public\.my_trial_org\(\) to authenticated/);
  assert.match(MIG, /revoke all on function %s from anon/);
});
t('uploads: restrictive storage policies + guard on the WhatsApp proposal tables', () => {
  for (const p of ['trial_ro_storage_insert', 'trial_ro_storage_update', 'trial_ro_storage_delete'])
    assert.match(MIG, new RegExp('create policy ' + p + ' on storage\\.objects as restrictive'));
  assert.match(fnBody(MIG, 'trial_storage_write_ok'), /coalesce\(p_bucket, ''\) = 'member-avatars'/);
  assert.match(MIG, /array\['wa_proposal_optins', 'wa_proposal_audit'\]/);
});
t('MANIFEST + APPLY (migration verbatim, one transaction, VERIFY) + DB suite wired', () => {
  assert.match(read('supabase/migrations/MANIFEST'), /\nforward  supabase\/migrations\/0183_trial_expiry_read_only\.sql\n/);
  assert.ok(APPLY.includes(MIG)); assert.match(APPLY, /\nbegin;\n/); assert.match(APPLY, /\ncommit;\n\n-- VERIFY/);
  const v = APPLY.slice(APPLY.indexOf('-- VERIFY')).toLowerCase();
  assert.ok(!/\b(insert|update|delete|alter|create|drop|truncate|grant|revoke)\b/.test(code(v)), 'VERIFY changes nothing');
  assert.match(read('scripts/db-test/run-all.sh'), /run "trial-expiry-0183" "TRIAL-EXPIRY-0183: ALL PASS \\\(61\/61\\\)" psql -q -f tests\/db\/trial-expiry-0183\.sql/);
});
t('strip: read-only = owner words for everyone, Upgrade for admins only', () => {
  const a = trial.bannerSpec({ is_trial_org: true, ended: true, locked: true, read_only: true, is_admin: true });
  assert.equal(a.title, 'Your trial has ended.');
  assert.equal(a.title + ' ' + a.body, TEXT);
  assert.equal(a.cta, 'Upgrade'); assert.equal(a.locked, true); assert.equal(a.tone, 'ended'); assert.equal(a.note, null);
  const m = trial.bannerSpec({ is_trial_org: true, ended: true, read_only: true, is_admin: false });
  assert.equal(m.title + ' ' + m.body, TEXT); assert.equal(m.cta, null); assert.equal(m.note, 'Only a studio admin can upgrade.');
  // older database answer (no read_only): locked still means read-only
  assert.equal(trial.bannerSpec({ is_trial_org: true, ended: true, locked: true, is_admin: true }).cta, 'Upgrade');
  // date passed but not read-only (paid / extended): no strip
  assert.equal(trial.bannerSpec({ is_trial_org: true, ended: true, locked: false, read_only: false, is_admin: true }), null);
  assert.equal(trial.planHref({ is_admin: true, trial_mode: 'demo', ended: true, locked: true }, 'leads'), 'checkout.html?next=leads.html');
});
t('strip: still the days-left strip during the trial', () => {
  const a = trial.bannerSpec({ is_trial_org: true, days_left: 6, is_admin: true, read_only: false, locked: false });
  assert.equal(a.title, 'Free trial · 6 days left'); assert.equal(a.locked, false);
});
t('staff note: read-only for everyone after the trial', () => {
  assert.match(trial.staffNoteSpec({ is_trial_org: true, read_only: true }).text, /including invited staff, can still sign in and view everything in read-only mode/);
  assert.match(trial.staffNoteSpec({ is_trial_org: true, ends_at: '2026-10-24T10:00:00Z', timezone: 'Asia/Kolkata' }).text, /your staff keep read-only access until you upgrade/);
});
t('trial.js: read-only class + CSS-safe DOM (no innerHTML / inline style)', () => {
  assert.match(TJS, /classList\.add\("helm-read-only"\)/);
  assert.match(TJS, /html\.helm-read-only #composer/);
  assert.match(TJS, /nt\.className = "htr-note"/);
  assert.ok(!/innerHTML|insertAdjacentHTML|\.style\.|setAttribute\("style"/.test(TJS));
});
t('store-api: edit helpers answer false while read-only; view stays open', () => {
  assert.match(API, /function studioReadOnly\(\)/);
  assert.match(API, /t\.read_only === true \|\| t\.locked === true/);
  assert.match(API, /const \[r, ro\] = await Promise\.all\(\[getRole\(\), cap === "view" \? false : studioReadOnly\(\)\]\)/);
  assert.match(API, /return EDIT_ROLES\.includes\(r\) && !ro;/);
  assert.match(API, /if \(ro\) return false;\s+\/\/ 0183: read-only after the free trial \(admins too\)\s+if \(r === "admin"\) return true;/);
  assert.match(API, /readOnly: \(\) => studioReadOnly\(\)/);
  assert.match(API, /status: \(\) => trialOrgStatus\(\)/);
  assert.match(API, /swr\("trialorg", \(\) => rpc\("my_trial_org", \{\}\)/);
});
t('store-api: friendly text for trial_ended comes before the generic read-only line', () => {
  const at = API.indexOf('e.hint === "trial_ended"'), gen = API.indexOf('e.hint === "studio_suspended" || errCode(e) === "25006"');
  assert.ok(at > 0 && gen > at);
  assert.ok(API.slice(at, at + 400).includes(TEXT));
});
// ---- runtime: store-api in a sandbox with a stubbed Supabase client (same shape as boot-perf.test.mjs) ----
function memStore() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function makeEnv(trialOrg, role) {
  const calls = [];
  const user = { id: 'u-1', email: 'owner@a.test' }, session = { user, access_token: 'x' };
  const client = {
    auth: { async getSession() { return { data: { session } }; }, onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async refreshSession() { return { data: { session }, error: null }; }, async signOut() { return { error: null }; },
      mfa: { async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; } } },
    rpc(name) { calls.push(name);
      if (name === 'my_trial_org') return Promise.resolve(trialOrg instanceof Error ? { data: null, error: trialOrg } : { data: trialOrg, error: null });
      if (name === 'current_org_id') return Promise.resolve({ data: 'org-1', error: null });
      return Promise.resolve({ data: null, error: null }); },
    from() { const q = { select: () => q, eq: () => q, order: () => q,
      single: async () => ({ data: { role }, error: null }), maybeSingle: async () => ({ data: { role }, error: null }),
      then: (res, rej) => Promise.resolve({ data: [{ area: 'leads', can_view: true, can_edit: true }], error: null }).then(res, rej) }; return q; },
  };
  const el = (tag) => ({ tag, style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {} });
  const doc = { readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=1' },
    createElement: el, head: { appendChild() {} }, body: { children: [], appendChild(c) { this.children.push(c); }, removeChild() {}, get firstChild() { return null; } },
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; }, classList: { contains: () => false, add() {}, remove() {} } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  const win = { SUPABASE_CONFIG: { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' }, supabase: { createClient: () => client },
    localStorage: memStore(), sessionStorage: memStore(),
    location: { pathname: '/leads', search: '', hash: '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events', replace() {}, reload() {} },
    document: doc, navigator: { onLine: true }, fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    addEventListener() {}, removeEventListener() {}, setTimeout: (fn, ms) => { if (!ms || ms < 1000) { try { fn(); } catch (e) {} } return 0; }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {}, atob: (b) => Buffer.from(b, 'base64').toString('binary'), console: { log() {}, info() {}, warn() {}, error() {} } };
  win.window = win; win.globalThis = win;
  vm.createContext(win); vm.runInContext(API, win, { filename: 'store-api.js' });
  return { S: win.BPStore, calls, BPUI: win.BPUI };
}
const asyncTests = [];
const ta = (name, f) => asyncTests.push([name, f]);
ta('runtime: read-only trial -> admin + member edit helpers say no, view stays yes, one my_trial_org call', async () => {
  for (const role of ['admin', 'manager']) {
    const e = makeEnv({ is_trial_org: true, ended: true, locked: true, read_only: true, is_admin: role === 'admin' }, role);
    await e.S.init();
    assert.equal(await e.S.auth.canEditArea('leads'), false, role + ' canEditArea');
    assert.equal(await e.S.auth.can('create'), false, role + ' create'); assert.equal(await e.S.auth.can('edit'), false, role + ' edit');
    assert.equal(await e.S.auth.can('view'), true, role + ' view');
    assert.equal(await e.S.auth.canEdit(), false, role + ' canEdit');
    assert.equal(await e.S.trialOrg.readOnly(), true);
    assert.equal(e.calls.filter((c) => c === 'my_trial_org').length, 1, 'one shared my_trial_org call');
  }
});
ta('runtime: active trial / paid studio / older database -> unchanged edit rights', async () => {
  const live = makeEnv({ is_trial_org: true, ended: false, locked: false, read_only: false, is_admin: true }, 'admin');
  await live.S.init();
  assert.equal(await live.S.auth.canEditArea('leads'), true); assert.equal(await live.S.auth.can('delete'), true);
  const paid = makeEnv({ is_trial_org: false, read_only: false, is_admin: true }, 'admin');
  await paid.S.init(); assert.equal(await paid.S.auth.canEditArea('quotes'), true); assert.equal(await paid.S.trialOrg.readOnly(), false);
  const old = makeEnv(Object.assign(new Error('Could not find the function public.my_trial_org'), { code: 'PGRST202' }), 'manager');
  await old.S.init(); assert.equal(await old.S.auth.canEditArea('leads'), true, 'rpc missing = not read-only');
  const err = makeEnv(Object.assign(new Error('boom'), { code: '500' }), 'admin');
  await err.S.init(); assert.equal(await err.S.auth.canEditArea('leads'), true, 'error = not read-only (the server still decides)');
});
ta('runtime: friendly text for a refused write (25006 trial_ended)', async () => {
  const e = makeEnv({ is_trial_org: false }, 'admin');
  const m = e.BPUI.friendlyError({ code: '25006', hint: 'trial_ended', message: 'x' }, { action: 'save the lead' });
  assert.equal(m, 'Couldn\u2019t save the lead. ' + TEXT);
  assert.match(e.BPUI.friendlyError({ code: '25006', hint: 'studio_suspended', message: 'x' }), /suspended or the trial has ended/);
});
for (const [name, f] of asyncTests) { try { await f(); n++; console.log('  ok ' + name); } catch (e) { fail++; console.log('  FAIL ' + name); console.log(e.message); } }
if (fail) { console.log('trial-expiry-0183: ' + fail + ' FAILED'); process.exit(1); }
console.log('trial-expiry-0183: ' + n + ' passed');
