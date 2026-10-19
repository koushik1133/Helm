// live-trial-ui-r19.test.mjs - live production QA, round 19 (fix/r19-live-trial-ui-controls):
//  L8  trial menu packages: price only (the server refuses dish changes) - menu-pkg-editor.test / -validation cover the DOM
//  L9  one trial end date: the STUDIO's day of the exact end moment (trial.js endDay / daysLeft / endDayText, auth-ui Plan &
//      billing, hq.js, dashboard tour) + migration 0223 (my_trial_status in the studio zone, hq_trial_info + timezone)
//  L10 removing a reservation asks to cancel its shortage + vendor booking (statuses only, nothing deleted)
//  L12 a phone field's error message never sits inside the flex phone row
//  L13 stale form errors clear on edit; a new-record dialog at the trial cap has Save off + "Choose a plan to add more"
//  L14 no "Invite to log in" on sample (is_demo) staff
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const J = (x) => JSON.parse(JSON.stringify(x));

/* ------------------------------------------------------------------ L9 trial dates */
const T = require('../public/trial.js');
const END = '2026-10-26T22:00:00Z';                       // the QA trial: 27 Oct 03:30 IST
const IST = (d, hm = '10:00') => Date.parse(d + 'T' + hm + ':00+05:30');
t('L9 trial.js: the end day is the studio day of the end moment (27 Oct IST, never the UTC 26 Oct)', () => {
  assert.equal(T.endDay(END, 'Asia/Kolkata'), '2026-10-27');
  assert.equal(T.endDayText(END, 'Asia/Kolkata'), '27 Oct 2026');
  assert.equal(T.endDay(END, 'America/New_York'), '2026-10-26', 'another zone counts there');
  assert.equal(T.endDay('2026-10-26T18:30:00Z', 'Asia/Kolkata'), '2026-10-26', 'an end at exactly midnight IST belongs to the day before');
  assert.equal(T.endDay('2026-10-27'), '2026-10-27', 'a bare day stays as it is');
  assert.equal(T.endDay('nonsense'), null); assert.equal(T.endDayText(null), '');
});
t('L9 trial.js: banner days left, reminder labels and the end date all count the same studio days', () => {
  assert.equal(T.daysLeft(END, IST('2026-10-19'), 'Asia/Kolkata'), 8, 'day 1: 8 days to 27 Oct');
  assert.equal(T.daysLeft(END, IST('2026-10-24'), 'Asia/Kolkata'), 3);
  assert.equal(T.reminderMilestone(END, IST('2026-10-24'), 'Asia/Kolkata'), 'd5', '"3 days left" on the 24th = 3 days before 27 Oct');
  assert.equal(T.reminderMilestone(END, IST('2026-10-26'), 'Asia/Kolkata'), 'd7', '"ends tomorrow" the day before');
  assert.equal(T.reminderMilestone(END, IST('2026-10-27', '01:00'), 'Asia/Kolkata'), 'd8', '"ends today" on 27 Oct');
  assert.equal(T.reminderMilestone(END, IST('2026-10-27', '04:00'), 'Asia/Kolkata'), null, 'over');
  assert.equal(T.daysLeft(END, IST('2026-10-27', '04:00'), 'Asia/Kolkata'), null, 'past the end: unknown, never negative');
  const spec = T.reminderSpec({ is_trial_org: true, is_admin: true, ends_at: END, timezone: 'Asia/Kolkata' }, IST('2026-10-24'));
  assert.equal(spec.left, '3 days left'); assert.match(spec.body, /ends on Tuesday 27 October at 3:30 am\./);
  const note = T.staffNoteSpec({ is_trial_org: true, ends_at: END, timezone: 'Asia/Kolkata' });
  assert.match(note.text, /on Tuesday 27 October at 3:30 am/, 'Staff page: the same day');
  const TJ = read('public/trial.js');
  assert.match(TJ, /try \{ cal = daysLeft\(t\.ends_at, Date\.now\(\), t\.timezone\); \}/, 'the strip uses the same count');
  assert.match(TJ, /var left = daysLeft\(endsAt, now, tz\);/, 'the reminder uses the same count');
  assert.ok(!/day 5 \/ 7 \/ 8/.test(TJ), 'no "day 5 / 7 / 8" labels left (they were off by one for a mid-day sign-up)');
});
t('L9 trial.js: subscriptionStrip prefers the exact end (0223 ends_at_exact) in the studio zone', () => {
  const s = T.subscriptionStrip({ state: 'trial', ends_at: '2026-10-26', ends_at_exact: END, timezone: 'Asia/Kolkata' }, null, IST('2026-10-19'));
  assert.equal(s.days_left, 8);
  const old = T.subscriptionStrip({ state: 'trial', ends_at: '2026-10-27' }, null, IST('2026-10-19'), 'Asia/Kolkata');
  assert.equal(old.days_left, 8, 'a 0223 day answer counts the same');
});
t('L9 auth-ui Plan & billing: the trial end is the studio day of the exact end (27 Oct), the bare UTC day is a fallback', () => {
  const A = read('public/auth-ui.js');
  const cx = { Intl, Date, Object, String, global: {} }; vm.createContext(cx);
  vm.runInContext(fnSrc(A, 'zoneDay') + '\n' + fnSrc(A, 'trialEndDay') + '\nthis.f = trialEndDay;', cx);
  const sub = { trial_ends_at: '2026-10-26' };
  assert.equal(cx.f(sub, { is_trial_org: true, ends_at: END, timezone: 'Asia/Kolkata' }, null), '2026-10-27', 'my_trial_org exact end');
  assert.equal(cx.f(sub, null, { ends_at_exact: END, timezone: 'Asia/Kolkata' }), '2026-10-27', 'my_trial_status 0223 exact end');
  assert.equal(cx.f(sub, null, { ends_at: '2026-10-27', timezone: 'Asia/Kolkata' }), '2026-10-27', '0223 studio day');
  assert.equal(cx.f(sub, null, { ends_at: '2026-10-26' }), '2026-10-26', 'older server: the stored day');
  assert.equal(cx.f(sub, { is_trial_org: false }, null), '2026-10-26');
  cx.global.HelmTrial = T; vm.runInContext('this.f = trialEndDay;', cx);
  assert.equal(cx.f(sub, { is_trial_org: true, ends_at: END, timezone: 'Asia/Kolkata' }, null), '2026-10-27', 'via HelmTrial.endDay');
  assert.match(A, /\(sub\.trial_ends_at \? " · trial ends " \+ day\(trialEndDay\(sub, org, ts, studioTz\(st\)\) \|\| sub\.trial_ends_at\) : ""\)/);
  assert.match(A, /Promise\.all\(\[st\.subscription\.mine\(\), orgQ, tsQ\]\)/, 'the card asks for the exact end too');
});
t('L9 hq.js: the trial end in the studio zone (hq_trial_info timezone), a bare day never shifted', () => {
  const H = read('public/hq.js');
  const cx = { Date, String, isFinite }; vm.createContext(cx);
  vm.runInContext(fnSrc(H, 'date') + '\n' + fnSrc(H, 'trialDay') + '\nthis.d = date; this.f = trialDay;', cx);
  assert.equal(cx.f(END, 'Asia/Kolkata'), '27 Oct 2026');
  assert.equal(cx.f(END, null), '27 Oct 2026', 'trial studios default to India');
  assert.equal(cx.f(END, 'America/New_York'), '26 Oct 2026');
  assert.equal(cx.d('2026-10-26'), '26 Oct 2026', 'a bare day is that day in any browser zone');
  assert.equal(cx.f(null), '—');
  assert.match(H, /if \(subEnd && t\.trial_ends_at\) subEnd\.textContent = " · trial ends " \+ trialDay\(t\.trial_ends_at, tz\);/, 'the subscription line follows');
  assert.match(H, /\(ended \? "trial ended " : "trial ends "\) \+ trialDay\(t\.trial_ends_at, tz\)/);
});
t('L9 dashboard tour: the same studio-day count as the strip', () => {
  assert.match(read('public/dashboard.html'), /HelmTrial\.daysLeft\(T\.ends_at,Date\.now\(\),T\.timezone\)/);
});
t('L9 migration 0223: ASCII, additive (no table / row change), APPLY = migration + VERIFY, MANIFEST + run-all', () => {
  const m = read('supabase/migrations/0223_trial_dates_studio_zone.sql'), a = read('supabase/APPLY-0223.sql');
  for (const [n, s] of [['migration', m], ['APPLY', a]]) {
    assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(s), n + ' ASCII');
    assert.ok(!/^\s*(update|delete|truncate|insert|drop|alter)\b/im.test(s.replace(/--.*$/gm, '')), n + ': no row / table change');
    assert.ok(!/\bcreate\s+(temp|temporary)\s+table\b/i.test(s) && !/^\s*\\/m.test(s), n + ' pasteable');
  }
  assert.ok(a.includes(m.trim()), 'APPLY carries the migration verbatim');
  assert.match(a, /^begin;$/m); assert.match(a, /^commit;$/m); assert.match(a, /^-- VERIFY/m);
  assert.match(m, /v_day := \(\(v_end - interval '1 microsecond'\) at time zone v_tz\)::date;/, 'the studio day of the end moment');
  assert.match(m, /v_end := coalesce\(public\._trial_effective_end\(v_org\), \(\(s\.trial_ends_at \+ 1\)::timestamp at time zone 'UTC'\)\);/);
  assert.match(m, /if s\.status = 'trial' then v_state := case when v_end <= now\(\) then 'ended' else 'trial' end;/);
  assert.match(m, /'ends_at_exact', case when v_state <> 'none' then v_end end,/);
  assert.match(m, /'timezone', public\._td223_zone\(p_org\),/, 'hq_trial_info + timezone');
  assert.ok(!/_tu236_trial_end/.test(m.replace(/--.*$/gm, '')), 'no dependency on 0236 (0223 runs before it on a clean install)');
  const man = read('supabase/migrations/MANIFEST');
  const nums = [...man.matchAll(/^forward  supabase\/migrations\/(\d{4})_/gm)].map((x) => x[1]);
  assert.ok(nums.indexOf('0223') > nums.indexOf('0208') && nums.indexOf('0223') < nums.indexOf('0236'), '0223 after 0208, before 0236 (numeric order)');   // release/1019: 0210-0222 sit between
  assert.equal(new Set(nums).size, nums.length);
  assert.match(read('scripts/db-test/run-all.sh'), /run "trial-dates-0223" "TRIAL-DATES-0223: ALL PASS \\\(23\/23\\\)" psql -q -f tests\/db\/trial-dates-0223\.sql/);
});

/* ------------------------------------------------------------------ L10 reservation -> shortage + booking */
const mx = { window: {} }; mx.globalThis = mx; vm.createContext(mx);
vm.runInContext(read('public/capacity-shortage.js'), mx);
const SH = mx.window.HelmShortage;
const Q = 'q1', I = 'i1';
const SHORTS = [
  { id: 's1', quote_id: Q, item_id: I, source: 'vendor', status: 'requested', booking_id: 'b1', vendor_id: 'v1' },
  { id: 's2', quote_id: Q, item_id: 'i2', source: 'buy', status: 'requested' },
  { id: 's3', quote_id: Q, item_id: I, source: 'none', status: 'cancelled' },
  { id: 's4', quote_id: 'q2', item_id: I, source: 'vendor', status: 'requested', booking_id: 'b9' },
];
t('L10 pure: the open shortages of this item on this event, and their still-open vendor bookings', () => {
  assert.deepEqual(J(SH.linkedShortages(SHORTS, Q, I)).map((x) => x.id), ['s1']);
  assert.deepEqual(J(SH.cancellableBookings([SHORTS[0]], [{ id: 'b1', status: 'enquiry' }, { id: 'b2', status: 'enquiry' }])).map((x) => x.id), ['b1']);
  assert.equal(SH.cancellableBookings([SHORTS[0]], [{ id: 'b1', status: 'delivered' }]).length, 0, 'a delivered booking is left alone');
  assert.equal(SH.cancellableBookings([SHORTS[0]], [{ id: 'b1', status: 'cancelled' }]).length, 0);
  const a = SH.cancelAsk([SHORTS[0]], [{ id: 'b1' }], 'Demo · Chair');
  assert.equal(a.title, 'Also cancel the shortage and the vendor booking?');
  assert.match(a.body, /open shortage for Chair \(sample\) and a vendor booking\. Yes marks the shortage Not needed and the vendor booking Cancelled\. Nothing is deleted\./);
  assert.equal(SH.cancelAsk([{}, {}], [], 'X').title, 'Also cancel the shortages?');
});
function stubStore(answer) {
  const calls = [];
  mx.window.BPStore = {
    inventory: { shortages: async (q) => (calls.push(['shortages', q]), SHORTS) },
    stockreq: { setStatus: async (id, s) => { calls.push(['req', id, s]); return true; }, remove: async (id) => { calls.push(['DELETE req', id]); } },
    bookings: { list: async () => [{ id: 'b1', status: 'enquiry' }], update: async (id, p) => { calls.push(['booking', id, J(p)]); return true; }, remove: async (id) => { calls.push(['DELETE booking', id]); } },
  };
  mx.window.BPUI = { confirm: async (body, o) => { calls.push(['ask', o.title]); return answer; }, toast: (m) => calls.push(['toast', m]) };
  return calls;
}
t('L10 yes: shortage -> Not needed (cancelled), vendor booking -> cancelled; statuses only, nothing deleted', async () => {
  const calls = stubStore(true);
  const n = await SH.afterReservationRemoved({ quoteId: Q, itemId: I, itemName: 'Chair' });
  assert.equal(n, 2);
  assert.deepEqual(calls.filter((c) => c[0] === 'ask'), [['ask', 'Also cancel the shortage and the vendor booking?']]);
  assert.deepEqual(calls.filter((c) => c[0] === 'req'), [['req', 's1', 'cancelled']]);
  assert.deepEqual(calls.filter((c) => c[0] === 'booking'), [['booking', 'b1', { status: 'cancelled' }]]);
  assert.ok(!calls.some((c) => /^DELETE/.test(c[0])), 'nothing deleted');
});
t('L10 no: nothing changes; no linked shortage: nothing is asked', async () => {
  let calls = stubStore(false);
  assert.equal(await SH.afterReservationRemoved({ quoteId: Q, itemId: I }), 0);
  assert.ok(!calls.some((c) => c[0] === 'req' || c[0] === 'booking'));
  calls = stubStore(true);
  assert.equal(await SH.afterReservationRemoved({ quoteId: Q, itemId: 'i-none' }), 0);
  assert.ok(!calls.some((c) => c[0] === 'ask'), 'not asked');
});
t('L10 inventory: Remove (and status Cancelled) on a reservation offer the cancel, after the reservation change', () => {
  const inv = read('public/inventory.html');
  assert.match(inv, /await BPStore\.inventory\.removeRes\(b\.dataset\.del\); BPUI\.toast\("Reservation removed\.",\{type:"ok"\}\); \}\s*catch\(e\)\{[^\n]*return; \}\s*\/\/ L10[^\n]*\n\s*await resLinkedCancel\(b\.closest\("tr"\), b\.dataset\.name\);/);
  assert.match(inv, /if\(next==="cancelled"\) await resLinkedCancel\(s\.closest\("tr"\)\);/);
  assert.match(inv, /HelmShortage\.afterReservationRemoved\(\{ quoteId, itemId, itemName: name\|\|it\.name\|\|"" \}\)/);
});

/* ------------------------------------------------------------------ L12 phone row */
t('L12 phone-input: anything added to the phone row is moved to just after it (the input keeps its width)', () => {
  const P = read('public/phone-input.js');
  assert.match(P, /keepRowClean\(wrap, \[btn, input, pop\]\);/);
  const body = fnSrc(P, 'keepRowClean');
  assert.match(body, /new MutationObserver\(sweep\)\.observe\(wrap, \{ childList: true \}\)/);
  // run the sweep on a tiny fake DOM
  const mk = (tag) => ({ tag, nodeType: 1, parentNode: null, childNodes: [] });
  const parent = mk('div'), wrap = mk('div.hp'), btn = mk('button'), input = mk('input'), pop = mk('div.pop'), err = mk('span.fv-msg'), after = mk('next');
  const ins = (p, c, ref) => { if (c.parentNode) c.parentNode.childNodes.splice(c.parentNode.childNodes.indexOf(c), 1); const i = ref ? p.childNodes.indexOf(ref) : -1; if (i < 0) p.childNodes.push(c); else p.childNodes.splice(i, 0, c); c.parentNode = p; };
  [wrap, after].forEach((c) => ins(parent, c)); [btn, input, err, pop].forEach((c) => ins(wrap, c));
  Object.defineProperty(wrap, 'nextSibling', { get() { const i = parent.childNodes.indexOf(wrap); return parent.childNodes[i + 1] || null; } });
  parent.insertBefore = (c, ref) => ins(parent, c, ref);
  const cx = { Array, MutationObserver: function () { return { observe() {} }; } }; vm.createContext(cx);
  vm.runInContext(body + '\nthis.k = keepRowClean;', cx);
  cx.k(wrap, [btn, input, pop])();
  assert.deepEqual(wrap.childNodes.map((c) => c.tag), ['button', 'input', 'div.pop'], 'only the phone parts stay in the row');
  assert.deepEqual(parent.childNodes.map((c) => c.tag), ['div.hp', 'span.fv-msg', 'next'], 'the message sits right after the row');
});
t('L12 flow-validate: a HelmPhone field anchors its message on the whole phone row', () => {
  const F = read('public/flow-validate.js');
  const cx = {}; vm.createContext(cx); vm.runInContext(fnSrc(F, 'anchorOf') + '\nthis.f = anchorOf;', cx);
  const wrap = { id: 'row' }, el = { helmPhone: { wrap }, closest: () => null };
  assert.equal(cx.f(el), wrap);
  const row = { id: 'hp' }; assert.equal(cx.f({ closest: (q) => (q === '.hp' ? row : null) }), row);
  const plain = { closest: () => null }; assert.equal(cx.f(plain), plain);
});

/* ------------------------------------------------------------------ L13 form errors + trial cap */
const API = read('public/store-api.js');
function bpui(capAnswer) {
  const a = API.indexOf('  function capHref() {'), b = API.indexOf('  global.BPUI = {', a);
  assert.ok(a > 0 && b > a, 'L13 helpers in store-api.js');
  const mkEl = (tag) => { const e = { tag, children: [], attrs: {}, hidden: true, disabled: false, ls: {},
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }, removeAttribute(k) { delete this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; }, contains(x) { return x === this || this.children.includes(x); },
    addEventListener(tp, f) { (this.ls[tp] = this.ls[tp] || []).push(f); }, fire(tp, target) { (this.ls[tp] || []).forEach((f) => f({ type: tp, target })); } };
    Object.defineProperty(e, 'textContent', { get() { return (e._t || '') + e.children.map((c) => c.textContent).join(''); }, set(v) { e._t = String(v); e.children = []; } });
    return e; };
  const doc = { createElement: mkEl, createTextNode: (s) => ({ textContent: s }) };
  const h = (tag, attrs, text) => { const e = mkEl(tag); Object.keys(attrs || {}).forEach((k) => e.setAttribute(k, attrs[k])); if (text != null) e.textContent = text; return e; };
  const cx = { doc, h, global: { location: { pathname: '/inventory.html' } }, Promise, encodeURIComponent, Math,
    trialCap: () => Promise.resolve(capAnswer), capText: (c, n) => 'Free trial: ' + Math.min(c.used, c.cap) + ' of ' + c.cap + ' ' + n + ' used. Choose a plan to add more.' };
  vm.createContext(cx);
  vm.runInContext(API.slice(a, b) + '\nthis.X = { capDialog, capDialogReset, capLimit, isCapError, clearErrOnEdit, capHref };', cx);
  return { X: cx.X, mkEl };
}
t('L13 capDialog: at the cap Save is off + "Choose a plan to add more" links to /checkout; reset undoes only that', async () => {
  const { X, mkEl } = bpui({ cap: 2, used: 2, left: 0, full: true });
  const save = mkEl('button'), err = mkEl('div');
  await X.capDialog(save, err, 'inventory_items', 'items', () => true);
  assert.equal(save.disabled, true); assert.equal(save.getAttribute('data-cap-off'), '1');
  assert.equal(err.hidden, false); assert.equal(err.textContent, 'Free trial: 2 of 2 items used. Choose a plan to add more.');
  const link = err.children.find((c) => c.tag === 'a');
  assert.equal(link.getAttribute('href'), '/checkout?next=inventory.html'); assert.equal(link.textContent, 'Choose a plan to add more');
  X.capDialogReset(save, err);
  assert.equal(save.disabled, false); assert.equal(err.hidden, true); assert.equal(err.textContent, '');
  const busy = mkEl('button'); busy.disabled = true; X.capDialogReset(busy, mkEl('div')); assert.equal(busy.disabled, true, 'a button it did not switch off stays off');
  const open = bpui({ cap: 2, used: 1, left: 1, full: false }); const s2 = open.mkEl('button'), e2 = open.mkEl('div');
  await open.X.capDialog(s2, e2, 'vendors', 'partners'); assert.equal(s2.disabled, false); assert.equal(e2.hidden, true, 'under the cap: nothing');
  const gone = bpui({ cap: 2, used: 2, full: true }); const s3 = gone.mkEl('button'), e3 = gone.mkEl('div');
  await gone.X.capDialog(s3, e3, 'vendors', 'partners', () => false); assert.equal(s3.disabled, false, 'dialog closed / now an edit: nothing');
  assert.ok(X.isCapError({ hint: 'trial_cap' }) && X.isCapError({ message: 'Free trial limit reached (2). Upgrade to add more.' }) && !X.isCapError({ message: 'x' }));
});
t('L13 clearErrOnEdit: a field edit clears the old form error; the cap message stays', () => {
  const { X, mkEl } = bpui(null);
  const box = mkEl('div'), err = mkEl('div'), field = mkEl('input');
  X.clearErrOnEdit(box, err); X.clearErrOnEdit(box, err);
  assert.equal((box.ls.input || []).length, 1, 'bound once');
  err.textContent = 'Contact name is required.'; err.hidden = false;
  box.fire('input', field); assert.equal(err.hidden, true); assert.equal(err.textContent, '');
  err.textContent = 'Name is required.'; err.hidden = false; box.fire('change', field); assert.equal(err.hidden, true);
  X.capLimit(err, { cap: 2, used: 2 }, 'leads'); box.fire('input', field);
  assert.equal(err.hidden, false, 'the cap message is not about a field'); assert.match(err.textContent, /2 of 2 leads used\. Choose a plan to add more\./);
});
t('L13 leads / inventory / vendors: wired (cap on a new-record dialog, reset on edit, refusal with the link, errors clear on edit)', () => {
  const L = read('public/leads.html'), I2 = read('public/inventory.html'), V = read('public/vendors.html');
  assert.match(L, /BPUI\.capDialog\(\$\("#lm_save"\),\$\("#lm_err"\),"leads","leads",\(\)=>!editingId&&!\$\("#leadModal"\)\.hidden\)/);
  assert.match(L, /if\(lead\) BPUI\.capDialogReset\(\$\("#lm_save"\),\$\("#lm_err"\)\)/);
  assert.match(L, /BPUI\.clearErrOnEdit\(\$\("#leadModal"\),\$\("#lm_err"\)\)/);
  assert.match(L, /if\(!id&&BPUI\.isCapError&&BPUI\.isCapError\(err\)\)\{ BPUI\.capLimit\(\$\("#lm_err"\),null,"leads"\); return; \}/);
  assert.match(I2, /BPUI\.capDialog\(\$\("#im_save"\),\$\("#im_err"\),"inventory_items","items",/);
  assert.match(I2, /else if\(window\.BPUI&&BPUI\.capDialogReset\) BPUI\.capDialogReset\(\$\("#im_save"\),\$\("#im_err"\)\);/);
  assert.match(I2, /BPUI\.clearErrOnEdit\(\$\("#itemModal"\),\$\("#im_err"\)\)/);
  assert.match(V, /BPUI\.capDialog\(\$\("#vm_save"\),\$\("#vm_err"\),"vendors","partners",/);
  assert.match(V, /else if\(window\.BPUI&&BPUI\.capDialogReset\) BPUI\.capDialogReset\(\$\("#vm_save"\),\$\("#vm_err"\)\);/);
  assert.match(V, /BPUI\.clearErrOnEdit\(\$\("#vModal"\),\$\("#vm_err"\)\)/);
  const S2 = read('public/staff.html');
  assert.match(S2, /BPUI\.capDialog\(\$\("#sm_save"\),\$\("#sm_err"\),"crew_members","staff",/);
  assert.match(S2, /if\(!editingId&&BPUI\.isCapError&&BPUI\.isCapError\(e\)\)\{ BPUI\.capLimit\(\$\("#sm_err"\),null,"staff"\); return; \}/);
  assert.match(API, /capDialog: capDialog, capDialogReset: capDialogReset, capLimit: capLimit, isCapError: isCapError, (?:capToast: capToast, )?clearErrOnEdit: clearErrOnEdit,/);
});

/* ------------------------------------------------------------------ L14 staff invite */
t('L14 staff: no "Invite to log in" on sample (is_demo) staff; inviteStaff refuses one too', () => {
  const S = read('public/staff.html');
  assert.match(S, /\$\{isAdminUser&&!linked&&s\.email&&s\.active!==false&&!BPStore\.staff\.isDemo\(s\)\?`<button class="ic" data-act="invite"/);
  assert.match(fnSrc(S, 'inviteStaff'), /if\(BPStore\.staff\.isDemo\(s\)\)\{ BPUI\.toast\("This is sample staff/);
  assert.match(API, /isDemo: \(s\) => !!\(s && \(s\.is_demo === true \|\| \/\^Demo \\u00b7 \/\.test\(String\(s\.name \|\| ""\)\)\)\),/);
});

let pass = 0;
for (const [n, f] of tests) { try { await f(); pass++; console.log('  ok  ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + (e && e.message)); } }
console.log(`live-trial-ui-r19: ${pass} passed${pass === tests.length ? '' : ', ' + (tests.length - pass) + ' FAILED'}`);
if (pass !== tests.length) process.exit(1);
