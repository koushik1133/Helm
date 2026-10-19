// r20 coord (d) - live-QA findings:
//  19. Staff page trial note: teammates (non-admins) get teammate wording; the admin keeps the owner text
//  31. Pay (day rate + pay-like custom fields) on a staff row LINKED to a team login (profile_id) is shown
//      and editable ONLY for the studio admin - hidden (not masked) for everyone else, including the person
//      on their own record. Hidden or left empty on a linked row -> no day_rate key is sent (value kept).
//      Plain crew (no login) keep the day rate as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const API = read('public/store-api.js'), STAFF = read('public/staff.html'), CTL = read('public/control.html'), TJS = read('public/trial.js');
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const ctx = vm.createContext({});
vm.runInContext(['staffPayVisible', 'staffPayAttr', 'staffPayPatch'].map((n) => fnSrc(API, n)).join('\n') +
  '\nthis.H = { show: staffPayVisible, attr: staffPayAttr, patch: staffPayPatch };', ctx);
const H = ctx.H;
const J = (x) => JSON.parse(JSON.stringify(x));
const linked = { id: 'c1', profile_id: 'u1', day_rate: 2500 }, plain = { id: 'c2', profile_id: null, day_rate: 1800 };

test('showPay: linked team login -> admin only; plain crew / new record -> everyone', () => {
  assert.equal(H.show(linked, true), true);
  assert.equal(H.show(linked, false), false);
  assert.equal(H.show(linked, undefined), false, 'unknown role is not admin');
  assert.equal(H.show(plain, false), true);
  assert.equal(H.show(plain, true), true);
  assert.equal(H.show(null, false), true, 'a new record has no login link');
});

test('pay patch: hidden or empty-on-linked sends NO day_rate key (stored value preserved)', () => {
  assert.deepEqual(J(H.patch(linked, false, 9999)), {}, 'non-admin can never send a linked rate');
  assert.deepEqual(J(H.patch(linked, false, null)), {});
  assert.deepEqual(J(H.patch(linked, true, null)), {}, 'admin leaving the optional box empty keeps the saved rate');
  assert.deepEqual(J(H.patch(linked, true, '')), {});
  assert.ok(!('day_rate' in H.patch(linked, true, undefined)));
  assert.deepEqual(J(H.patch(linked, true, 3000)), { day_rate: 3000 }, 'admin can still set it');
  assert.deepEqual(J(H.patch(linked, true, 0)), { day_rate: 0 }, '0 is a value, not empty');
  // plain crew: today's behaviour
  assert.deepEqual(J(H.patch(plain, false, 2000)), { day_rate: 2000 });
  assert.deepEqual(J(H.patch(plain, false, null)), { day_rate: null });
  assert.deepEqual(J(H.patch(null, false, 1500)), { day_rate: 1500 });
});

test('pay-like custom fields are recognised (and ordinary ones are not)', () => {
  for (const [k, l] of [['monthly_salary', 'Monthly salary'], ['wage', ''], ['ctc', 'CTC'], ['x', 'Pay per event'], ['day_rate', ''], ['stipend', '']])
    assert.equal(H.attr(k, l), true, k);
  for (const [k, l] of [['upi', 'UPI ID'], ['blood_group', 'Blood group'], ['payment_terms_note', 'Notes'], ['shirt_size', 'Shirt size'], ['address', 'Address']])
    assert.equal(H.attr(k, l), false, k);
});

test('store-api exposes the helpers on BPStore.staff', () => {
  assert.match(API, /payVisible: staffPayVisible,\s*payAttr: staffPayAttr,\s*payPatch: staffPayPatch,/);
});

test('staff.html: card, edit sheet, attributes and save all go through the pay helpers', () => {
  assert.match(STAFF, /const showPay=BPStore\.staff\.payVisible\(s,isAdminUser\);/);
  assert.match(STAFF, /\$\{showPay&&s\.day_rate\?`<br>\$\{BPStore\.studioMoney\(s\.day_rate\)\}\/day`:""\}/, 'card /day line only when pay is shown');
  assert.match(STAFF, /attrList\("staff",s\.attributes,attrDefs\)\.filter\(a=>showPay\|\|!BPStore\.staff\.payAttr\(a\.key,a\.label\)\)/, 'card hides pay-like custom fields');
  assert.match(STAFF, /<div class="fld" id="s_rate_fld">/);
  assert.match(STAFF, /\$\("#s_rate_fld"\)\.hidden=!show;/, 'edit sheet: the field is hidden, not masked');
  assert.match(STAFF, /Not needed for team logins\./, 'admin hint on linked rows');
  assert.match(STAFF, /setLinkedLock\(s\); fillRole\(s\); setPayField\(s\);/);
  assert.match(STAFF, /payVisible\(s,isAdminUser\)\?s\.day_rate:""/, 'a hidden rate is never even put into the input');
  assert.match(STAFF, /if\(!payShown\(\)\)\{ fieldMsg\("s_rate",""\); return \{ok:true,value:null\}; \}/);
  assert.match(STAFF, /const payPart=BPStore\.staff\.payPatch\(editingId\?editingRow:null,isAdminUser,/);
  assert.match(STAFF, /\.\.\.payPart, skills,/);
  assert.ok(!/\n\s*day_rate, skills,/.test(STAFF), 'day_rate is no longer sent unconditionally');
  assert.match(STAFF, /hideAttr=\(k,l\)=>!payOk&&BPStore\.staff\.payAttr\(k,l\)/, 'attribute editor leaves pay fields out (unsent = kept)');
  assert.match(STAFF, /Employment type, skills and notes stay editable here\./, 'linked note for non-admins does not promise the day rate');
});

test('control.html member panel (admin only): optional rate with hint; empty box sends nothing', () => {
  assert.match(CTL, /id="mp_h_day_rate">Not needed for team logins\./);
  assert.match(CTL, /const dr=\$\("#mp_day_rate"\)\.value; if\(String\(dr\)\.trim\(\)!==""\) f\.day_rate=dr;/);
  assert.ok(!/f\.day_rate=\$\("#mp_day_rate"\)\.value;/.test(CTL), 'no unconditional day_rate');
  assert.match(CTL, /function initUsersTab\(\)\{ if\(!isAdmin\) return null;/, 'the member panel stays admin-only');
});

test('trial note: teammate wording for non-admins, owner wording kept for the admin', () => {
  const T = require('../public/trial.js');
  const a = { is_trial_org: true, ends_at: '2026-10-24T10:00:00Z', timezone: 'Asia/Kolkata' };
  assert.match(T.staffNoteSpec(a).text, /Invite your real team now/, 'older callers unchanged');
  assert.match(T.staffNoteSpec(a, true).text, /Invite your real team now; if you choose a plan/);
  const mate = T.staffNoteSpec(a, false).text;
  assert.match(mate, /^Your studio is on a free trial until /);
  assert.ok(!/Invite|choose a plan|Upgrade/.test(mate), 'no owner actions for a teammate');
  const ended = T.staffNoteSpec({ is_trial_org: true, read_only: true }, false);
  assert.equal(ended.tone, 'ended'); assert.match(ended.text, /when your studio admin chooses a plan/); assert.ok(!/Upgrade/.test(ended.text));
  assert.match(T.staffNoteSpec({ is_trial_org: true, read_only: true }, true).text, /Upgrade to continue/);
  assert.equal(T.staffNoteSpec({ is_trial_org: false }, false), null);
  assert.match(TJS, /renderStaffNote\(staffNoteSpec\(a, r === "admin" \|\| a\.is_owner === true\)\)/);
});
