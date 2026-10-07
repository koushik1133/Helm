// "Complete your profile" (0041) — PART B: where profiles show up.
// Pins, with store-api.js running in a vm sandbox against a stubbed Supabase client and the
// page render functions run against stub data:
//  * Control Center → User control lists member_profile_list rows (photo, phone ONLY when the
//    DB returned it, job title, department, complete ✓/✗ + joined date), falls back to the old
//    list before 0041, filters / searches, escapes everything
//  * the admin edit dialog validates like 0041 (Indian mobile, text <= 80 / no < >, <= 20
//    skills, day rate, employment type) and sends ONLY changed, normalised fields to
//    admin_update_member_profile(p_user, p_profile)
//  * Staff directory: linked rows (profile_id) get a "Linked account" badge + photo; their
//    name / phone / e-mail / department / title are never sent; a linked member's number
//    can't get a second staff row (normalised compare)
//  * chat: photos from chat_directory.avatar_path (escaped, own-bucket keys only, one batched
//    signing call, cached), initials fallback; job title in the DM header
//  * audit log: actor shown as display name (e-mail on hover), falling back to the e-mail
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/store-api.js');
const ctl = read('public/control.html');
const staffHtml = read('public/staff.html');
const chat = read('public/chat.html');
const auditHtml = read('public/audit.html');
const ops = read('public/ops.html');
const mig = read('supabase/migrations/0041_member_profile.sql');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const J = (x) => JSON.parse(JSON.stringify(x));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  const from = src.slice(at - 6, at) === 'async ' ? at - 6 : at;
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1); }
  throw new Error(name + ' unterminated');
};

/* ------------------------------------------------------------ sandbox */
const U = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const ORG = 'a0000000-0000-4000-8000-000000000001';
const AV = (u, f) => `${ORG}/${u}/${f || 'b0000000-0000-4000-8000-000000000009'}.webp`;
function memStore() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function el(attrs) {
  const a = Object.assign({}, attrs || {});
  return { _a: a, children: [], style: {}, isConnected: true, textContent: '',
    getAttribute: (k) => (k in a ? a[k] : null), setAttribute: (k, v) => { a[k] = String(v); }, removeAttribute: (k) => { delete a[k]; },
    hasAttribute: (k) => k in a, appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [], remove() { this.isConnected = false; } };
}
async function makeEnv(o = {}) {
  const rpcs = [], queries = [], signs = [];
  const user = { id: o.me || U(1), email: 'admin@a.test' };
  const session = { user, access_token: 'x' };
  const client = {
    auth: {
      async getSession() { return { data: { session } }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async refreshSession() { return { data: { session }, error: null }; },
      async signOut() { return { error: null }; },
      mfa: { async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; } },
    },
    rpc(name, args) {
      rpcs.push([name, args]);
      if (name === 'current_org_id') return Promise.resolve({ data: ORG, error: null });
      if (name === 'my_profile_status') return Promise.resolve({ data: { complete: true, required: false, nudge: false }, error: null });
      if (o.rpc && name in o.rpc) return Promise.resolve(typeof o.rpc[name] === 'function' ? o.rpc[name](args) : o.rpc[name]);
      return Promise.resolve({ data: null, error: null });
    },
    storage: { from(bucket) { return {
      async createSignedUrls(paths, ttl) { signs.push([bucket, paths.slice(), ttl]);
        if (o.signFail) return { data: null, error: { message: 'boom' } };
        return { data: paths.map((p) => ({ path: p, signedUrl: 'https://sb.test/sign/' + p + '?t=1', error: null })), error: null }; },
      async createSignedUrl(p, ttl) { signs.push([bucket, [p], ttl]);
        if (o.signFail) return { data: null, error: { message: 'boom' } };
        return { data: { signedUrl: 'https://sb.test/sign/' + p + '?t=1' }, error: null }; },
    }; } },
    from(table) {
      const q = { table, calls: [] }; const b = {};
      ['select', 'eq', 'neq', 'is', 'not', 'or', 'in', 'lt', 'lte', 'gt', 'gte', 'like', 'ilike', 'filter', 'contains', 'order', 'range', 'limit', 'insert', 'update']
        .forEach((m) => { b[m] = (...a) => { q.calls.push([m, ...a]); return b; }; });
      const run = () => { queries.push(q);
        if (table === 'profiles' && !(o.respond)) return Promise.resolve({ data: [{ role: 'admin' }], error: null });
        if (table === 'role_access') return Promise.resolve({ data: [], error: null });
        return Promise.resolve((o.respond || (() => ({ data: [], error: null })))(q)); };
      b.single = () => run().then((r) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] : r.data }));
      b.maybeSingle = b.single;
      b.then = (res, rej) => run().then(res, rej);
      return b;
    },
  };
  const doc = {
    readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=1' },
    createElement: (tag) => Object.assign(el(), { tagName: String(tag).toUpperCase(), remove() { this.isConnected = false; } }),
    head: { appendChild() {} }, body: { appendChild() {}, removeChild() {}, children: [] },
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; }, classList: { contains: () => false, add() {}, remove() {} } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  };
  const win = {
    SUPABASE_CONFIG: { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' },
    supabase: { createClient: () => client },
    localStorage: memStore(), sessionStorage: memStore(),
    location: { pathname: '/control', search: '', hash: '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events', replace() {}, reload() {} },
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
  rpcs.length = 0; queries.length = 0;
  return { S: win.BPStore, rpcs, queries, signs, win };
}
// a member_profile_list row as 0041's _mp_row_json builds it (level 0 = colleague)
function mrow(i, level, extra) {
  const r = { user_id: U(i), full_name: 'Member ' + i, role: 'crew', email: level >= 1 ? `m${i}@a.test` : null, email_name: 'm' + i,
    job_title: 'Rigger', department: 'Production', skills: ['lighting'], avatar_path: null, complete: true,
    profile_completed_at: '2026-10-02T10:00:00Z', created_at: '2026-09-30T10:00:00Z',
    phone: level >= 1 ? '+919876543210' : null, whatsapp: level >= 1 ? '+919876543210' : null, whatsapp_same: level >= 1 ? true : null,
    city: level >= 1 ? 'Hyderabad' : null, emergency_contact_name: null, emergency_contact_phone: null,
    staff_id: null, day_rate: level >= 2 ? 1500 : null, emp_type: level >= 2 ? 'full_time' : null };
  return Object.assign(r, extra || {});
}

/* ------------------------------------------------------------ User control: data */
t('admin.members(): member_profile_list rows; before 0041 → today\'s profiles list (asked once)', async () => {
  const e = await makeEnv({ rpc: { member_profile_list: { data: [mrow(1, 2), mrow(2, 2)], error: null } } });
  const r = await e.S.auth.admin.members();
  assert.equal(r.profiles, true); assert.equal(r.rows.length, 2);
  assert.deepEqual(e.rpcs.map((x) => x[0]), ['member_profile_list']);
  const old = [{ id: U(5), email: 'x@a.test', full_name: 'X', role: 'crew', created_at: '2026-01-01' }];
  const f = await makeEnv({ rpc: { member_profile_list: { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.member_profile_list' } } },
    respond: (q) => (q.table === 'profiles' ? { data: old, error: null } : { data: [], error: null }) });
  const r1 = await f.S.auth.admin.members(); const r2 = await f.S.auth.admin.members();
  assert.equal(r1.profiles, false); assert.equal(J(r1.rows)[0].email, 'x@a.test'); assert.equal(r2.profiles, false);
  assert.equal(f.rpcs.filter((x) => x[0] === 'member_profile_list').length, 1, 'the missing RPC is not retried');
  const g = await makeEnv({ rpc: { member_profile_list: { data: null, error: { code: '42501', message: 'not authorized' } } } });
  await assert.rejects(() => g.S.auth.admin.members(), (err) => err.code === '42501', 'a real error still surfaces');
});

t('edit dialog validation mirrors 0041 (mobile, text, skills, day rate, employment type)', async () => {
  const e = await makeEnv();
  const P = (f) => J(e.S.auth.admin.memberProblems(f));
  assert.deepEqual(P({ full_name: 'Ravi Kumar', phone: '98765 43210', job_title: 'Lead', department: 'AV', skills: ['a', 'b'], day_rate: '1500.50', emp_type: 'on_call' }), {});
  for (const ok of ['9876543210', '+91 98765 43210', '09876543210', '919876543210', '+91-98765-43210', '6000000000'])
    assert.equal(P({ phone: ok }).phone, undefined, 'mobile should pass: ' + ok);
  for (const bad of ['12345', '5876543210', '+1 415 555 0100', '98765432101', 'abcdefghij', '+92 98765 43210'])
    assert.ok(P({ phone: bad }).phone, 'mobile should fail: ' + bad);
  assert.equal(P({ phone: '' }).phone, 'Mobile number is required.');
  assert.equal(e.S.auth.admin.mobile('098765 43210'), '+919876543210');
  assert.ok(P({ full_name: '' }).full_name); assert.ok(P({ full_name: 'x'.repeat(81) }).full_name); assert.ok(P({ full_name: '<b>' }).full_name);
  assert.match(P({ job_title: 'x'.repeat(81) }).job_title, /80 characters/);
  assert.match(P({ department: 'Prod <script>' }).department, /< or >/);
  assert.match(P({ city: 'a\u0007b' }).city, /control/);
  assert.equal(P({ job_title: 'x'.repeat(80) }).job_title, undefined);
  assert.match(P({ skills: Array.from({ length: 21 }, (_, i) => 's' + i) }).skills, /20 skills/);
  assert.equal(P({ skills: Array.from({ length: 20 }, (_, i) => 's' + i) }).skills, undefined);
  assert.match(P({ skills: ['ok', 'x'.repeat(41)] }).skills, /40 characters/);
  assert.match(P({ skills: ['<img>'] }).skills, /< or >/);
  assert.equal(P({ skills: ['Sound', 'sound', 'SOUND'] }).skills, undefined, 'dupes collapse, not counted');
  for (const bad of ['-1', '1.234', 'abc', '10000001', '1e5']) assert.ok(P({ day_rate: bad }).day_rate, 'day rate should fail: ' + bad);
  for (const ok of ['', null, '0', '2500', '2500.5']) assert.equal(P({ day_rate: ok }).day_rate, undefined, 'day rate ok: ' + ok);
  assert.ok(P({ emp_type: 'contractor' }).emp_type); assert.equal(P({ emp_type: '' }).emp_type, undefined);
  assert.ok(P({ whatsapp_same: false, whatsapp: '123' }).whatsapp); assert.equal(P({ whatsapp_same: true, whatsapp: '123' }).whatsapp, undefined);
  assert.equal(P({ emergency_contact_phone: '+44 20 7946 0958' }).emergency_contact_phone, undefined);
  assert.ok(P({ emergency_contact_phone: '020 7946 0958' }).emergency_contact_phone);
});

t('admin.updateMember → admin_update_member_profile(p_user, p_profile) with ONLY changed, normalised fields', async () => {
  const saved = mrow(2, 2, { job_title: 'Head rigger' });
  const e = await makeEnv({ rpc: { admin_update_member_profile: { data: saved, error: null } } });
  const orig = mrow(2, 2);
  const form = { full_name: 'Member 2', phone: '98765 43210', whatsapp_same: true, job_title: ' Head   rigger ', department: 'Production', city: 'Hyderabad',
    emergency_contact_name: '', emergency_contact_phone: '', skills: ['lighting', 'Sound'], day_rate: '1800', emp_type: 'on_call' };
  const out = await e.S.auth.admin.updateMember(U(2), orig, form);
  assert.equal(J(out).job_title, 'Head rigger');
  assert.equal(e.rpcs.length, 1);
  const [name, args] = J(e.rpcs[0]);
  assert.equal(name, 'admin_update_member_profile');
  assert.deepEqual(Object.keys(args).sort(), ['p_profile', 'p_user']);
  assert.equal(args.p_user, U(2));
  assert.deepEqual(args.p_profile, { job_title: 'Head rigger', skills: ['lighting', 'Sound'], day_rate: 1800, emp_type: 'on_call' },
    'unchanged name / phone (same number, other spelling) / dept / city are not sent');
  // a new number, normalised; clearing a field sends null; whatsapp split
  const e2 = await makeEnv({ rpc: { admin_update_member_profile: { data: {}, error: null } } });
  await e2.S.auth.admin.updateMember(U(2), orig, { phone: '+91 70000 00001', city: '', whatsapp_same: false, whatsapp: '8000000002', day_rate: '' });
  assert.deepEqual(J(e2.rpcs[0][1]).p_profile, { phone: '+917000000001', city: null, whatsapp_same: false, whatsapp: '+918000000002', day_rate: null });
  // nothing changed → no call
  const e3 = await makeEnv();
  assert.equal(await e3.S.auth.admin.updateMember(U(2), orig, { full_name: 'Member 2', job_title: 'Rigger', day_rate: '1500', emp_type: 'full_time' }), null);
  assert.equal(e3.rpcs.length, 0);
  // invalid → field errors, no call
  const e4 = await makeEnv();
  await assert.rejects(() => e4.S.auth.admin.updateMember(U(2), orig, { phone: '12345', job_title: 'a<b' }),
    (err) => { assert.ok(err.fields.phone && err.fields.job_title); return true; });
  assert.equal(e4.rpcs.length, 0);
});

t('DB business messages from 0041 are shown as-is; technical ones are not', async () => {
  const e = await makeEnv(); const T = e.S.auth.admin.memberErrorText;
  assert.equal(T({ code: '22023', message: 'Add a full name and mobile number first — day rate and employment type live on the staff record.' }),
    'Add a full name and mobile number first — day rate and employment type live on the staff record.');
  assert.match(T({ code: '23505', message: "That mobile number is already on another team member's profile in your studio." }), /already on another/);
  assert.match(e.S.staff.linkErrorText({ code: '42501', message: 'This staff record is linked to a Helm account — change name, phone, email, department and title in Control Center → User control (or the member edits their own profile).' }), /linked to a Helm account/);
  assert.equal(T({ code: '42501', message: 'not authorized' }), null);
  assert.equal(T({ code: '23505', message: 'duplicate key value violates unique constraint "crew_members_org_profile_uidx"' }), null);
  assert.equal(T(null), null);
});

/* ------------------------------------------------------------ User control: rendering */
function ucCtx() {
  const ctx = { esc };
  vm.runInNewContext(['ucId', 'ucDate', 'ucPhone', 'ucInitials', 'ucPrivateVisible', 'ucMatches', 'ucTable']
    .map((f) => (f === 'ucId' ? 'const ucId=(u)=>u.user_id||u.id;' : fnSrc(ctl, f))).join('\n') + '\nglobalThis.T=ucTable;', ctx);
  return ctx;
}
const ROLES = ['admin', 'manager', 'crew'];
t('User control: Name / Phone / Job title / Department / Profile (+ joined) / photo; phone only when returned', () => {
  const { T } = ucCtx();
  const rows = [mrow(1, 2, { full_name: 'Asha Admin', role: 'admin' }), mrow(2, 2, { avatar_path: AV(U(2)) }),
    mrow(3, 2, { complete: false, phone: null, profile_completed_at: null, full_name: '' })];
  const r = T(rows, { profiles: true, meId: U(1), roles: ROLES, roleLabel: (x) => x, canEdit: true, q: '', filter: '' });
  for (const h of ['Name', 'Phone', 'Job title', 'Department', 'Role', 'Profile']) assert.match(r.head, new RegExp(`<th scope="col">${h}</th>`));
  assert.match(r.body, /\+91 98765 43210/, 'phone shown (admins get it) in a readable format');
  assert.match(r.body, /Rigger/); assert.match(r.body, /Production/);
  assert.match(r.body, /✓ Complete/); assert.match(r.body, /✗ Incomplete/); assert.match(r.body, /Joined /);
  assert.match(r.body, new RegExp(`data-avatar-path="${AV(U(2)).replace(/[.]/g, '\\.')}"`), 'photo thumbnail painted from avatar_path');
  assert.equal((r.body.match(/class="btn sm ucEdit"/g) || []).length, 3, 'admin Edit button per row');
  assert.equal((r.body.match(/class="rm"/g) || []).length, 2, 'no remove button on my own row');
  assert.match(r.body, /<span class="me">you<\/span>/);
  // a users-view caller who is NOT given private fields: colleague rows have whatsapp_same=null
  const priv = T([mrow(1, 1), mrow(2, 0), mrow(3, 0)], { profiles: true, meId: U(1), roles: ROLES, q: '', filter: '' });
  assert.doesNotMatch(priv.head, /Phone/, 'no Phone column when the DB didn\'t return phones');
  assert.doesNotMatch(priv.body, /98765/, 'and not even my own number leaks into a hidden column');
  assert.doesNotMatch(priv.body, /ucEdit/, 'no Edit without canEdit');
});
t('User control: search + "incomplete" filter; everything escaped (names, titles, photo path)', () => {
  const { T } = ucCtx();
  const evil = '"><img src=x onerror=alert(1)>';
  const rows = [mrow(1, 2), mrow(2, 2, { full_name: evil, job_title: evil, department: '<b>x</b>', avatar_path: evil, complete: false }), mrow(3, 2, { full_name: 'Zara Khan', job_title: 'Florist' })];
  const all = T(rows, { profiles: true, meId: U(1), roles: ROLES, canEdit: true, q: '', filter: '' });
  assert.doesNotMatch(all.body, /<img/); assert.doesNotMatch(all.body, /<b>x/);
  assert.match(all.body, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
  const inc = T(rows, { profiles: true, meId: U(1), roles: ROLES, q: '', filter: 'incomplete' });
  assert.equal(inc.shown, 1); assert.equal(inc.total, 3);
  assert.equal(T(rows, { profiles: true, meId: U(1), roles: ROLES, q: 'florist', filter: '' }).shown, 1);
  assert.equal(T(rows, { profiles: true, meId: U(1), roles: ROLES, q: '98765 43210', filter: '' }).shown, 3, 'search by phone digits');
  assert.equal(T(rows, { profiles: true, meId: U(1), roles: ROLES, q: 'nobody', filter: '' }).shown, 0);
});
t('User control before 0041: today\'s Name / Email / Role table with the display-name ✎', () => {
  const { T } = ucCtx();
  const r = T([{ id: U(1), email: 'me@a.test', full_name: 'Me', role: 'admin' }, { id: U(2), email: 'b@a.test', full_name: '', role: 'crew' }],
    { profiles: false, meId: U(1), roles: ROLES, q: '', filter: '' });
  assert.match(r.head, /<th scope="col">Email<\/th>/); assert.doesNotMatch(r.head, /Phone|Job title/);
  assert.equal((r.body.match(/class="dnEdit"/g) || []).length, 2);
  assert.match(r.body, /Not set/); assert.doesNotMatch(r.body, /ucEdit|✓ Complete/);
});
t('control.html wiring: members() + edit dialog fields + Day rate / Employment type + inline errors', () => {
  assert.match(ctl, /res=await BPStore\.auth\.admin\.members\(\)/);
  assert.match(ctl, /BPStore\.auth\.admin\.updateMember\(id, row, form\)/);
  assert.match(ctl, /BPStore\.auth\.admin\.memberErrorText\(err\)\|\|errMsg\(err,"save the profile"\)/);
  for (const id of ['mp_full_name', 'mp_phone', 'mp_wa_same', 'mp_whatsapp', 'mp_job_title', 'mp_department', 'mp_city', 'mp_skill', 'mp_chips',
    'mp_emergency_contact_name', 'mp_emergency_contact_phone', 'mp_day_rate', 'mp_emp_type', 'uc_q', 'uc_f'])
    assert.match(ctl, new RegExp(`id="${id}"`), id + ' missing');
  for (const k of ['full_name', 'phone', 'whatsapp', 'job_title', 'department', 'city', 'skills', 'emergency_contact_name', 'emergency_contact_phone', 'day_rate', 'emp_type'])
    assert.match(ctl, new RegExp(`id="mp_e_${k}"`), 'inline error slot for ' + k);
  assert.match(ctl, /<span aria-hidden="true">\+91<\/span><input id="mp_phone" type="tel" data-no-country="1"/);
  assert.match(ctl, /<option value="full_time">Full-time<\/option><option value="part_time">Part-time<\/option><option value="on_call">On-call<\/option>/);
  // and the admin RPC exists in 0041 with these argument names, admin + same studio only
  assert.match(mig, /create or replace function public\.admin_update_member_profile\(p_user uuid, p_profile jsonb\)/);
  assert.match(mig, /not public\.is_admin\(\)/);
});

/* ------------------------------------------------------------ Staff directory */
t('staff: linked rows get the "Linked account" badge + photo; unlinked unchanged; escaped', () => {
  const ctx = { esc, EMP: { full_time: 'Full-time' }, canEdit: true, memberDir: { [U(7)]: { avatar_path: AV(U(7)) } },
    initials: (n) => String(n || '?').slice(0, 1), BPStore: { staff: { isLinked: (s) => !!(s && s.profile_id) } } };
  vm.runInNewContext(fnSrc(staffHtml, 'personCard') + '\nglobalThis.f=personCard;', ctx);
  const linked = ctx.f({ id: 'c1', name: 'Ravi', role: 'Rigger', department: 'AV', phone: '+919876543210', profile_id: U(7), skills: [] });
  assert.match(linked, /🔗 Linked account/); assert.match(linked, /data-avatar-path="[^"]+\.webp"/);
  const plain = ctx.f({ id: 'c2', name: '<i>Sam</i>', phone: '1', skills: [] });
  assert.doesNotMatch(plain, /Linked account|data-avatar-path/); assert.doesNotMatch(plain, /<i>Sam/);
});
t('staff: linked rows never send name / phone / email / department / role; duplicate-number check before saving', async () => {
  const e = await makeEnv();
  assert.deepEqual(J(e.S.staff.LINKED_FIELDS), ['name', 'phone', 'email', 'department', 'role']);
  assert.match(staffHtml, /if\(linked\) BPStore\.staff\.LINKED_FIELDS\.forEach\(k=>\{ delete rec\[k\]; \}\);/);
  assert.match(staffHtml, /const owner=await BPStore\.staff\.linkedOwnerOfPhone\(rec\.phone, editingId\);/);
  assert.match(staffHtml, /fail\(BPStore\.staff\.linkErrorText\(e\)\|\|BPUI\.friendlyError/);
  assert.match(staffHtml, /<a href="control\.html#users">Edit in User control<\/a>/);
  assert.match(ops, /const owner=await BPStore\.staff\.linkedOwnerOfPhone\(phone\);/, 'ops quick-add has the same guard');
  // the guard itself: same number written differently = the same member (helm_norm_phone rule)
  const rows = [{ id: 'c1', name: 'Ravi', phone: '+91 98765 43210', profile_id: U(7) }, { id: 'c2', name: 'Unlinked', phone: '9000000000', profile_id: null }];
  const f = await makeEnv({ respond: (q) => (q.table === 'crew_members' ? { data: rows.filter((r) => r.profile_id), error: null } : { data: [], error: null }) });
  assert.deepEqual(J(await f.S.staff.linkedOwnerOfPhone('098765 43210')), { id: 'c1', name: 'Ravi' });
  assert.deepEqual(J(await f.S.staff.linkedOwnerOfPhone('9876543210')), { id: 'c1', name: 'Ravi' });
  assert.equal(await f.S.staff.linkedOwnerOfPhone('9876543210', 'c1'), null, 'its own row is not a duplicate');
  assert.equal(await f.S.staff.linkedOwnerOfPhone('9000000000'), null, 'unlinked rows are not counted');
  const q = f.queries.find((x) => x.table === 'crew_members');
  assert.ok(q.calls.some((c) => c[0] === 'not' && c[1] === 'profile_id' && c[2] === 'is' && c[3] === null));
  const g = await makeEnv({ respond: () => ({ data: null, error: { code: '42703', message: 'column crew_members.profile_id does not exist' } }) });
  assert.equal(await g.S.staff.linkedOwnerOfPhone('9876543210'), null, 'before 0041 → no block (the DB guard is the backstop)');
});
t('task pickers / check-in / calendar read crew_members unfiltered — linked members included', () => {
  assert.match(SRC, /async listCrew\(\) \{[^\n]*\n\s*const \{ data, error \} = await supa\.from\("crew_members"\)\.select\("\*"\)\.eq\("active", true\)\.order\("name"\);/);
  assert.match(ops, /function crewOption\(c\)\{ return `<option value="\$\{esc\(c\.id\)\}">\$\{esc\(c\.name\)\}/);
  assert.match(ops, /crew\.map\(crewOption\)/);
  assert.match(SRC, /staff\.list\(true\)\.catch\(\(\) => \[\]\), vendors\.listAll\(true\)/, 'calendar + check-in roster use every staff row');
});

/* ------------------------------------------------------------ chat photos */
t('chat roster carries avatar_path / job_title / department from chat_directory', async () => {
  const e = await makeEnv({ rpc: { chat_directory: { data: [{ id: U(2), full_name: 'Ravi', email_name: 'ravi', role: 'crew', avatar_path: AV(U(2)), job_title: 'Rigger', department: 'AV' }], error: null } } });
  const r = J(await e.S.chat.roster());
  assert.deepEqual(r[0], { id: U(2), full_name: 'Ravi', email_name: 'ravi', role: 'crew', avatar_path: AV(U(2)), job_title: 'Rigger', department: 'AV' });
  const dir = J(await e.S.chat.directory()); assert.equal(dir[U(2)].job_title, 'Rigger');
});
t('photos: one batched signing call, cached for the session; outside URLs never signed; initials fallback', async () => {
  const e = await makeEnv();
  const good1 = AV(U(2)), good2 = AV(U(3), 'c0000000-0000-4000-8000-000000000001');
  const els = [el({ 'data-avatar-path': good1 }), el({ 'data-avatar-path': good2 }), el({ 'data-avatar-path': 'https://evil.example/x.png' }),
    el({ 'data-avatar-path': `${ORG}/${U(2)}/../../x.png` }), el({ 'data-avatar-path': 'data:image/svg+xml,<svg onload=alert(1)>' })];
  const rootEl = { querySelectorAll: () => els.filter((x) => !x.hasAttribute('data-av-done')) };
  await e.S.chat.paintAvatars(rootEl);
  const signed = e.signs.flatMap((s) => s[1]);
  assert.deepEqual(signed.sort(), [good1, good2].sort(), 'only our own bucket keys are signed');
  assert.ok(e.signs.every((s) => s[0] === 'member-avatars'));
  if (!(e.S.profile && typeof e.S.profile.avatarUrl === 'function')) assert.equal(e.signs.length, 1, 'one batched call for the page');
  assert.equal(els[0].children.length, 1); assert.equal(els[0].children[0].tagName, 'IMG');
  assert.match(els[0].children[0].src, /^https:\/\/sb\.test\/sign\//); assert.equal(els[0].children[0].alt, '');
  for (const k of [2, 3, 4]) assert.equal(els[k].children.length, 0, 'refused paths keep the initials');
  // second paint (re-render) → from cache, no new signing
  const before = e.signs.length;
  const again = [el({ 'data-avatar-path': good1 })];
  await e.S.chat.paintAvatars({ querySelectorAll: () => again });
  assert.equal(e.signs.length, before); assert.equal(again[0].children.length, 1);
  // signing fails → initials stay (no broken image)
  const f = await makeEnv({ signFail: true });
  const one = [el({ 'data-avatar-path': good1 })];
  await f.S.chat.paintAvatars({ querySelectorAll: () => one });
  assert.equal(one[0].children.length, 0);
});
t('chat.html: photo avatars in the DM list, thread header, senders, @mention + people pickers; escaped; job title in DM header', () => {
  const ctx = { esc, roster: { [U(2)]: { id: U(2), full_name: 'Ravi Kumar', avatar_path: AV(U(2)) }, [U(3)]: { id: U(3), full_name: 'No Photo' },
    [U(4)]: { id: U(4), full_name: 'Evil', avatar_path: '"><script>x</script>' } },
    colorFor: () => '#123', initials: (s) => s.slice(0, 2).toUpperCase(), personName: (id) => (ctx.roster[id] || {}).full_name || 'Member' };
  vm.runInNewContext(['photoOf', 'photoAttr', 'personAv'].map((f) => fnSrc(chat, f)).join('\n') + '\nglobalThis.av=personAv;', ctx);
  assert.match(ctx.av(U(2)), new RegExp(`data-avatar-path="${AV(U(2)).replace(/[.]/g, '\\.')}">RA</div>$`));
  assert.equal(ctx.av(U(3)), '<div class="av" style="background:#123;">NO</div>', 'no photo → initials only');
  assert.doesNotMatch(ctx.av(U(4)), /<script>/); assert.match(ctx.av(U(4)), /&quot;&gt;&lt;script&gt;/);
  assert.match(chat, /\$\{c\.kind==="dm"\?personAv\(convOther\(c\)\):avHtml\(a\)\}/, 'DM list');
  assert.match(chat, /const ph=c\.kind==="dm"\?photoOf\(convOther\(c\)\):""; av\.removeAttribute\("data-av-done"\)/, 'thread header');
  assert.match(chat, /<div class="who" style="color:\$\{colorFor\(m\.sender_id\)\}">\$\{personAv\(m\.sender_id,/, 'message senders');
  assert.match(chat, /<span class="av" style="background:\$\{colorFor\(p\.id\)\}"\$\{photoAttr\(p\.id\)\}>/, '@mention picker');
  assert.match(fnSrc(chat, 'prowAvatar'), /data-avatar-path="\$\{esc\(p\.avatar_path\)\}"/, 'new chat / group / add members');
  assert.equal((chat.match(/document\.body\.appendChild\(ov\); paintAv\(ov\);/g) || []).length, 3);
  assert.match(chat, /\$\("#tSub"\)\.textContent=\(p&&p\.job_title\)\|\|\(p&&roleLbl\(p\.role\)\)\|\|""/);
  assert.match(read('public/quotes.html'), /class="egav"\$\{p\.avatar_path\?` data-avatar-path="\$\{esc\(p\.avatar_path\)\}"`:""\}/, 'event-group member picker');
});

/* ------------------------------------------------------------ audit log names */
t('audit: actor shown by display name (e-mail on hover), else e-mail, else "system"', async () => {
  const e = await makeEnv({ rpc: { audit_actor_names: { data: [{ id: U(2), full_name: 'Ravi Kumar', email: 'ravi@a.test' }, { id: U(3), full_name: '  ', email: 'blank@a.test' }], error: null } } });
  const names = await e.S.audit.actorNames();
  const L = (r) => J(e.S.audit.actorLabel(r, names));
  assert.deepEqual(L({ actor: U(2), actor_email: 'ravi@a.test' }), { text: 'Ravi Kumar', title: 'ravi@a.test' });
  assert.deepEqual(L({ actor: U(3), actor_email: 'blank@a.test' }), { text: 'blank@a.test', title: 'blank@a.test' });
  assert.deepEqual(L({ actor: U(9), actor_email: 'gone@a.test' }), { text: 'gone@a.test', title: 'gone@a.test' });
  assert.deepEqual(L({ actor: null, actor_email: null }), { text: 'system', title: '' });
  assert.deepEqual(J(e.S.audit.actorIdsMatching(names, 'ravi')), [U(2)]);
  // name search reaches the server as actor.in.(ids) inside the same or=()
  await e.S.audit.page({ search: 'ravi', actorIds: [U(2), 'not-a-uuid);drop'] });
  const q = e.queries.find((x) => x.table === 'audit_log'); const or = q.calls.find((c) => c[0] === 'or')[1];
  assert.match(or, new RegExp(`,actor\\.in\\.\\(${U(2)}\\)$`)); assert.doesNotMatch(or, /drop/);
  const f = await makeEnv({ rpc: { audit_actor_names: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } } } });
  assert.deepEqual(J(await f.S.audit.actorNames()), {}, 'before 0041 → e-mails as today');
  // audit.html renders it escaped, with the e-mail in title
  const ctx = { esc, names, BPStore: e.S };
  vm.runInNewContext(fnSrc(auditHtml, 'whoCell') + '\nglobalThis.f=whoCell;', ctx);
  assert.equal(ctx.f({ actor: U(2), actor_email: 'ravi@a.test' }), '<td class="who" title="ravi@a.test">Ravi Kumar</td>');
  const ctx2 = { esc, names: { [U(5)]: { full_name: '<img src=x>' } }, BPStore: e.S };
  vm.runInNewContext(fnSrc(auditHtml, 'whoCell') + '\nglobalThis.f=whoCell;', ctx2);
  assert.doesNotMatch(ctx2.f({ actor: U(5), actor_email: 'e@a.test' }), /<img/);
  assert.match(auditHtml, /actorIds: BPStore\.audit\.actorIdsMatching\(names, \$\("#fSearch"\)\.value\)/);
});
t('audit: profile changes render field old → new (masked numbers; emergency number only "changed")', () => {
  const ctx = { esc };
  vm.runInNewContext(fnSrc(auditHtml, 'short') + '\n' + fnSrc(auditHtml, 'renderChange') + '\nglobalThis.f=renderChange;', ctx);
  const html = ctx.f({ action: 'profile.update', changed: { phone: { old: '+91******3210', new: '+91******0001' }, emergency_contact_phone: { changed: true, set: true }, by: 'admin' } });
  assert.match(html, /phone<\/span>: <span class="o">\+91\*\*\*\*\*\*3210<\/span> → <span class="n">\+91\*\*\*\*\*\*0001/);
  assert.match(html, /emergency_contact_phone<\/span>: <span class="n">changed/); assert.match(html, /by an admin/);
  assert.doesNotMatch(ctx.f({ action: 'profile.update', changed: { job_title: { old: null, new: '<b>x</b>' } } }), /<b>x/);
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('ok - ' + name); }
  catch (e) { fail++; console.log('not ok - ' + name + ': ' + (e && e.stack || e)); }
}
console.log(`\nmember-profile-ui: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
