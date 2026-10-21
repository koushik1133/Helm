// r27-hq-staff.test.mjs - Helm HQ staff roles & security (SQL 0277) + the spacious HQ redesign:
//  * hq-staff.js: the role matrix is the SAME as the database's _hq27_role_perms; tabs per role; refusal kinds; devices
//  * SQL 0277: role checked in _hq_gate / _hq_wgate (unknown = Owner only), two-step always, sessions, last Owner,
//    nothing deleted (soft remove), outbox kind hq_staff, APPLY verbatim + VERIFY, MANIFEST + run-all
//  * hq.js: hq_me first, pages / buttons hidden per role, fresh code (HQ_REAUTH) retry, idle sign-out, heartbeat,
//    HQ team page (invite / role / pause / sign out / remove) - textContent only
//  * hq.html: blocked view, re-auth dialog, HQ team cards, no inline handlers / styles / scripts
//  * comms-dispatch: the hq_staff e-mail (neutral text, steps for a new person)
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const J = rd('public/hq.js'), H = rd('public/hq.html'), SQL = rd('supabase/migrations/0277_hq_staff_roles.sql'), APPLY = rd('supabase/APPLY-0277.sql');
const S = require('../public/hq-staff.js');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

await t('matrix in hq-staff.js is exactly the database matrix (_hq27_role_perms)', () => {
  const body = SQL.slice(SQL.indexOf('function public._hq27_role_perms'), SQL.indexOf('-- what each existing HQ read needs'));
  for (const role of ['owner', 'admin', 'sales', 'security', 'support', 'viewer']) {
    const m = new RegExp(`when '${role}'\\s+then array\\[([^\\]]*)\\]`).exec(body);
    assert.ok(m, role);
    const sqlPerms = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
    assert.deepEqual(S.ROLE_PERMS[role], sqlPerms, role);
  }
});
await t('roles: Sales cannot touch billing or staff; Security can suspend but not add staff; Viewer only Overview', () => {
  assert.deepEqual(S.allowedTabs(S.ROLE_PERMS.sales), ['overview', 'studios', 'requests', 'plans']);
  assert.ok(!S.can(S.ROLE_PERMS.sales, 'billing.write') && !S.can(S.ROLE_PERMS.sales, 'billing.read'));
  assert.ok(S.can(S.ROLE_PERMS.security, 'staff.suspend') && !S.can(S.ROLE_PERMS.security, 'staff.manage'));
  assert.deepEqual(S.allowedTabs(S.ROLE_PERMS.viewer), ['overview']);
  assert.deepEqual(S.allowedTabs(S.ROLE_PERMS.owner), Object.keys(S.TAB_PERM));
  assert.ok(!S.can(S.ROLE_PERMS.admin, 'staff.manage') && S.can(S.ROLE_PERMS.owner, 'staff.manage'));
  assert.deepEqual(S.allowedTabs(S.ROLE_PERMS.support), ['overview', 'studios', 'requests', 'people']);
});
await t('refusal kinds + plain sentences; devices; IP list cleaning', () => {
  assert.equal(S.errKind({ message: 'not authorized: HQ_REAUTH enter a fresh two-step code' }), 'reauth');
  assert.equal(S.errKind({ message: 'not authorized: HQ_SESSION_IDLE Helm HQ signed you out' }), 'idle');
  assert.equal(S.errKind({ message: 'not authorized: HQ_ROLE your HQ role (Sales) can\'t do this' }), 'role');
  assert.equal(S.errKind({ message: 'not authorized' }), null);
  assert.match(S.friendly('role', 'Sales'), /Your HQ role \(Sales\) can't do this/);
  assert.equal(S.deviceName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130 Safari/537.36'), 'Chrome on Mac');
  assert.equal(S.deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1'), 'Safari on iPhone');
  assert.equal(S.deviceName(''), 'Unknown device');
  assert.deepEqual(S.ipList('203.0.113.10\n198.51.100.0/24, <script>\n'), ['203.0.113.10', '198.51.100.0/24']);
  assert.equal(S.initials('Priya Rao', 'x@y.z'), 'PR'); assert.equal(S.initials('', 'sales@helm.events'), 'S');
});
await t('SQL 0277: gates check the role, unknown = Owner only, two-step always, sessions, fresh code', () => {
  assert.match(SQL, /create or replace function public\._hq_gate\(p_entity text, p_entity_id text default null\)[\s\S]*?_hq27_require\(public\._hq27_read_perm\(p_entity\), false\)/);
  assert.match(SQL, /create or replace function public\._hq_wgate\([\s\S]*?_hq27_require\(public\._hq27_write_perm\(p_action\), true\)/);
  assert.match(SQL, /else 'owner\.only' end\s*\$\$;[\s\S]*else 'owner\.only' end/);
  assert.match(SQL, /if coalesce\(auth\.jwt\(\) ->> 'aal', ''\) <> 'aal2' then return false; end if;/);
  assert.match(SQL, /function public\._hq_require_mfa\(\)[\s\S]*?select true/);
  for (const k of ['HQ_SESSION_IDLE', 'HQ_SESSION_EXPIRED', 'HQ_SESSION_ENDED', 'HQ_REAUTH', 'HQ_ROLE', 'HQ_IP']) assert.ok(SQL.includes(k), k);
  assert.match(SQL, /'hq\.subscription\.activate'[\s\S]*?then 'billing\.write'/);
});
await t('SQL 0277: zero data loss - no DELETE of data, soft remove, append-only logs, last Owner guard', () => {
  const code = SQL.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(code, /\bdelete\s+from\b/i);
  assert.doesNotMatch(code, /\bdrop\s+(table|column)\b/i);
  assert.doesNotMatch(code, /\btruncate\b(?!\s+on)/i);
  assert.match(code, /set status = 'removed', removed_at = now\(\)/);
  assert.match(code, /create trigger a277_last_owner before update or delete on public\.platform_admins/);
  assert.match(code, /update auth\.refresh_tokens set revoked = true/);
  assert.match(code, /add constraint helm_notice_outbox_kind_check_0277/);
});
await t('APPLY-0277: migration verbatim between begin / commit + VERIFY rows; MANIFEST + run-all', () => {
  assert.ok(APPLY.includes('begin;\n' + SQL + 'commit;'));
  assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.ok(rd('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/0277_hq_staff_roles.sql'));
  assert.match(rd('scripts/db-test/run-all.sh'), /R27-HQ-STAFF-0277: ALL PASS \\\(50\/50\\\)/);
  assert.doesNotMatch(APPLY, /[^\x00-\x7F]/, 'ASCII only');
});
await t('hq.js: hq_me first, blocked states, permissions applied, re-auth retry, idle + heartbeat, no innerHTML', () => {
  assert.match(J, /ME = await BPStore\.hq\("hq_me"\)/);
  assert.match(J, /ME\.status === "suspended"\) \{ blocked\(/);
  assert.match(J, /ME\.needs_2step\) \{ blocked\("Set up two-step first"/);
  assert.match(J, /if \(k === "reauth"\) return askCode\(\)\.then\(function \(\) \{ return BPStore\.hq\(fn, args\); \}\);/);
  assert.match(J, /BPStore\.auth\.mfa\.challenge\(/);
  assert.match(J, /BPStore\.hq\("hq_heartbeat", \{ p_page:/);
  assert.match(J, /if \(Date\.now\(\) - lastInput > idleMs\) \{ sessionOver/);
  assert.match(J, /querySelectorAll\("\[data-perm\]"\)/);
  assert.match(J, /if \(canTab\("billing"\)\) jobs\.push\(loadBilling\(\)\);/);
  assert.doesNotMatch(J, /innerHTML|insertAdjacentHTML|document\.write/);
  for (const f of ['hq_staff_list', 'hq_staff_invite', 'hq_staff_set_role', 'hq_staff_suspend', 'hq_staff_restore', 'hq_staff_remove', 'hq_staff_signout', 'hq_set_staff_settings'])
    assert.ok(J.includes('"' + f + '"'), f);
  assert.doesNotMatch(J, /hq_add_operator|loadOperators/);
});
await t('hq.html: calm layout, blocked view, re-auth dialog, HQ team + matrix + rules, script order, no inline handlers / styles', () => {
  for (const id of ['vBlocked', 'blkTitle', 'reauth', 'raCode', 'tmList', 'tmEmail', 'tmRole', 'btnTmAdd', 'tmMatrix', 'tmIdle', 'tmIpOn', 'tmEvents', 'whoRole', 'crumbTitle', 'pageSub'])
    assert.ok(H.includes(`id="${id}"`), id);
  assert.match(H, /--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px;--s6:32px;--s7:48px/);
  assert.match(H, /\.topbar\{position:sticky;top:0/);
  assert.match(H, /tr\.click:hover>td\{background:var\(--panel-2\)\}/);
  assert.match(H, /<section class="card" id="tmAddCard"[^>]*data-perm="staff\.manage">/);
  assert.match(H, /<script src="hq-mfa\.js\?v=\d+"><\/script>\s*<script src="hq-staff\.js\?v=\d+"><\/script>\s*<script src="hq\.js\?v=\d+"><\/script>/);
  assert.doesNotMatch(H, /\son[a-z]+=/i); assert.doesNotMatch(H, /\sstyle="/);
  assert.doesNotMatch(H.replace(/<script src=[^>]*><\/script>/g, ''), /<script/i);
  assert.doesNotMatch(H, /id="operators"|id="btnOp"/);
});
await t('comms-dispatch: hq_staff e-mail - neutral, steps for a new person, refuses junk', async () => {
  const m = await import('../supabase/functions/comms-dispatch/helm-notices.mjs');
  assert.ok(m.NOTICE_KINDS.includes('hq_staff') && m.NOTICE_TX_REASON.hq_staff);
  const e = m.helmNoticeEmail('hq_staff', { event: 'invited', email: 'sales@helm.events', role: 'Sales', by: 'admin@helm.events' }, 'https://www.helm.events/');
  assert.match(e.subject, /sales@helm\.events was added as Sales/);
  assert.match(e.text, /https:\/\/www\.helm\.events\/login/); assert.match(e.text, /two-step/);
  assert.match(m.helmNoticeEmail('hq_staff', { event: 'suspended', email: 'ops@helm.events', reason: 'laptop lost' }, '').text, /Reason: laptop lost/);
  assert.equal(m.helmNoticeEmail('hq_staff', { event: 'invited', email: 'not-an-email' }, ''), null);
  assert.equal(m.helmNoticeEmail('hq_staff', { event: 'nope', email: 'a@b.co' }, ''), null);
});
console.log(process.exitCode ? 'r27-hq-staff: FAILED' : `r27-hq-staff: ${n} passed`);
