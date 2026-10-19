// r21-no-client-role.test.mjs - team role pickers never offer "Client" (owner, r21). Front-end only: the
// 'client' role stays in ALL_ROLES / server logic as the no-access fallback.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const CC = read('public/control.html'), API = read('public/store-api.js'), OB = read('public/onboarding.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok ' + name); };

t('client stays a server-side role (ALL_ROLES untouched)', () => {
  assert.match(API, /const ALL_ROLES\s*=\s*\[[^\]]*"client"\]/);
});
t('Control Center ROLES (add user, invite link, change role, Roles & access tabs) drop client + worker', () => {
  assert.match(CC, /const ROLES = BPStore\.auth\.admin\.roles\(\)\.filter\(r=>r!=="client"&&r!=="worker"\);/);
  for (const use of ['#um_role', '#inv_role', '#roleTabs']) assert.ok(CC.includes(use), use);
  assert.match(CC, /\$\("#roleTabs"\)\.innerHTML = ROLES\.map/);
  assert.match(CC, /roles:ROLES, roleLabel:BPStore\.auth\.admin\.roleLabel/);
});
t('a client-role user shows "No access" + a blank "Choose a role…" picker, never a Client option', () => {
  assert.match(CC, /const noAccess=\(u\)=>u\.role==="client";/);
  assert.match(CC, /<span class="tag no-access">No access<\/span>/);
  assert.match(CC, /<option value="" selected disabled>Choose a role…<\/option>/);
  assert.match(CC, /u\.role&&!noAccess\(u\)&&!roles\.includes\(u\.role\)/);
});
t('the picker logic: client user gets no Client option', () => {
  const src = CC.match(/const noAccess=.*\n\s*const roleSel=.*\n/)[0];
  const roles = ['admin', 'manager', 'coordinator', 'crew'];
  const esc = (s) => String(s); const rl = (r) => r[0].toUpperCase() + r.slice(1);
  const roleSel = new Function('roles', 'rl', 'esc', src + 'return roleSel;')(roles, rl, esc);
  const html = roleSel({ role: 'client', email: 'x@y.test' }, false);
  assert.ok(!/value="client"/.test(html) && !/>Client</.test(html), html);
  assert.ok(html.includes('No access') && html.includes('Choose a role'));
  const h2 = roleSel({ role: 'manager', email: 'm@y.test' }, false);
  assert.ok(/value="manager" selected/.test(h2) && !h2.includes('No access'));
});
t('onboarding team invite picker drops client + worker', () => {
  assert.match(OB, /\.filter\(\(r\) => r !== "client" && r !== "worker"\);\s+\/\/ r21: no Client in team pickers/);
});
console.log(`r21-no-client-role: ${n} passed`);
