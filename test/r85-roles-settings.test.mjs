// r85 - Settings -> Roles & access, made clear for non-technical admins (owner: "Managers CAN close events by
// default; each studio admin can turn it off with a clear toggle").
//   * the screen's copy of the default matrix (public/role-defaults.js) equals the database template
//     _a49_default_matrix() (latest body: migration 0239), so "Default" / "Changed" / "Reset to defaults" are honest
//   * managers can close events + settle by default (closure + settlement view + edit)
//   * every access area is in exactly one plain-English section with a one-line help text
//   * the page wires the "Managers can close events" switch, the sticky role header, Reset (with confirm)
//   * nothing stored changes: still admin_set_role_access through BPStore.auth.admin.setAccess
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const r = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok ' + name); };
const RD = require('../public/role-defaults.js');

// ---- parse the SQL template (0239 is the last create or replace of _a49_default_matrix)
const SQL = r('supabase/migrations/0239_business_area_admin_only.sql');
const body = SQL.slice(SQL.indexOf('create or replace function public._a49_default_matrix()'));
const rows = [...body.matchAll(/\('(\w+)',\s+'\{([^}]*)\}'(?:::text\[\])?,\s+'\{([^}]*)\}'(?:::text\[\])?\)/g)]
  .map((m) => [m[1], m[2] ? m[2].split(',') : [], m[3] ? m[3].split(',') : []]);
const sqlRoles = [...body.slice(body.indexOf('roles(role) as')).matchAll(/\('(\w+)'\)/g)].map((m) => m[1]).slice(0, 11);

t('role-defaults.js TEMPLATE equals the SQL _a49_default_matrix areas (0239)', () => {
  assert.ok(rows.length >= 28, 'parsed ' + rows.length);
  assert.deepEqual(Object.keys(RD.TEMPLATE).sort(), rows.map((x) => x[0]).sort());
  for (const [area, v, e] of rows) assert.deepEqual(RD.TEMPLATE[area], [v, e], area);
  assert.ok(!fs.readdirSync(new URL('../supabase/migrations/', import.meta.url))
    .some((f) => f.slice(0, 4) > '0239' && /\.sql$/.test(f) && fs.readFileSync(new URL('../supabase/migrations/' + f, import.meta.url), 'utf8')
      .includes('create or replace function public._a49_default_matrix')), 'a newer migration replaces the template - update role-defaults.js');
});

t('defaultFor mirrors the SQL rule (admin all; edit implies view) for every template role', () => {
  for (const role of sqlRoles) for (const [area, v, e] of rows) {
    if (role === 'crew') continue;   // 0143 starter set below
    const view = role === 'admin' || v.includes(role), edit = role === 'admin' || (e.includes(role) && v.includes(role));
    assert.deepEqual(RD.defaultFor(role, area), { view, edit }, role + ':' + area);
  }
  assert.deepEqual(RD.defaultFor('crew', 'runsheet'), { view: true, edit: false });
  assert.deepEqual(RD.defaultFor('designer', 'design'), { view: true, edit: true });
  assert.equal(RD.defaultFor('manager', 'close_owed'), null, 'no known default -> no badge, Reset skips it');
});

t('owner decision: managers can close events and settle accounts by default', () => {
  assert.deepEqual(RD.defaultFor('manager', 'closure'), { view: true, edit: true });
  assert.deepEqual(RD.defaultFor('manager', 'settlement'), { view: true, edit: true });
  assert.match(body, /\('closure',\s+'\{manager,planner\}',\s+'\{manager,planner\}'\)/);
});

t('every access area sits in exactly one plain-English section with help text', () => {
  const API = r('public/store-api.js');
  const keys = [...API.slice(API.indexOf('const AREAS = ['), API.indexOf('const AREA_FALLBACK')).matchAll(/\{ key: "(\w+)"/g)].map((m) => m[1]);
  const placed = RD.SECTIONS.flatMap((s) => s.rows.map((x) => x.area));
  assert.deepEqual([...placed].sort(), [...keys].sort());
  assert.equal(new Set(placed).size, placed.length);
  for (const s of RD.SECTIONS) for (const x of s.rows) assert.ok(x.help && x.help.length > 10, x.area);
  const cl = RD.SECTIONS.flatMap((s) => s.rows).find((x) => x.area === 'closure');
  assert.equal(cl.highlight, true); assert.match(cl.help, /Close events and settle accounts/);
  assert.match(fs.readFileSync(new URL('../public/role-defaults.js', import.meta.url), 'latin1'), /^[\x00-\x7f]*$/, 'ASCII');
});

const C = r('public/control.html');
t('Settings page: switch, sticky header, reset with confirm, same save path, strict CSP', () => {
  assert.match(C, /<script src="role-defaults\.js\?v=\d+"><\/script>/);
  assert.match(C, /<link rel="stylesheet" href="roles-matrix\.css\?v=\d+">/);
  assert.match(C, /<div class="rm-sticky" id="rmSticky">\s*<div class="roletabs" id="roleTabs"><\/div>/);
  assert.match(C, /<div class="rm-callout" id="mgrClose" hidden><\/div>/);
  assert.match(C, /role="switch" aria-checked="\$\{on\?"true":"false"\}" aria-label="Managers can close events"/);
  assert.match(C, /setCell\("manager","closure", on \? \{view:true, edit:false\} : \{view:true, edit:true\}\)/);
  assert.match(C, /id="rmReset"/); assert.match(C, /title:"Reset to defaults\?"/);
  assert.match(C, /BPStore\.auth\.admin\.setAccess\(role, a\.key, !!d\.view, !!\(d\.view&&d\.edit\)\)/);
  const seg = C.slice(C.indexOf('// r85: plain-English sections'), C.indexOf('// Suggested starting access for roles'));
  assert.ok(!/style="/.test(seg), 'no inline style in the r85 code');
  const css = r('public/roles-matrix.css');
  assert.match(css, /\.rm-sticky\{position:sticky;top:60px/);
  assert.match(css, /@media \(max-width:560px\)/);
});

t('resetRole writes only the rows that differ from the default, after confirm', async () => {
  const src = C.slice(C.indexOf('  const RD = window.HelmRoleDefaults'), C.indexOf('  async function initMatrix(){'))
    + C.slice(C.indexOf('  // r85: put one role back'), C.indexOf('  // r85: set one cell'));
  const calls = [];
  const ctx = { window: { HelmRoleDefaults: RD }, AREAS: [{ key: 'closure', label: 'Closure' }, { key: 'leads', label: 'Leads' }, { key: 'close_owed', label: 'Owed', permission: true }],
    MTX: { manager: { closure: { view: true, edit: false }, leads: { view: true, edit: true }, close_owed: { view: true, edit: true } } },
    cellDefault: () => ({ view: false, edit: false }), cellPending: 0, cellQueue: Promise.resolve(),
    $: () => ({ setAttribute() {}, removeAttribute() {} }), loadMatrix: async () => true, renderMatrix() {}, errMsg: () => 'E',
    BPUI: { confirm: async () => true, toast() {} }, BPStore: { auth: { admin: { roleLabel: (x) => x, setAccess: async (...a) => calls.push(a) } } } };
  vm.createContext(ctx);
  vm.runInContext(src.replace('const RD', 'var RD') + '\n;this.resetRole=resetRole;', ctx);
  return ctx.resetRole('manager', { disabled: false }).then(() => {
    assert.deepEqual(calls, [['manager', 'closure', true, true]]);
  });
});

process.on('exit', () => console.log('r85-roles-settings: ' + n + ' test(s) passed.'));
