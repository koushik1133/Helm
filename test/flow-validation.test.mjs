// Quote flow validation (owner report, Oct 2026): every field rule of steps 1-8, per-section
// "Saved" / "Not started" state, past event dates blocked (studio day), duplicate requirements,
// package without a price, sticky live-price rail, resume ("Continue where you left off").
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const F = require('../public/flow-validate.js');
const R = require('../public/flow-resume.js');
const A = require('../public/flow-autosave.js');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const flow = read('public/flow.html'), css = read('public/flow-polish.css');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
const TODAY = '2026-10-18';
const ok = (r) => r.ok, err = (r) => r.ok ? '' : r.error;

t('client name: required, trimmed, 2-80, letters, no emoji / < >', () => {
  assert.match(err(F.clientName('')), /required/);
  assert.match(err(F.clientName('   ')), /required/);
  assert.match(err(F.clientName('R')), /at least 2/);
  assert.match(err(F.clientName('12345')), /letters/);
  assert.match(err(F.clientName('!!! ...')), /letters/);
  assert.match(err(F.clientName('Ravi 🎉')), /emoji/);
  assert.match(err(F.clientName('<b>Ravi</b>')), /< or >/);
  assert.match(err(F.clientName('x'.repeat(81))), /at most 80/);
  assert.equal(F.clientName('  Ravi    Kumar ').value, 'Ravi Kumar');
  assert.ok(ok(F.clientName("D'Souza & Sons 2")));
  assert.ok(ok(F.clientName('रवि कुमार')));
});
t('email optional but well-formed; event type required', () => {
  assert.ok(ok(F.email('')));
  assert.ok(ok(F.email('ravi@x.com')));
  for (const bad of ['ravi@', 'ravi@x', 'a b@x.com', 'a..b@x.com', 'x@y.c']) assert.ok(!ok(F.email(bad)), bad);
  assert.match(err(F.eventType('')), /event type/i);
  assert.match(err(F.eventType('123')), /letters/);
  assert.ok(ok(F.eventType('Wedding')));
});
t('event date: required, real, not in the past (studio day), <= 5 years, saved date kept', () => {
  assert.match(err(F.eventDate('', { today: TODAY })), /Pick the event date/);
  assert.match(err(F.eventDate('', { today: TODAY, rejected: 'past' })), /can't be in the past/);
  assert.match(err(F.eventDate('2026-10-17', { today: TODAY })), /can't be in the past/);
  assert.match(err(F.eventDate('2026-09-01', { today: TODAY })), /can't be in the past/);
  assert.ok(ok(F.eventDate('2026-10-18', { today: TODAY })), 'today is fine');
  assert.match(err(F.eventDate('2026-02-30', { today: TODAY })), /real date/);
  assert.match(err(F.eventDate('2032-01-01', { today: TODAY })), /5 years/);
  // an existing / closed / sample event keeps its saved past date; CHANGING it to another past date is refused
  assert.ok(ok(F.eventDate('2025-12-01', { today: TODAY, original: '2025-12-01' })));
  assert.ok(!ok(F.eventDate('2025-11-30', { today: TODAY, original: '2025-12-01' })));
});
t('studio day: India = Asia/Kolkata (late UTC evening is already tomorrow in IST)', () => {
  assert.equal(F.tzFor('IN'), 'Asia/Kolkata'); assert.equal(F.tzFor('AE'), 'Asia/Dubai');
  const at = Date.UTC(2026, 9, 17, 20, 0, 0);   // 17 Oct 20:00 UTC = 18 Oct 01:30 IST
  assert.equal(F.todayIn('Asia/Kolkata', at), '2026-10-18');
  assert.equal(F.todayIn('UTC', at), '2026-10-17');
  assert.equal(F.addYears('2026-10-18', 5), '2031-10-18');
});
t('guests / plates / chairs: whole numbers in range, no decimals, no negatives, no e-notation', () => {
  assert.ok(ok(F.guests('')) && F.guests('').value === null);
  assert.equal(F.guests('300').value, 300);
  assert.equal(F.guests('1,000').value, 1000);
  assert.match(err(F.guests('0')), /at least 1/);
  assert.match(err(F.guests('-5')), /negative/);
  assert.match(err(F.guests('12.5')), /whole number/);
  assert.match(err(F.guests('1e3')), /number/);
  assert.match(err(F.guests('100001')), /at most 1,00,000/);
  assert.match(err(F.count('2.5', { label: 'Plates' })), /Plates must be a whole number/);
  assert.match(err(F.count('0', { label: 'Chairs', min: 1 })), /at least 1/);
});
t('budget: Indian formats (2 crore = 2,00,00,000), >= 0, sanity warning per guest', () => {
  assert.equal(F.budget('2 crore').value, 20000000);
  assert.equal(F.budget('2,00,00,000').value, 20000000);
  assert.equal(F.budget('₹ 5,00,000').value, 500000);
  assert.equal(F.budget('20 lakh').value, 2000000);
  assert.equal(F.budget('1.5cr').value, 15000000);
  assert.equal(F.budget('50k').value, 50000);
  assert.equal(F.budget('').value, null);
  assert.match(err(F.budget('-100')), /negative/);
  assert.match(err(F.budget('two lakh')), /amount like/);
  assert.match(err(F.budget('1e9')), /amount like/);
  assert.equal(F.fmt(20000000), '2,00,00,000');
  assert.equal(F.words(20000000), '2 crore'); assert.equal(F.words(2500000), '25 lakh');
  assert.equal(F.budgetWarning(20000000, 300), '');
  assert.match(F.budgetWarning(20000, 1000), /per guest/);          // ₹20 a guest
  assert.match(F.budgetWarning(2e10, 10), /per guest/);             // ₹200 crore a guest
  assert.match(F.budgetWarning(500, 0), /lakh or crore/);
});
t('step 1 as a whole: errors keyed by field, warnings never block', () => {
  const phone = (v) => (/^\+91[6-9]\d{9}$/.test(v) ? { ok: true } : { ok: false, error: 'Indian numbers are 10 digits.' });
  const good = { c_name: 'Ravi Kumar', c_company: '', c_email: 'ravi@example.com', c_phone: '+919876543210', c_type: 'Wedding', c_date: '2026-12-25', c_city: 'Hyderabad', c_guests: '300', d_bmax: '2 crore' };
  assert.ok(F.client(good, { today: TODAY, phone }).ok);
  const r = F.client({ ...good, c_name: ' ', c_phone: '+91123', c_date: '2026-10-01', c_type: '', c_guests: '-1' }, { today: TODAY, phone });
  assert.deepEqual(Object.keys(r.errors).sort(), ['c_date', 'c_guests', 'c_name', 'c_phone', 'c_type']);
  assert.equal(F.client({ ...good, c_phone: '' }, { today: TODAY, phone }).errors.c_phone, 'Phone is required.');
  // r19: the client e-mail is required in step 1 too (inline), and must look like an e-mail
  assert.equal(F.client({ ...good, c_email: '' }, { today: TODAY, phone }).errors.c_email, 'Email is required.');
  assert.equal(F.client({ ...good, c_email: '   ' }, { today: TODAY, phone }).errors.c_email, 'Email is required.');
  assert.match(F.client({ ...good, c_email: 'ravi@' }, { today: TODAY, phone }).errors.c_email, /name@example\.com/);
  assert.equal(F.client({ ...good, c_email: '' }, { today: TODAY, phone }).ok, false, 'no e-mail -> step 1 not saved');
  // elsewhere (send for approval: e-mail OR phone) the e-mail stays optional
  assert.deepEqual(F.email(''), { ok: true, value: '' });
  const w = F.client({ ...good, d_bmax: '20000', c_guests: '1000' }, { today: TODAY, phone });
  assert.ok(w.ok && /per guest/.test(w.warnings.d_bmax));
});
t('discovery / venue / menu / proposal / layout / quote limits', () => {
  assert.ok(F.discovery({ d_date: '', d_mode: '', d_att: '', d_notes: '' }, { today: TODAY }).ok);
  assert.match(F.discovery({ d_date: '2020-01-01' }, { today: TODAY }).errors.d_date, /between/);
  assert.match(F.discovery({ d_date: '2026-12-30' }, { today: TODAY, eventDate: '2026-12-25' }).warnings.d_date, /after the event/);
  assert.match(F.discovery({ d_notes: 'x'.repeat(4001) }, { today: TODAY }).errors.d_notes, /4000/);
  assert.match(F.venue({ v_name: '12' }).errors.v_name, /letters/);
  assert.match(F.venue({ v_addr: 'x'.repeat(301) }).errors.v_addr, /300/);
  assert.match(F.menu({ p_menu: 'x'.repeat(4001) }).errors.p_menu, /4000/);
  assert.match(F.proposal({ pr_scope: 'Catering\n catering \nLights' }).errors.pr_scope, /listed twice/);
  assert.match(F.proposal({ pr_concept: 'Royal 👑' }).errors.pr_concept, /emoji/);
  assert.deepEqual(F.scopeLines('  a \n\n b  '), ['a', 'b']);
  assert.match(F.layout({ g_len: '200', g_wid: '' }).errors.g_wid, /both/);
  assert.match(F.layout({ g_len: '10', g_wid: '50' }).errors.g_len, /at least 20/);
  assert.ok(F.layout({ g_len: '', g_wid: '' }).ok && F.layout({ g_len: '200', g_wid: '140.5' }).ok);
  assert.match(F.quote({ q_chairs: '0' }).errors.q_chairs, /at least 1/);
  assert.match(F.quote({ q_guests: '10.5' }).errors.q_guests, /whole number/);
  assert.match(F.quote({ q_other: '-1' }).errors.q_other, /negative/);
  assert.match(F.quote({}, { pkgNoPrice: 'Standard — Vegetarian' }).errors.q_platePrice, /has no price set — set it in Control Center › Menus/);
});
t('requirements: no duplicates (case / spaces / accents / & vs and), note <= 200', () => {
  const list = [{ service: 'Décor & flowers' }, { service: 'Catering' }];
  assert.match(F.requirement('  decor and   FLOWERS ', list).errors.rq_title, /already in the list/);
  assert.match(F.requirement('CATERING', list).errors.rq_title, /already in the list/);
  assert.ok(F.requirement('Photography', list, '2 photographers').ok);
  assert.equal(F.requirement('Photography', list, ' 2  photographers ').note, '2 photographers');
  assert.match(F.requirement('', list).errors.rq_title, /Type or pick/);
  assert.match(F.requirement('🎉', list).errors.rq_title, /emoji/);
  assert.match(F.requirement('Lights', list, 'x'.repeat(201)).errors.rq_note, /200/);
});
t('section content: empty sections are "Not started"', () => {
  assert.equal(F.hasContent('discovery', { d_date: '', d_mode: '', d_att: ' ', d_notes: '' }), false);
  assert.equal(F.hasContent('discovery', { d_notes: 'x' }), true);
  assert.equal(F.hasContent('client', { d_bmax: '5,00,000' }), true);   // the budget belongs to step 1
  assert.equal(A.LABEL.empty, 'Not started');
  const el = { dataset: {}, classList: { s: new Set(), toggle(c, on) { on ? this.s.add(c) : this.s.delete(c); } }, removeAttribute() {}, setAttribute() {} };
  A.paint(el, 'empty'); assert.equal(el.textContent, 'Not started'); assert.ok(el.classList.s.has('on') && el.classList.s.has('muted'));
  A.paint(el, 'saved'); assert.equal(el.textContent, 'Saved ✓'); assert.ok(!el.classList.s.has('muted'));
});
t('flow.html: budget saves with step 1, never marks Discovery; only edited sections are re-saved', () => {
  assert.match(flow, /d_bmin:"client", d_bmax:"client"/);
  const sa = flow.slice(flow.indexOf('async function saveAll(){'), flow.indexOf('const confirmLeaveAnyway'));
  assert.match(sa, /if\(!edited\.has\(s\)\) return;/);
  assert.match(flow, /function paintBadge\(s,state,msg\)\{\s*if\(state==="saved"\)\{ edited\.delete\(s\); if\(!contentOf\(s\)\) state="empty";/);
  assert.match(flow, /function saved\(which\)\{ paintBadge\(which,"saved"\); \}/);
  assert.match(flow, /badge:\(s,state,msg\)=>paintBadge\(s,state,typeof msg==="string"\?msg:""\)/);
  // each section writes only its own fields (plan row shared by venue + menu notes; discovery row holds the budget)
  assert.match(flow, /function gatherPlan\(which\)\{ const P=planRow\|\|\{\}, ven=which==null\|\|which==="venue", men=which==null\|\|which==="menu";/);
  const sd = flow.slice(flow.indexOf('async function saveDiscovery'), flow.indexOf('async function saveVenue'));
  assert.match(sd, /discFields\(discRow\)/); assert.doesNotMatch(sd, /#d_bmax/);
  assert.match(flow, /location:d\.location\|\|null/);   // the Discovery page's location is no longer wiped by a flow save
});
t('flow.html: step 1 validated on autosave + explicit save; ticks / next-step from saved data', () => {
  const sc = flow.slice(flow.indexOf('async function saveClient(quiet){'), flow.indexOf('// guest-budget: ONE budget range'));
  // qa-quote-flow B20: still refused on autosave, but a hall-size / chairs problem is reported on ITS step (7 / 8)
  assert.match(sc, /const errs=step1Problems\(!quiet\);[\s\S]{0,260}if\(quiet\) return sec==="client" \? \{ invalid:e0\.msg \} : \{ invalid:e0\.msg, section:sec \};/);
  assert.match(flow, /FV\.client\(vals\(IDS\.client\),\{ today:studioToday\(\), originalDate:origDate, rejectedDate:/);
  assert.match(flow, /client:!!\(pc\.name && pc\.phone && pc\.eventType && pc\.eventDate\) && !bad\("client"\)/);
  assert.match(flow, /if\(h\) h\.hidden=!done\[k\];/);
  assert.match(flow, /id="c_type" required/); assert.match(flow, /id="c_date" type="date" data-min-today required/);
  assert.match(flow, /<input id="d_bmax" type="text" inputmode="decimal"/);
});
t('flow.html: event date picker min = studio today, set before the date hardener runs', () => {
  assert.match(flow, /function setDateWindow\(\)\{[^\n]*d\.setAttribute\("min",t\); d\.setAttribute\("max",FV\.addYears\(t,5\)\); \}\n  setDateWindow\(\);/);
  assert.match(flow, /const studioToday=\(\)=>FV\.todayIn\(FV\.tzFor\(studioCC\(\)\)\);/);
});
t('flow.html: requirement duplicates blocked inline, note saved', () => {
  assert.match(flow, /const addReq=\(\)=>\{ const r=FV\.requirement\(\$\("#rq_title"\)\.value, reqRows, \$\("#rq_note"\)\.value\);/);
  assert.match(flow, /addReq\(id,\{ service:r\.value, priority:\$\("#rq_pri"\)\.value, note:r\.note\|\|null \}\)/);
  assert.match(flow, /id="rq_note"/);
});
t('flow.html: venue save refreshes the lock base and never swallows the client write', () => {
  const sv = flow.slice(flow.indexOf('async function saveVenue(quiet){'), flow.indexOf('async function saveMenuNotes'));
  assert.match(sv, /const row=await BPStore\.quotes\.updateMeta\(id,\{ client \}\);\s*ev\.client=client; if\(row&&row\.updated_at\) ev\.updatedAt=row\.updated_at;/);
  assert.doesNotMatch(sv, /catch\{\}/);
});
t('flow.html: quotation save - bound engine, inline checks, never silent', () => {
  assert.match(flow, /HelmQuoteTotal\.withTotal\(pricing, BPStore\.pricing\.quoteTotal\.bind\(BPStore\.pricing\)\)/);
  assert.match(flow, /const r=check\("quote",true\), pe=firstErr\(r,"quote"\);/);
  assert.match(flow, /\.catch\(\(e\)=>\{\s*if\(e && \(e\.code==="INVALID" \|\| e\.__shown\)\) return;/);
});
t('flow.html: package with no price is a visible warning, never a fallback rate', () => {
  assert.match(flow, /const platePrice = pkgNoPrice\(\) \? 0 :/);
  assert.match(flow, /has no price set — set it in Control Center › Menus\. Catering is not priced until then\./);
  assert.match(flow, /chairsManual\?"\(set by hand\)":\(\$\("#c_guests"\)\.value!==""\?"\(70% of guests\)":""\)/);
});
t('live price rail sticks below the app header; phones get a bottom summary bar', () => {
  assert.match(css, /\.rail\{position:sticky;top:calc\(var\(--hb-top,0px\) \+ 16px\)/);
  assert.match(css, /@media \(max-width:900px\)\{\s*\.mbar\{display:flex;position:fixed/);
  assert.match(css, /html\[data-shell="b"\] \.mbar\{bottom:calc\(58px \+ env\(safe-area-inset-bottom,0px\)\)/);
  assert.match(flow, /<div class="mbar" id="mPriceBar" role="region" aria-label="Live price summary" hidden>/);
});
t('resume v3: one browser entry PER QUOTE (fallback), unfinished quotes only, deep link to the last section', () => {
  const store = {}; globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  const now = Date.now(), q9 = '00000000-0000-4000-8000-000000000009', q8 = '00000000-0000-4000-8000-000000000008';
  assert.equal(R.read('u1', q9), null);
  R.record('u1', { quoteId: q9, name: 'WED_HYD_300', step: 'venue' }, now);
  R.record('u1', { quoteId: q8, name: 'BDAY_PUNE_50', step: 'menu' }, now + 1000);
  assert.equal(R.lastStep('u1', q9), 'venue', 'opening another quote never replaces this one'); assert.equal(R.lastStep('u1', q8), 'menu');
  assert.equal(R.lastStep('u2', q9), null); assert.equal(R.lastStep('u1', 'qX'), null);
  const v = R.fromLocal(R.read('u1', q9));
  assert.equal(R.label(v, now + 2 * 3600e3), 'WED_HYD_300 · step 4 of 8 · Venue · edited 2 h ago');
  assert.equal(R.href(v), 'flow.html?quote=' + q9 + '#sec-venue');
  assert.equal(R.record('u1', { quoteId: q9, step: 'bogus' }), null);
  assert.equal(R.read('u1', q9, now + 61 * 864e5), null, 'older than 60 days is ignored');
  assert.equal(R.unfinished({ status: 'quote' }), true);
  for (const q of [{ status: 'confirmed' }, { status: 'cancelled' }, { lifecycleStage: 'closed' }, { status: 'quote', archivedAt: 'x' }, { status: 'quote', deletedAt: 'x' },
    { status: 'quote', approvalStatus: 'sent' }, { status: 'quote', approvalToken: 'x' }, null]) assert.equal(R.unfinished(q), false);
  assert.equal(R.clear('u1'), false, 'clear needs a quote id: nothing is wiped because another quote was opened');
  R.clear('u1', q9); assert.equal(R.read('u1', q9), null); assert.equal(R.lastStep('u1', q8), 'menu', 'the other quote is untouched');
  assert.match(read('public/quotes.html'), /<script src="flow-resume\.js\?v=5" data-mount><\/script>/);
  assert.match(read('public/dashboard.html'), /<script src="flow-resume\.js\?v=5" data-mount><\/script>/);
  assert.match(flow, /flowTrack=HelmFlowResume\.track\(\{ quoteId:id, uid:userId, canEdit, store:BPStore,/);
  assert.match(flow, /resumeP=HelmFlowResume\.resumeStep\(BPStore, userId, id\)/);
  assert.match(flow, /resumeP\.then\(info=>\{ if\(!moved && info && info\.step\) jump\("sec-"\+info\.step, info\); landOnce\(info\); \}\)/, 'the resume answer never holds the page back');
  assert.doesNotMatch(flow, /await resumeP/);
});
t('unsaved typing survives leaving (same tab), never over a newer server copy', () => {
  assert.match(flow, /sessionStorage\.setItem\(DRAFT_KEY, JSON\.stringify\(\{ at:Date\.now\(\), v:o \}\)\)/);
  assert.match(flow, /if\(isFinite\(srv\) && \+d\.at && srv>\+d\.at\+1000\)\{ draftClear\(\); return; \}/);
  assert.match(flow, /dirty=false; draftClear\(\); \$\("#leaveModal"\)\.hidden=true;/);
});
t('new quotes elsewhere: lead Convert + quote modal refuse a past event date (studio day)', () => {
  const L = read('public/leads.html'), Q = read('public/quotes.html');
  assert.match(L, /Event date can't be in the past — this lead's date \("\+dd\+"\) has passed/);
  assert.match(L, /timeZone:\(\(\(window\.BPStore&&BPStore\.studioTax&&BPStore\.studioTax\(\)\)\|\|\{\}\)\.country==="AE"\?"Asia\/Dubai":"Asia\/Kolkata"\)/);
  assert.match(Q, /if\(\(dv && dv<today && dv!==sv\) \|\| \(!dv && de\.getAttribute\("data-date-rejected"\)==="past"\)\)\{ errEl\.textContent="Event date can't be in the past\.";/);
});
t('pins', () => {
  assert.match(flow, /flow-validate\.js\?v=4/); assert.match(flow, /flow-resume\.js\?v=5/);
  assert.match(flow, /flow-autosave\.js\?v=5/); assert.match(flow, /flow-polish\.css\?v=8/);
});
console.log(`flow-validation: ${n} passed`);
