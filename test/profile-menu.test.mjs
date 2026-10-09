// Profile menu (top-right avatar) + Account settings split + 0060 studio_avatars — front end.
//  * menuModel (auth-ui.js, pure): name / initials / role / items; Control Center only when
//    the access matrix says canView('controls') === true (never a role-name shortcut)
//  * menu a11y wiring: aria-haspopup=menu, aria-expanded, role=menu/menuitem, Esc/arrows/Home/End/Tab
//  * #helm-topbar-search slot left of the avatar; not on HQ / client pages
//  * openAccount sections (profile / settings) reuse profileForm + MFA + sign-out-others; e-mail change
//  * store-api: changeEmail validates + uses updateUser; studioAvatars calls 0060 and never throws
//  * CSP: no innerHTML / inline style in the new code; versions bumped
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const AUI = read('public/auth-ui.js'), API = read('public/store-api.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const ctx = { S: () => ({ auth: { admin: { roleLabel: (r) => ({ admin: 'Admin', sales: 'Sales' })[r] || r } } }) };
vm.runInNewContext('var AV_COLORS = 8;\n' + ['initials', 'avColorIdx', 'menuModel'].map((f) => fnSrc(AUI, f)).join('\n')
  + '\nglobalThis.mm=menuModel;', ctx);
const mm = (...a) => JSON.parse(JSON.stringify(ctx.mm(...a)));
const ids = (m) => m.items.map((i) => i.id).join(',');

t('full name → initials + name + role label', () => {
  const m = mm({ id: 'u1', email: 'ananya@studio.test' }, { full_name: 'Ananya Rao' }, 'sales', false);
  assert.equal(m.name, 'Ananya Rao'); assert.equal(m.initials, 'AR'); assert.equal(m.role, 'Sales'); assert.equal(m.email, 'ananya@studio.test');
});
t('no name → e-mail local part, 2-letter initials', () => {
  const m = mm({ id: 'u1', email: 'koushik@x.test' }, null, null, false);
  assert.equal(m.name, 'koushik'); assert.equal(m.initials, 'KO'); assert.equal(m.role, '');
});
t('Control Center only when the matrix says so', () => {
  assert.equal(ids(mm({ id: 'a' }, {}, 'admin', true)), 'profile,settings,manual,control,signout');
  assert.equal(ids(mm({ id: 'a' }, {}, 'admin', false)), 'profile,settings,manual,signout');
  assert.equal(ids(mm({ id: 'a' }, {}, 'sales', 'yes')), 'profile,settings,manual,signout');   // only === true counts
});
t('links are same-origin pages only', () => {
  const m = mm({ id: 'a' }, {}, 'admin', true);
  m.items.filter((i) => i.href).forEach((i) => assert.match(i.href, /^[a-z-]+\.html$/));
});
t('avatar colour is stable and within the palette', () => {
  const a = mm({ id: 'same' }, {}, null, false).color, b = mm({ id: 'same' }, {}, null, false).color;
  assert.equal(a, b); assert.ok(a >= 0 && a < 8);
});
t('avatar path only when a string', () => {
  assert.equal(mm({ id: 'a' }, { avatar_path: { x: 1 } }, null, false).avatarPath, null);
  assert.equal(mm({ id: 'a' }, { avatar_path: 'o/u/f.png' }, null, false).avatarPath, 'o/u/f.png');
});
t('hostile name is data (textContent), never markup', () => {
  const m = mm({ id: 'a', email: 'x@y.z' }, { full_name: '<img src=x onerror=alert(1)>' }, null, false);
  assert.equal(m.name, '<img src=x onerror=alert(1)>');
  const build = fnSrc(AUI, 'buildPop');
  assert.doesNotMatch(build, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(build, /el\("p", \{ class: "hau-mh-n" \}, m\.name\)/);
});

t('menu a11y: haspopup/expanded/controls, role=menu + menuitem, keys', () => {
  const place = fnSrc(AUI, 'placeAccountButton');
  assert.match(place, /"aria-haspopup": "menu"/); assert.match(place, /"aria-expanded": "false"/); assert.match(place, /"aria-controls": "hauMenu"/);
  assert.match(place, /role: "menu"/);
  ['Escape', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].forEach((k) => assert.ok(place.includes(`"${k}"`), k));
  assert.match(fnSrc(AUI, 'buildPop'), /role: "menuitem"/);
  assert.match(fnSrc(AUI, 'openMenu'), /setAttribute\("aria-expanded", "true"\)/);
  assert.match(fnSrc(AUI, 'closeMenu'), /setAttribute\("aria-expanded", "false"\)/);
  assert.match(fnSrc(AUI, 'openMenu'), /addEventListener\("mousedown", outside, true\)/);   // click-outside closes
});
t('search slot sits immediately left of the avatar; menu not on HQ / client pages', () => {
  const place = fnSrc(AUI, 'placeAccountButton');
  const slot = place.indexOf('id: "helm-topbar-search"'), btn = place.indexOf('id: "hauAccountBtn"');
  assert.ok(slot > 0 && btn > slot);
  const hid = fnSrc(AUI, 'menuHidden');
  assert.match(hid, /"hq"/); assert.match(hid, /=== "client"/);
});
t('sign out reuses the page Log out button (unsaved-changes checks kept)', () => {
  assert.match(fnSrc(AUI, 'runItem'), /getElementById\("logoutBtn"\)[\s\S]*lo\.click\(\)/);
});
t('Profile / Account settings reuse the one account panel', () => {
  const r = fnSrc(AUI, 'runItem');
  assert.match(r, /openAccount\(\{ section: "profile" \}\)/); assert.match(r, /openAccount\(\{ section: "settings" \}\)/);
  const oa = fnSrc(AUI, 'openAccount');
  assert.match(oa, /profileSection\(/); assert.match(oa, /renderMfaSection\(/); assert.match(oa, /signOutOthers\(/); assert.match(oa, /emailSection\(/);
  assert.match(fnSrc(AUI, 'closePanel'), /refreshMenuIdentity\(\)/);       // new photo / name shows in the menu
});
t('svgIcon name clash fixed (profile camera / verified icons draw)', () => {
  assert.equal((AUI.match(/function svgIcon\(/g) || []).length, 1);
  assert.match(AUI, /pathIcon\(IC_CAMERA\)/);
});
t('store-api changeEmail: validates, same-address guard, Supabase updateUser', () => {
  const at = API.indexOf('async changeEmail('); assert.ok(at > 0);
  const body = API.slice(at, API.indexOf('\n    },', at));
  assert.match(body, /email_invalid/); assert.match(body, /email_same/); assert.match(body, /supa\.auth\.updateUser\(\{ email: em \}/);
});
t('store-api studioAvatars: 0060 RPC, path-checked, never throws', () => {
  const at = API.indexOf('async studioAvatars('); assert.ok(at > 0);
  const body = API.slice(at, API.indexOf('\n    },', at));
  assert.match(body, /rpc\("studio_avatars"\)/); assert.match(body, /AVATAR_PATH_RE\.test/); assert.match(body, /catch \(e\) \{ return \{\}; \}/);
});
t('CSP: new CSS goes through __helmAdoptCss; no style= in the menu code', () => {
  const menuCode = AUI.slice(AUI.indexOf('profile menu (avatar, top-right)'), AUI.indexOf('Helm subscription (0045)'));
  assert.doesNotMatch(menuCode, /style:|\.style\.|innerHTML/);
  assert.match(AUI, /\.hau-menu\{/); assert.match(AUI, /html\[data-theme=dark\] \.hau-menu/);
});
t('versions bumped: AUTH_UI_VERSION 18, every page on store-api v=140', () => {
  assert.match(API, /const AUTH_UI_VERSION = "18";/);
  const pages = readdirSync(new URL('../public/', import.meta.url)).filter((f) => f.endsWith('.html'));
  pages.forEach((p) => { const h = read('public/' + p); const m = h.match(/store-api\.js\?v=(\d+)/); if (m) assert.equal(m[1], '140', p); });
});
t('migration 0060 + APPLY are additive, ASCII, verified', () => {
  const mig = read('supabase/migrations/0060_studio_avatars.sql'), ap = read('supabase/APPLY-0060.sql');
  assert.match(read('supabase/migrations/MANIFEST'), /0060_studio_avatars\.sql/);
  [mig, ap].forEach((s) => { assert.doesNotMatch(s, /[^\x00-\x7F]/); assert.doesNotMatch(s, /\b(drop table|delete from|truncate|alter table .* drop)\b/i); });
  assert.match(ap, /select item, ok from \(values/);
  assert.match(mig, /revoke all on function public\.studio_avatars\(\) from anon/);
});
console.log(`\nprofile-menu: ${n} passed`);
