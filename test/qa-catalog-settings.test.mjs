// Local QA of the release build (catalog forms + Settings), Oct 2026:
//  B14  duplicate checks missed the trial's "Demo · " sample rows; venues had no duplicate check
//  B15  a short Indian number: staff save said "Something went wrong", vendors saved +9112345
//  B24  Settings "Dismiss" on the unsaved bar kept the bad values and dropped the leave-page guard
//  B29  free-trial cap said up front, settings polish (seat text, coupon note, PIN copy, Roles matrix, pickers)
// Pure logic is executed (sliced out of the shipped files, like audit-1017); wiring is checked in the source.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const tests = []; const t = (name, fn) => tests.push([name, fn]);
const slice = (src, a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + 1); assert.ok(i >= 0 && j > i, 'slice ' + a); return src.slice(i, j); };

const STORE = r('public/store-api.js'), VEN = r('public/vendors.html'), STAFF = r('public/staff.html'), INV = r('public/inventory.html');
const VA = r('public/venues-admin.js'), CS = r('public/control-split.js'), CTL = r('public/control.html'), PRIV = r('public/shell-b-privacy.js');

// ---- B14: the vendors / staff duplicate check, executed ----
const dupFrom = (src, end) => new Function(slice(src, '  const isDemoRow=', end) + '\nreturn dupCheck;')();
const vDup = dupFrom(VEN, '  async function save(){'), sDup = dupFrom(STAFF, '  async function saveStaff(){');
t('B14 vendors: "AV Solutions" next to the sample "Demo · AV Solutions" is asked about, never silently saved', () => {
  const rows = [{ id: 'd1', name: 'Demo · AV Solutions', phone: '+910000000101', is_demo: true }];
  const r1 = vDup(rows, null, 'AV Solutions', '+919876543210', 'partner');
  assert.ok(r1 && r1.ask && !r1.block, JSON.stringify(r1)); assert.match(r1.ask, /sample partner/);
  assert.ok(vDup(rows, null, 'av   solutions', null, 'partner').ask, 'case / spacing / no phone: still asked');
  assert.equal(vDup(rows, 'd1', 'Demo · AV Solutions', null, 'partner'), null, 'editing the sample row itself is not a duplicate');
  assert.ok(vDup([{ id: 'x', name: 'Demo · AV Solutions' }], null, 'AV Solutions', null, 'partner').ask, 'the name prefix alone marks a sample');
});
t('B14 vendors: a real duplicate of your OWN partner is still refused (sample rows do not mask it)', () => {
  const rows = [{ id: 'd1', name: 'Demo · AV Solutions', is_demo: true }, { id: 'o1', name: 'AV Solutions', phone: '+919876543210' }];
  assert.ok(vDup(rows, null, 'AV Solutions', '+919876543210', 'partner').block);
  assert.equal(vDup(rows, null, 'Spotlight AV', null, 'partner'), null);
});
t('B14 staff: "Arjun Naidu" next to "Demo · Arjun Naidu" -> Possible duplicate', () => {
  const rows = [{ id: 'd', name: 'Demo · Arjun Naidu', phone: '+91 00000 00103' }];
  const r1 = sDup(rows, null, 'Arjun Naidu', '+919876543210', 'staff member');
  assert.ok(r1 && r1.ask && !r1.block); assert.match(r1.ask, /sample staff member/);
  assert.ok(sDup([{ id: 'o', name: 'Arjun Naidu', phone: '+919876543210' }], null, 'Arjun Naidu', '+919876543210', 'staff member').block);
  assert.match(STAFF, /if\(dc&&dc\.ask&&!\(await BPUI\.confirm\(dc\.ask,\{title:"Possible duplicate",okLabel:"Save anyway"\}\)\)\) return;/);
});
t('B14 inventory: the normaliser strips "Demo · "; a sample match asks, your own match still refuses', () => {
  const blk = slice(INV, '      // B14: a trial sample row', '    }catch(e){ /* if the check itself');
  assert.match(blk, /replace\(\/\^\\s\*Demo \\u00b7\\s\*\/,""\)\.normalize\("NFKC"\)/);
  assert.match(blk, /const dup=same\.find\(x=>!isDemo\(x\)\), sample=same\.find\(isDemo\);/);
  assert.match(blk, /const sameName=!!\(editingItem&&editingItem\.id===editingId&&norm\(editingItem\.name\)===key\);\n\s*if\(sample && !sameName && !\(await BPUI\.confirm\([^]*title:"Possible duplicate",okLabel:"Save anyway"\}\)\)\) return;/);
  const norm = new Function('return ' + /const norm=(\(t\)=>[^;]+);/.exec(blk)[1])();
  assert.equal(norm('Demo · PA Speaker'), norm('pa  speaker')); assert.equal(norm('Demo · Sound & Light'), norm('sound and light'));
});
t('B14 review: editing your OWN record without renaming it never re-asks about the sample; a real twin is asked first', () => {
  const rows = [{ id: 'd1', name: 'Demo · AV Solutions', is_demo: true }, { id: 'o1', name: 'AV Solutions', phone: '+919876543210' }];
  assert.equal(vDup(rows, 'o1', 'AV Solutions', '+919876543210', 'partner'), null, 'vendor edit (phone / notes): no prompt');
  assert.ok(vDup(rows, 'o1', 'AV Solution', '+919876543210', 'partner') === null, 'a different name is not a match');
  const st = [{ id: 'd', name: 'Demo · Arjun Naidu', phone: '+91 00000 00103' }, { id: 'me', name: 'Arjun Naidu', phone: '+919876543210' }];
  assert.equal(sDup(st, 'me', 'Arjun Naidu', '+919876543210', 'staff member'), null, 'staff edit: no prompt');
  const ren = [{ id: 'd', name: 'Demo · Arjun Naidu', is_demo: true }, { id: 'me', name: 'Arjun N' }];
  assert.match(sDup(ren, 'me', 'Arjun Naidu', '+919876543210', 'staff member').ask, /sample staff member/, 'renamed onto the sample name: asked');
  const twin = [{ id: 'd', name: 'Demo · Arjun Naidu', is_demo: true }, { id: 'o', name: 'Arjun Naidu', phone: '+919999999999' }];
  assert.match(sDup(twin, null, 'Arjun Naidu', '+919876543210', 'staff member').ask, /different phone number/, 'your own same-named record is the message shown');
});
// venues: the new check, executed
const VD = new Function(slice(VA, '  // B14: same name ignoring case', '  function friendly(e)') + slice(VA, '  function ckey(s)', '  function filtered()') + '\nreturn { venueDup, dupNorm };')();
t('B14 venues: "Royal Banquet Hall" next to its sample is asked; same name + same city of your own is refused', () => {
  const rows = [{ id: 's', name: 'Demo · Royal Banquet Hall', city: 'Hyderabad', is_sample: true }];
  const a = VD.venueDup(rows, null, 'Royal Banquet Hall', 'Hyderabad'); assert.ok(a && a.ask && !a.block); assert.match(a.ask, /sample venue/);
  const own = [{ id: 'o', name: 'Royal Banquet Hall', city: ' hyderabad ' }];
  assert.ok(VD.venueDup(own, null, 'royal banquet hall', 'Hyderabad').block, 'same city (spacing / case ignored)');
  assert.ok(VD.venueDup(own, null, 'Royal Banquet Hall', '').block, 'no city: treated as the same place');
  assert.ok(VD.venueDup(own, null, 'Royal Banquet Hall', 'Pune').ask, 'another city: asked, not refused');
  assert.equal(VD.venueDup(own, 'o', 'Royal Banquet Hall', 'Hyderabad'), null, 'editing itself');
  const twins = [{ id: 'a', name: 'Royal Banquet Hall', city: 'Hyderabad' }, { id: 'b', name: 'Royal Banquet Hall', city: 'Hyderabad' }];
  assert.equal(VD.venueDup(twins, 'a', 'Royal Banquet Hall', 'Hyderabad'), null, 'an existing twin never blocks editing either one (same name + city kept)');
  assert.ok(VD.venueDup([{ id: 'a', name: 'Lotus Hall', city: 'Hyderabad' }, { id: 'b', name: 'Royal Banquet Hall', city: 'Hyderabad' }], 'a', 'Royal Banquet Hall', 'Hyderabad').block, 'renaming onto another venue is still refused');
  assert.match(VA, /var dc = venueDup\(state\.rows, v\.id \|\| null, r\.value\.name, r\.value\.city\);/);
  assert.ok(VA.indexOf('venueDup(state.rows') < VA.indexOf('await S.venues.save('), 'checked before the save');
});

// ---- B15: phone rule + friendlyError, executed ----
const HP = require('../public/phone-input.js');
const phoneCtx = { window: { HelmPhone: HP }, BPStore: { studioTax: () => ({ country: 'IN' }) } };
vm.createContext(phoneCtx);
vm.runInContext(slice(STORE, '  function memberPhoneE164(raw, required) {', '  function memberNormPhone(p) {') + '\nthis.E = memberPhoneE164; this.T = phoneOrThrow;', phoneCtx);
t('B15 the shared rule refuses "+91 12345" (what HelmPhone hands over for 12345) with the India message', () => {
  const v = phoneCtx.E('+9112345', true); assert.equal(v.ok, false); assert.match(v.error, /Enter a 10-digit number for India/);
  assert.equal(phoneCtx.E('+919876543210', true).ok, true); assert.equal(phoneCtx.E('', false).ok, true); assert.equal(phoneCtx.E('', true).ok, false);
});
t('B15 staff + vendors use that rule on the form (not the loose 7-15 digit check)', () => {
  assert.match(slice(STAFF, '  function checkPhone(){', '  function checkEmail(){'), /BPStore\.staff\.phoneE164\(raw,true\)/);
  assert.doesNotMatch(slice(STAFF, '  function checkPhone(){', '  function checkEmail(){'), /validate\.phone\(/);
  const sv = slice(VEN, '  async function save(){', '  function openLogin(){');
  assert.match(sv, /BPStore\.staff\.phoneE164\(\$\("#v_phone"\)\.value,false\)/); assert.doesNotMatch(sv, /V\.phone\(/);
  assert.match(sv, /fv\.setError\(pv\.error\)/, 'the message also sits under the phone field');
});
const feCtx = { global: {} }; vm.createContext(feCtx);
vm.runInContext(slice(STORE, '  function errCode(e) {', '  /* ------------------------------------------------------------- toasts */') + '\nthis.fe = friendlyError;', feCtx);
t('B15 friendlyError passes an invalid_phone message through (was "Something went wrong")', () => {
  let e = null; try { phoneCtx.T('+9112345', true); } catch (x) { e = x; }
  assert.ok(e && e.code === 'invalid_phone');
  const m = feCtx.fe(e, { action: 'save the staff member' });
  assert.match(m, /^Couldn’t save the staff member\. That number looks too short\. Enter a 10-digit number for India\.$/);
  assert.match(feCtx.fe({ code: 'other_code', message: 'x' }), /Something went wrong/, 'other coded errors unchanged');
});

// ---- B24: Discard restores, executed ----
t('B24 "Discard changes" puts each changed field back to its saved value, re-runs the page checks, then cleans', () => {
  assert.match(CS, /bDis=el\("button","cs-ghost","Discard changes"\)/);
  assert.match(CS, /bDis\.addEventListener\("click",function\(\)\{ if\(!current\) return; dirtyIn\(current\)\.forEach\(function\(c\)\{ restore\(c\); rebase\(c\); dirtyCards\.delete\(c\); \}\); paintDirty\(\); \}\);/);
  const restore = new Function('fieldsOf', 'changed', 'base', 'Event', slice(CS, '  function fval(f){', '  function group(f){') + slice(CS, '  function restore(c){', '  bDis.addEventListener') + '\nreturn restore;');
  const evs = [];
  const mk = (o) => Object.assign({ tagName: 'INPUT', type: 'number', value: '', attrs: { 'data-rejected': 'negative' }, removeAttribute(k) { delete this.attrs[k]; }, dispatchEvent(e) { evs.push([this.id, e.type]); if (this.follow && e.type === 'change') this.follow(); } }, o);
  const gst = mk({ id: 'gst', value: '150' }), chair = mk({ id: 'chair', value: '' }), same = mk({ id: 'same', value: '7' }), cb = mk({ id: 'cb', type: 'checkbox', checked: false });
  gst.follow = () => { chair.value = '999'; };   // a page handler that rewrites another box (country -> currency)
  const base = new Map([[gst, '18'], [chair, '200'], [same, '7'], [cb, '1']]);
  restore(() => [gst, chair, same, cb], (f) => base.has(f) && base.get(f) !== (f.type === 'checkbox' ? (f.checked ? '1' : '0') : f.value), base, class { constructor(t) { this.type = t; } })({});
  assert.equal(gst.value, '18'); assert.equal(chair.value, '200'); assert.equal(cb.checked, true);
  assert.equal(chair.attrs['data-rejected'], undefined, 'the "negative cleared" flag goes with it');
  assert.deepEqual(evs.filter((x) => x[0] === 'gst').map((x) => x[1]), ['input', 'change'], 'the page validators run on the restored value');
  assert.ok(!evs.some((x) => x[0] === 'same'), 'an untouched field is left alone');
  assert.match(CS, /function onEdit\(e\)\{\s*if\(!e\.isTrusted\) return;/, 'the synthetic events never re-mark the card dirty');
  assert.match(CS, /function isField\(t\)\{[^\n]*!\(t\.hasAttribute&&t\.hasAttribute\("data-cs-autosave"\)\)/, 'save-on-change fields are never tracked, so never written back');
  assert.match(CTL, /<select class="roleSel" data-cs-autosave="1"/); assert.match(CTL, /<select data-type="\$\{esc\(c\.type\)\}" data-cs-autosave="1"/);
});

// ---- B29: trial cap up front, executed ----
const mkDoc = () => { const byId = {}; return { byId, getElementById: (id) => byId[id] || null }; };
async function capRun(limits, opts, role, btn0) {
  const doc = mkDoc();
  const ctx = { global: { BPStore: { subscription: { limits: async () => limits }, auth: { cachedRole: () => role || null } } }, doc, injectCSS() {},
    h: (tag, a, txt) => { const e = { tag, id: a.id, kids: [], classList: { s: new Set([a.class]), toggle(c, on) { on ? this.s.add(c) : this.s.delete(c); }, contains(c) { return this.s.has(c); } },
      _t: txt == null ? '' : String(txt), get textContent() { return this._t + this.kids.map((k) => k.textContent).join(''); }, set textContent(v) { this._t = String(v); this.kids = []; },
      appendChild(k) { this.kids.push(k); return k; }, remove() { delete doc.byId[a.id]; } }; if (a.id) doc.byId[a.id] = e; return e; } };
  vm.createContext(ctx);
  vm.runInContext(slice(STORE, '  function trialCap(entity) {', '  global.BPUI = {') + '\nthis.capGate = capGate; this.trialCap = trialCap;', ctx);
  const btn = btn0 || { nodeType: 1, id: 'newBtn', disabled: false, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; }, insertAdjacentElement() {} };
  const c = await ctx.capGate([btn, null], 'vendors', 'partners', opts);
  return { c, btn, note: doc.byId[btn.id + '_capnote'], ctx };
}
t('B29 trial at the cap: the add button is off and "Free trial: 2 of 2 partners used" shows before any form', async () => {
  const { c, btn, note } = await capRun({ trial: true, cap: 2, used: { vendors: 2 } });
  assert.equal(c.full, true); assert.equal(btn.disabled, true); assert.equal(btn.attrs['data-cap-off'], '1');
  assert.equal(note.textContent, 'Free trial \u00b7 2 of 2 partners used \u00b7 Choose a plan \u2192'); assert.ok(note.classList.contains('is-full'));
});
t('B29 below the cap: button stays on, the count is shown; paid studio / no answer: nothing changes', async () => {
  const a = await capRun({ trial: true, cap: 2, used: { vendors: 1 } });
  assert.equal(a.btn.disabled, false); assert.equal(a.note.textContent, 'Free trial \u00b7 1 of 2 partners used');
  const p = await capRun({ trial: false, cap: 2, used: { vendors: 9 } }); assert.equal(p.c, null); assert.equal(p.btn.disabled, false); assert.equal(p.note, undefined);
  const z = await capRun(null); assert.equal(z.c, null); assert.equal(z.btn.disabled, false);
});
t('r20 cap note: soft mode only LOOKS off (aria-disabled, click still lands), keeps/restores the tooltip; teammates are told to ask the admin', async () => {
  const mk = () => ({ nodeType: 1, id: 'createBtn', disabled: false, attrs: { title: 'Start a new quote' }, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; }, insertAdjacentElement() {} });
  const opts = { soft: true, offTitle: 'Free trial limit reached \u2014 choose a plan to add more quotes' };
  const b = mk(), r = await capRun({ trial: true, cap: 2, used: { vendors: 2 } }, opts, 'admin', b);
  assert.equal(b.disabled, false, 'soft: never the disabled property (the click must reach the handler for the toast)');
  assert.equal(b.attrs['aria-disabled'], 'true'); assert.equal(b.attrs['data-cap-off'], '1'); assert.equal(b.attrs['data-cap-soft'], '1');
  assert.equal(b.attrs.title, opts.offTitle); assert.equal(b.attrs['data-cap-title'], 'Start a new quote');
  assert.equal(r.note.textContent, 'Free trial \u00b7 2 of 2 partners used \u00b7 Choose a plan \u2192');
  // back under the cap (e.g. after an upgrade / delete): everything this switched off comes back, tooltip restored
  const again = await capRun({ trial: true, cap: 2, used: { vendors: 1 } }, opts, 'admin', b);
  assert.equal(b.attrs['aria-disabled'], undefined); assert.equal(b.attrs['data-cap-off'], undefined); assert.equal(b.attrs['data-cap-soft'], undefined);
  assert.equal(b.attrs.title, 'Start a new quote'); assert.equal(again.note.textContent, 'Free trial \u00b7 1 of 2 partners used');
  const tm = await capRun({ trial: true, cap: 2, used: { vendors: 2 } }, opts, 'sales', mk());
  assert.equal(tm.note.textContent, 'Free trial \u00b7 2 of 2 partners used \u00b7 Ask your studio admin to choose a plan');
  // the note is a line of its own BELOW the dashboard button row, never inside the split button
  assert.match(STORE, /var row = b\.closest \? b\.closest\("\.hd-acts"\) : null;/);
  assert.match(STORE, /if \(row\) \{ if \(note\.parentNode !== row \|\| row\.lastElementChild !== note\) row\.appendChild\(note\); \}/);
});
t('B29 every catalog add button + new-record dialog reads the cap (inventory, vendors, staff, venues)', () => {
  for (const [src, ent] of [[INV, 'inventory_items'], [VEN, 'vendors'], [STAFF, 'crew_members']]) {
    assert.match(src, new RegExp('function gateCap\\(\\)\\{[^\\n]*BPUI\\.capGate\\([^\\n]*"' + ent + '"'));
    assert.match(src, /async function load\(\)\{\n    gateCap\(\);/);
    // L13: the dialog uses BPUI.capDialog (Save off + upgrade link); the old trialCap text stays as the fallback
    assert.match(src, new RegExp('function capHint\\(\\)\\{[^\\n]*BPUI\\.capDialog\\([^\\n]*"' + ent + '"'));
    assert.match(src, new RegExp('BPUI\\.trialCap\\("' + ent + '"\\)'));
  }
  assert.match(INV, /\$\("#itemModal"\)\.hidden=false; if\(!it\) capHint\(\);/);
  assert.match(VEN, /formDirty\.clean\(\); if\(!v\) capHint\(\);/); assert.match(STAFF, /formDirty\.clean\(\); if\(!s\) capHint\(\);/);
  assert.match(VA, /BPUI\.capGate\(\[addB\], "venues", "venues"\)/); assert.match(VA, /BPUI\.trialCap\("venues"\)/);
});
t('B29 Settings polish: seat grammar, coupon note cleared on remove, one negative message on pricing', () => {
  assert.match(CTL, /pend===1\?" \\u00b7 1 pending invite counts as a seat"/); assert.match(CTL, /\(extra===1\?"person":"people"\)/);
  assert.match(CTL, /\(\)=>BPStore\.coupons\.remove\(b\.dataset\.id\),\(\)=>\{ coStatus\(""\); return renderCoupons\(\); \}/);
  assert.match(CTL, /function pfErrEl\(inp\)\{ inp\.setAttribute\("data-own-msg","1"\);/);
  assert.match(STORE, /function negHint\(el, text, ms\) \{\n    try \{\n[^\n]*\n      if \(el\.hasAttribute && el\.hasAttribute\("data-own-msg"\)\) return;/);
});
t('B29 venue form: "notanemail" refused at the field; the fix-summary goes once nothing is flagged', () => {
  globalThis.window = globalThis; require('../public/venues-core.js');
  const V = globalThis.HelmVenues, ok = { name: 'Hall', seated_capacity: '100', length: '20', width: '10' };
  assert.deepEqual(V.validate({ ...ok, contact_email: 'notanemail' }, 'm').errors.map((e) => e.field), ['contact_email']);
  assert.equal(V.validate({ ...ok, contact_email: 'events@hall.in' }, 'm').ok, true); assert.equal(V.validate(ok, 'm').ok, true);
  assert.match(VA, /contact_email: "vf_cemail"/);
  assert.match(VA, /errBox\.getAttribute\("data-kind"\) === "fields" && !el\.querySelector\('\[aria-invalid="true"\]'\)/);
});
t('B29 Roles matrix hides the trial-off areas; the trial PIN prompt never points to the locked section', () => {
  assert.match(STORE, /trialOffAreas: \(\) => inFreeTrial\(\)\.then\(\(t\) => \(t \? Object\.keys\(TRIAL_OFF_AREAS\) : \[\]\), \(\) => \[\]\)/);
  assert.match(CTL, /AREAS=ALL_AREAS\.filter\(a=>off\.indexOf\(a\.key\)<0\)/);
  assert.match(PRIV, /function canChangePin\(\) \{ return !pinTrial && /);
  assert.match(PRIV, /In the free trial the studio privacy PIN is always 0000/);
  assert.match(STORE, /const p = Promise\.resolve\(memoRead\("trial", 15000, \(\) => swr\("trial"/, 'one shared my_trial_status per page');
});
t('B29 pickers + cards: no raw "Demo · " in drop-downs, one phone format, sample roles without "Custom:", name limits', () => {
  const on = new Function(slice(INV, '  function optName(n){', '  function openItem(it){') + '\nreturn optName;')();
  assert.equal(on('Demo · PA Speaker'), 'PA Speaker (sample)'); assert.equal(on('PA Speaker'), 'PA Speaker');
  assert.match(INV, /\$\{esc\(optName\(i\.name\)\)\}/); assert.match(r('public/capacity-shortage.js'), /text: optName\(i\.name\)/);
  assert.match(STAFF, /if\(BPStore\.staff\.isDemo&&BPStore\.staff\.isDemo\(s\)\) return esc\(s\.role\);/);
  assert.match(STAFF, /s\.phone\?phoneTxt\(s\.phone\):""/); assert.match(VEN, /v\.phone\?phoneTxt\(v\.phone\):""/);
  assert.match(STAFF, /<input id="s_name" maxlength="120"/); assert.match(INV, /<input id="i_name" maxlength="120"/);
  const C = require('../public/checkout-shortage.js'), info = { available: 0, total: 5, overdue: [], substitutes: [] };
  assert.deepEqual(C.actions(info, 10).map((x) => x.key), ['subrent']);
  assert.deepEqual(C.actions(info, 10, { event: false }).map((x) => x.key), [], 'no "Add from vendor" outside an event');
  assert.match(INV, /CS\.actions\(info, req, \{ event: !!quoteId \}\)/);
  assert.match(INV, /BPStore\.fmtStudioDate\(s,\{style:"long"\}\)/, 'check-out dates use the studio time zone');
});

t('B24 review: the saved value is re-read while the card is clean (late page fill), frozen from the first edit (country -> GST side effect)', () => {
  const touch = new Function('isField', 'cardOf', 'dirtyCards', 'fieldsOf', 'group', 'base', 'fval', slice(CS, '  function touch(f){', '  function fieldsOf(n){') + '\nreturn touch;');
  const card = {}, gst = { value: '' }, ctry = { value: 'IN' }, base = new Map(), dirty = new Set();
  const tf = touch(() => true, () => card, dirty, () => [ctry, gst], (f) => [f], base, (f) => f.value);
  tf(gst); gst.value = '12'; tf(gst);
  assert.equal(base.get(gst), '12', 'a value the page filled after the first focus is the baseline, not the empty placeholder');
  tf(ctry); dirty.add(card); ctry.value = 'AE'; gst.value = '5'; tf(gst);
  assert.equal(base.get(gst), '12', 'after the first edit the GST the page changed keeps its saved baseline, so Discard puts 12 back');
  assert.equal(base.get(ctry), 'IN');
});
for (const [name, fn] of tests) { await fn(); n++; console.log('  ok ' + name); }
console.log(`qa-catalog-settings: ${n} passed`);
