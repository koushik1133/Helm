// Staff page: Role / Department drop-downs driven by the studio's roles + department list (0106),
// "Invite to log in" (link only, never e-mails), login status, admin login-role sync. Static + pure logic.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const html = read('public/staff.html'), api = read('public/store-api.js'), mig = read('supabase/migrations/0106_staff_roles_departments.sql');
const t = (n, f) => { f(); console.log('  ✓ ' + n); };

// pull the pure helpers out of store-api.js and run them
const roles = api.match(/const ALL_ROLES\s*=\s*(\[[^\]]+\]);/)[1];
const labels = api.match(/const ROLE_LABELS = (\{[\s\S]*?\});/)[1];
const words = api.match(/const STAFF_ROLE_WORDS = (\[[\s\S]*?\]\]);/)[1];
const fnSrc = api.match(/function staffMatchRole\(text\) \{[\s\S]*?\n  \}/)[0];
const mergeSrc = api.match(/function staffMergeDepts\(list, defaults\) \{[\s\S]*?\n  \}/)[0];
const lib = new Function(`const ALL_ROLES=${roles}; const ROLE_LABELS=${labels}; const roleLabel=(r)=>ROLE_LABELS[r]||r; const STAFF_ROLE_WORDS=${words}; ${fnSrc}; ${mergeSrc}; return {staffMatchRole, staffMergeDepts};`)();

t('role select replaces free text; department select with inline "Add new department"', () => {
  assert.match(html, /<select id="s_role">/); assert.match(html, /<select id="s_dept">/);
  assert.doesNotMatch(html, /<input id="s_role"/); assert.doesNotMatch(html, /<input id="s_dept"/);
  assert.match(html, /value="__new__">＋ Add new department…/); assert.match(html, /BPStore\.staff\.addDepartment\(name\)/);
});
t('obvious free-text roles map; ambiguous / unknown stay custom (never lost)', () => {
  const m = lib.staffMatchRole;
  assert.equal(m('Planner'), 'planner'); assert.equal(m('event manager'), 'manager'); assert.equal(m('Lead planner'), 'planner');
  assert.equal(m('Event coordinator'), 'coordinator'); assert.equal(m('AV technician'), null); assert.equal(m('Sales manager'), null);
  assert.equal(m('client'), null); assert.equal(m(''), null);
  assert.match(html, /Custom: \$\{esc\(custom\)\}/); assert.match(html, /rkey==="custom"\?\(rsel\.dataset\.custom\|\|null\)/);
});
t('department list: studio list + used, deduped case-insensitively, defaults only when empty', () => {
  assert.deepEqual(lib.staffMergeDepts(['Sales', 'sales', ' Production '], ['X']), ['Production', 'Sales']);
  assert.deepEqual(lib.staffMergeDepts([], ['B', 'A']), ['A', 'B']);
});
t('roles come from the access-matrix roles (no Client for staff)', () => {
  assert.match(api, /staffRoles: \(\) => ALL_ROLES\.filter\(\(r\) => r !== "client"\)/);
});
t('invite to log in: admin only, needs e-mail + a defined role, uses invitations.create, never sends', () => {
  assert.match(html, /isAdminUser&&!linked&&s\.email&&s\.active!==false\?`<button class="ic" data-act="invite"/);
  assert.match(html, /const key=BPStore\.staff\.matchRole\(s\.role\);\s*if\(!key\)/);
  assert.match(html, /BPStore\.invitations\.create\(s\.email, key\)/);
  // 0131: the invite is e-mailed only through the invite-mailer queue (copy link still offered)
  assert.match(html, /BPStore\.invitations\.sendNow\(\)/);
  assert.match(html, /id="iv_copy">Copy link</);
  assert.doesNotMatch(html, /whatsapp\.send|comms\.send/i);
});
t('login status: Active user / Invited / No login', () => {
  const ls = new Function('return ' + api.match(/loginStatus\(s, invites\) \{[\s\S]*?\n    \},/)[0].replace(/^loginStatus/, 'function').replace(/,$/, ''))();
  const fut = new Date(Date.now() + 864e5).toISOString(), past = new Date(Date.now() - 864e5).toISOString();
  assert.equal(ls({ profile_id: 'u1' }, []), 'active');
  assert.equal(ls({ email: 'A@x.in' }, [{ email: 'a@x.in', status: 'pending', expires_at: fut }]), 'invited');
  assert.equal(ls({ email: 'a@x.in' }, [{ email: 'a@x.in', status: 'pending', expires_at: past }]), 'none');
  assert.equal(ls({ email: 'a@x.in' }, [{ email: 'a@x.in', status: 'revoked' }]), 'none');
  assert.equal(ls({}, []), 'none');
  assert.match(html, />Active user\$\{/); assert.match(html, />Invited<\/span>/); assert.match(html, />No login<\/span>/);
});
t('changing a linked person\'s role = admin-only login-role change via 0106 RPC, with a confirm', () => {
  assert.match(html, /const loginRoleChange=linked&&isAdminUser&&rkey&&rkey!=="custom"&&rkey!==rsel\.dataset\.orig\?rkey:null;/);
  assert.match(html, /await BPStore\.staff\.setLoginRole\(editingId, loginRoleChange\)/);
  assert.match(api, /supa\.rpc\("staff_set_login_role", \{ p_staff: staffId, p_role: role \}\)/);
  assert.match(html, /\$\("#s_role"\)\.disabled=linked&&!isAdminUser;/);
});
t('0106 migration: additive, admin-gated, definer + empty search_path, wraps admin_set_role', () => {
  assert.match(mig, /add column if not exists staff_departments text\[\] not null default/);
  assert.doesNotMatch(mig, /\bdrop table\b|\bdelete from\b|\btruncate\b/i);
  assert.match(mig, /not public\.is_admin\(\)/); assert.match(mig, /perform public\.admin_set_role\(v_prof, p_role\)/);
  for (const f of ['staff_departments()', 'staff_department_add(p_name text)', 'staff_set_login_role(p_staff uuid, p_role text)'])
    assert.match(mig, new RegExp('function public\\.' + f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\nreturns [^\\n]*security definer set search_path = \'\''), f);
  const apply = read('supabase/APPLY-0106.sql'); assert.ok(/^[\x00-\x7f]*$/.test(apply), 'APPLY-0106 ASCII'); assert.match(apply, /\) v\(item, ok\)/);
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0106_staff_roles_departments\.sql/);
  assert.match(read('scripts/db-test/run-all.sh'), /tests\/db\/staff-roles-0106\.sql/);
});
console.log('staff-roles: ok');
