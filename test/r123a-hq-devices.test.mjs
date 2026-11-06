// r123a-hq-devices.test.mjs - R123a Helm HQ "Where you're logged in", front-end half.
//  A  a "Your devices" page in Team & safety for EVERY HQ role (TAB_PERM account = self), its title + subtitle
//  B  the table: Device | Location | Signed in | Last active | IP address | Action, 10 a page, Current badge, cards on phones
//  C  "Sign out" per other device + "Log out of all other devices" with a confirm, disabled while running, list reloaded
//  D  textContent only (no innerHTML) in the new code; a signed-out sign-in shows "Session expired" (the shared HQ path)
//  E  the HQ team list shows the server's device name + location per sign-in
//  F  page tour step, ACT_WORDS for the new log rows, pager page size, asset versions + MANIFEST / APPLY-0332
// Static + pure-function checks; the database side: tests/db/r123a-hq-devices-0332.sql.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const J = rd('public/hq.js'), H = rd('public/hq.html'), T = rd('public/page-tours.js');
const S = require('../public/hq-staff.js');
let n = 0;
const fail = (name, e) => { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; };
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { fail(name, e); } };
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'function ' + name + ' not found');
  let d = 0; const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } }
  throw new Error('unbalanced ' + name);
}

// a tiny DOM: enough for el() / clear() / pager()
function fakeDoc() {
  const mk = (tag) => ({ tag, children: [], attrs: {}, textContent: '', className: '', disabled: false, listeners: {},
    setAttribute(k, v) { this.attrs[k] = String(v); }, appendChild(c) { this.children.push(c); return c; },
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); }, get firstChild() { return this.children[0] || null; },
    addEventListener(e, f) { this.listeners[e] = f; } });
  return { createElement: mk, createTextNode: (s) => ({ tag: '#text', textContent: s }) };
}
const text = (node) => node.tag === '#text' ? node.textContent : (node.textContent || '') + node.children.map(text).join('');

t('A every HQ role gets the page (own sign-ins only); title + subtitle; nav button + pane in hq.html', () => {
  assert.equal(S.TAB_PERM.account, 'self');
  for (const r of Object.keys(S.ROLE_PERMS)) assert.ok(S.allowedTabs(S.ROLE_PERMS[r]).includes('account'), r);
  assert.match(J, /var TABS = \[[^\]]*"privacy", "account"\];/);
  assert.match(J, /account: "Where you’re logged in" \};/);
  assert.match(J, /\$\("#navgTeam"\)\.hidden = !\["people", "activity", "staff", "settings", "privacy", "account"\]\.some\(canTab\);/);
  assert.match(H, /<button type="button" class="tab" id="tab-account" aria-pressed="false">Your devices<\/button>/);
  assert.match(H, /<section id="pane-account" hidden>/);
  assert.match(J, /if \(t === "account"\) loadDevices\(0\)\.catch\(showErr\);/);
  assert.match(J, /if \(!\$\("#pane-account"\)\.hidden\) loadDevices\(dvOff\)\.catch\(showErr\);/);
});
t('B the table columns, 10 a page, cards on phones (class rt -> data-label from the headings)', () => {
  assert.match(H, /<table class="rt" id="dvTable"><thead><tr><th>Device<\/th><th>Location<\/th><th>Signed in<\/th><th>Last active<\/th><th>IP address<\/th><th>Action<\/th><\/tr><\/thead><tbody id="tDevices"><\/tbody><\/table>/);
  assert.match(H, /<div class="pager" id="pgDevices"><\/div>/);
  assert.match(J, /var DV_PAGE = 10, dvOff = 0;/);
  const ld = fnSrc(J, 'loadDevices');
  assert.match(ld, /call\("hq_my_sessions", \{ p_limit: DV_PAGE, p_offset: dvOff \}\)/);
  assert.match(ld, /pager\(\$\("#pgDevices"\), dvOff, total, function \(o\) \{ loadDevices\(o\)\.catch\(showErr\); \}, DV_PAGE\)/);
  assert.match(ld, /return loadDevices\(Math\.max\(0, dvOff - DV_PAGE\)\)/);   // the last page emptied -> one page back
});
t('B pager: optional page size (10 for devices), 25 by default for the older lists', () => {
  const doc = fakeDoc(); const cx = { document: doc, PAGE: 25 }; vm.createContext(cx);
  vm.runInContext([fnSrc(J, 'el'), fnSrc(J, 'clear'), fnSrc(J, 'pager')].join('\n') + '\nthis.pager = pager; this.el = el;', cx);
  const node = cx.el('div'); const went = [];
  cx.pager(node, 10, 23, (o) => went.push(o), 10);
  assert.equal(text(node.children[0]), '11–20 of 23');
  assert.equal(node.children[1].disabled, false); assert.equal(node.children[2].disabled, false);
  node.children[2].listeners.click(); node.children[1].listeners.click();
  assert.deepEqual(went, [20, 0]);
  const n2 = cx.el('div'); cx.pager(n2, 0, 23, () => {});
  assert.equal(text(n2.children[0]), '1–23 of 23'); assert.equal(n2.children[2].disabled, true);
});
t('B a row: device + Current badge, location, signed in, "Now" / last active, masked IP, Sign out only where allowed', () => {
  const doc = fakeDoc(); const cx = { document: doc, S, window: { confirm: () => true }, num: (v) => (isFinite(+v) ? +v : 0),
    when: (v) => (v ? 'ago:' + v : 'never'), date: (v) => (v ? 'D' : '—'), hhmm: () => 'T', call: () => Promise.resolve({}), okMsg() {}, busy() {},
    loadDevices: () => Promise.resolve(), dvOff: 0 };
  vm.createContext(cx);
  vm.runInContext([fnSrc(J, 'el'), fnSrc(J, 'teamAction'), fnSrc(J, 'dateTime'), fnSrc(J, 'deviceRow')].join('\n') + '\nthis.deviceRow = deviceRow;', cx);
  const cur = cx.deviceRow({ sid: 'aaaa1111', device: 'Chrome (Mac OS X)', location: 'Hyderabad, India', ip: '203.0.113.x',
    signed_in: '2026-11-03T08:00:00Z', last_active: '2026-11-03T09:00:00Z', is_current: true, status: 'current', can_sign_out: false });
  const tds = cur.children;
  assert.equal(tds.length, 6);
  assert.equal(text(tds[0]), 'Chrome (Mac OS X) Current');
  assert.equal(tds[0].children[2].className, 'pill ok');
  assert.equal(text(tds[1]), 'Hyderabad, India'); assert.equal(text(tds[2]), 'D, T'); assert.equal(text(tds[3]), 'Now');
  assert.equal(text(tds[4]), '203.0.113.x'); assert.equal(tds[5].children.length, 0, 'no Sign out on this device');
  const other = cx.deviceRow({ sid: 'bbbb2222', device: 'Safari (iPhone)', location: null, ip: null, signed_in: 'x', last_active: 'y',
    is_current: false, status: 'active', can_sign_out: true });
  assert.equal(text(other.children[1]), 'Unknown'); assert.equal(text(other.children[3]), 'ago:y'); assert.equal(text(other.children[4]), '—');
  assert.equal(text(other.children[5].children[0]), 'Sign out');
  const gone = cx.deviceRow({ sid: 'cccc3333', device: 'Firefox (Linux)', status: 'signed_out', can_sign_out: false, is_current: false });
  assert.equal(text(gone.children[0]), 'Firefox (Linux) Signed out'); assert.equal(gone.children[5].children.length, 0);
});
t('C sign out one / all other devices: confirm, disabled while running, reloads; the right RPCs', () => {
  const dr = fnSrc(J, 'deviceRow');
  assert.match(dr, /if \(x\.can_sign_out && x\.sid\) act\.appendChild\(teamAction\("Sign out", ""/);
  assert.match(dr, /window\.confirm\("Sign out "/);
  assert.match(dr, /call\("hq_sign_out_my_session", \{ p_sid: x\.sid \}\)/);
  const so = fnSrc(J, 'signOutOthers');
  assert.match(so, /if \(!b \|\| b\.disabled\) return;/);
  assert.match(so, /window\.confirm\("Log out of Helm HQ on every other device\?/);
  assert.match(so, /busy\(b, function \(\) \{ return call\("hq_sign_out_my_other_sessions"\)/);
  assert.match(so, /return loadDevices\(0\);/);
  assert.match(H, /<button class="btn danger" id="btnDvAll" type="button">Log out of all other devices<\/button>/);
  assert.match(J, /on\("#btnDvAll", "click", signOutOthers\);/);
  // teamAction keeps the button disabled while the call runs (r122 G)
  assert.match(fnSrc(J, 'teamAction'), /if \(b\.disabled\) return; fn\(function \(job\) \{ return busy\(b, job\); \}\);/);
});
t('D textContent only in the new code; ended / signed-out sign-in -> "Session expired" screen (shared HQ path)', () => {
  for (const f of ['deviceRow', 'loadDevices', 'signOutOthers', 'dateTime', 'sessDevice']) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(fnSrc(J, f)), f);
  assert.equal(S.errKind({ message: 'not authorized: HQ_SESSION_ENDED this sign-in was ended - sign in again' }), 'ended');
  assert.match(fnSrc(J, 'mapCallErr'), /if \(k === "idle" \|\| k === "expired" \|\| k === "ended"\) \{ sessionOver\(S\.friendly\(k\)\);/);
  assert.match(fnSrc(J, 'beat'), /if \(k === "idle" \|\| k === "expired" \|\| k === "ended"\) sessionOver\(S\.friendly\(k\)\)/);
});
t('D sessionStatus words + tones', () => {
  assert.deepEqual(S.sessionStatus('current'), ['Current', 'ok']);
  assert.deepEqual(S.sessionStatus('signed_out'), ['Signed out', 'bad']);
  assert.deepEqual(S.sessionStatus('expired'), ['Expired', 'warn']);
  assert.deepEqual(S.sessionStatus('ended'), ['Ended', '']);
  assert.deepEqual(S.sessionStatus('weird'), ['weird', '']);
});
t('E HQ team list: server device name + location (raw browser text only as a fallback); last device in the summary line', () => {
  const cx = { S }; vm.createContext(cx); vm.runInContext(fnSrc(J, 'sessDevice') + '\nthis.sessDevice = sessDevice;', cx);
  assert.equal(cx.sessDevice({ device_label: 'Claude Desktop (Mac OS X)', device: 'x' }), 'Claude Desktop (Mac OS X)');
  assert.equal(cx.sessDevice({ device: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1' }), 'Safari on iPhone');
  const tr = fnSrc(J, 'teamRow');
  assert.match(tr, /sessDevice\(z\) \+ \(z\.current \? " \(this one\)" : ""\)/);
  assert.match(tr, /z\.location && z\.location !== "Unknown" \? z\.location : ""/);
  assert.match(tr, /"Last active in HQ " \+ when\(x\.last_active_at\) \+ \(lastDev && x\.last_active_at \? " on " \+ lastDev : ""\)/);
});
t('F tour step, log words, privacy table row', () => {
  assert.match(T, /\{ sel: "#tab-account", side: "right", title: "Where you're logged in"/);
  assert.match(J, /"hq\.self\.signout_others": "logged out of all other devices", "hq\.self\.signout_one": "signed out one of their devices"/);
  assert.match(H, /HQ staff sessions, devices, short IP, rough location/);
});
t('F asset versions bumped together; MANIFEST + APPLY-0332 (0331 left free)', () => {
  assert.match(H, /<script src="hq-staff\.js\?v=3"><\/script>/);
  assert.match(H, /<script src="hq\.js\?v=37"><\/script>/);
  assert.match(H, /<script src="page-tours\.js\?v=21"><\/script>/);
  const M = rd('supabase/migrations/MANIFEST');
  assert.match(M, /^forward  supabase\/migrations\/0332_r123a_hq_devices\.sql$/m);
  const A = rd('supabase/APPLY-0332.sql'), MIG = rd('supabase/migrations/0332_r123a_hq_devices.sql');
  assert.ok(A.includes(MIG), 'APPLY-0332 carries the migration verbatim');
  assert.match(A, /\nbegin;\n/); assert.match(A, /\ncommit;\n/);
  assert.match(A, /raise exception 'STOP 0332: 0330 \(R122\) is not applied/);
  assert.equal((A.match(/^ {2}\('\d\d /gm) || []).length, 10, 'ten numbered VERIFY rows');
  assert.ok(!/[^\x00-\x7F]/.test(A), 'ASCII only');
  assert.ok(!/\b(drop table|drop column|delete from|truncate)\b/i.test(MIG), 'nothing destructive');
  assert.ok(!/grant[^;]*to anon/i.test(MIG), 'no grant to anon');
});
console.log(n + ' passed');
