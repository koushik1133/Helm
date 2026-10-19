// e2e-usability.test.mjs - live E2E pass (quote -> design -> approval -> payment -> booklet ->
// invitation -> portal -> settlement -> closure), items E1-E14 + migration 0101.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);

const HEN = require('../public/event-name.js');
const HC = require('../public/country-profile.js');
const store = read('public/store-api.js');
const flow = read('public/flow.html'), approve = read('public/approve.html'), portal = read('public/portal.html');
const invite = read('public/invite.html'), studio = read('public/invite-studio.html'), settle = read('public/settlement.html');
const closure = read('public/closure.html'), insights = read('public/insights.html'), bookletJs = read('public/booklet.js');
const sql = read('supabase/migrations/0101_e2e_usability.sql'), apply = read('supabase/APPLY-0101.sql');

function pick(name) { const s = store.indexOf('BPStore.' + name + ' = function'); const e = store.indexOf('\n  };\n', s); return store.slice(s, e + 5); }
const ctx = { BPStore: {} }; ctx.globalThis = ctx; vm.createContext(ctx);
vm.runInContext(pick('quoteTaxAmount'), ctx);
const B = ctx.BPStore;

const bctx = { console, URLSearchParams, HelmEventName: HEN }; bctx.window = bctx; bctx.globalThis = bctx;
vm.createContext(bctx); vm.runInContext(bookletJs, bctx);
const BK = bctx.HelmBooklet;

// ---- E1 client state -> IGST / CGST+SGST
t('E1 client state select on the client step, saved on the client JSON', () => {
  assert.match(flow, /<select id="c_state"/);
  assert.match(flow, /state:\$\("#c_state"\)\.value\|\|null,\s*eventDate/);           // saveClient
  assert.match(flow, /state:\$\("#c_state"\)\.value\|\|null, eventDate/);             // syncClientMem
  assert.match(flow, /fillClientStates\(cl\)/);
});
t('E1 regions come from HelmCountry (India states / AE emirates / US states)', () => {
  assert.match(flow, /HC\.formMeta\(cc\)/);
  assert.ok(HC.formMeta('IN').regions.some((r) => r.name === 'Telangana'));
  assert.equal(HC.formMeta('AE').regionLabel, 'Emirate');
  assert.ok(HC.formMeta('US').regions.some((r) => r.code === 'CA'));
});
t('E1 known states decide place of supply before a stale saved value; hint in the live price', () => {
  assert.match(flow, /const auto=BPStore\.tax\.placeOfSupply\(flowStudioState, ev&&ev\.client&&ev\.client\.state\);\s*if\(auto\) return auto;/);
  assert.match(flow, /IGST \(inter-state\)/); assert.match(flow, /CGST\+SGST \(intra-state\)/);
  assert.equal(HC.placeOfSupply('Telangana', 'Karnataka'), 'inter');
  assert.equal(HC.placeOfSupply('Telangana', 'telangana'), 'intra');
});
t('E1 state prefilled from the city / venue / address', () => {
  assert.match(flow, /hyderabad:"Telangana"/); assert.match(flow, /function guessClientState\(cl\)/);
});

// ---- E2 reprice false positive + stray Switch
t('E2 reprice compares the rates-at-pricing snapshot with live rates (not the hand-typed quote price)', () => {
  assert.match(flow, /const moved=\(k,live\)=>!snap \|\| !\(k in snap\) \|\| nOrNull\(snap\[k\]\)!==live;/);
  assert.match(flow, /oc!==nc && moved\("chairPrice",nc\)/);
  assert.match(flow, /op!==np && pkgMoved/);
  assert.match(flow, /og!==ng && moved\("gstPct",ng\)/);
  assert.match(flow, /os!==ns && moved\("serviceChargePct",ns\)/);
  assert.match(flow, /_ratesAt:ratesSnapshot\(\)/);
});
t('E2 the Switch button is never shown or announced on its own', () => {
  assert.match(flow, /<button type="button" class="btn" id="q_curSwitch" hidden><\/button>/);
  assert.doesNotMatch(flow, /id="q_curBanner" role="status"/);
  assert.match(flow, /\$\("#q_curSwitch"\)\.hidden=!quoteKeep;/);
});

// ---- E3 / E4 labels + friendly title
t('E3 one shared event-type label map', () => {
  assert.equal(HEN.label('wedding'), 'Wedding'); assert.equal(HEN.label('reception'), 'Reception');
  assert.equal(HEN.label('sangeet'), 'Sangeet'); assert.equal(HEN.label('corporate'), 'Corporate event');
  assert.equal(HEN.label('political'), 'Political rally'); assert.equal(HEN.label('birthday'), 'Birthday');
  assert.equal(HEN.label('baby shower'), 'Baby shower'); assert.equal(HEN.label(''), '');
});
t('E4 friendly title: names, else "<Type> for <client> · date"; manual renames kept', () => {
  assert.equal(HEN.friendlyTitle({ title: 'WED_HYD_300_28DEC26', event_type: 'wedding', client_name: 'Asha Rao', event_date: '2026-12-28' }), 'Wedding for Asha Rao · 28 Dec 2026');
  assert.equal(HEN.friendlyTitle({ title: 'WED_HYD_300_28DEC26', event_type: 'wedding', client: { names: 'Asha & Ravi' } }), "Asha & Ravi's Wedding");
  assert.equal(HEN.friendlyTitle({ title: '10102026-01', code: '10102026-01', event_type: 'corporate' }), 'Corporate event');
  assert.equal(HEN.friendlyTitle({ title: 'Our Big Day', event_type: 'wedding' }), 'Our Big Day');
});
t('E3/E4 approve, booklet, portal, invitation and the quote PDF use the shared map', () => {
  assert.match(approve, /HEN\.friendlyTitle\(/); assert.match(approve, /HEN\.label\(quote\.event_type\)/); assert.match(approve, /"Ref "\+quote\.code/);
  assert.match(portal, /HEN\.friendlyTitle\(Object\.assign\(\{client_name:d\.client_name\},e\)\)/);   // live E2E: type is in the title, the second line is the date
  assert.match(bookletJs, /fact\(dl, "Occasion", typeLabel\(e\.event_type\)\)/); assert.match(bookletJs, /const title = clientTitle\(e\);/);
  assert.match(invite, /HEN\.isAuto\(String\(site\.title\)\)/);
  assert.match(flow, /HelmEventName\.friendlyTitle\(Object\.assign\(\{\}, ev/);
});

// ---- E6 booklet balance line
t('E6 booklet: balance due by dd/mm/yyyy from terms + event date; paid in full', () => {
  BK.setFormat('en-IN', 'INR');
  assert.equal(BK.balanceLine(592360, 177708, 414652, '2026-12-28', { balance_due_days: 7 }), 'Balance ₹4,14,652 due by 21/12/2026');
  assert.equal(BK.balanceLine(592360, 592360, 0, '2026-12-28', { balance_due_days: 7 }), 'Paid in full');
  assert.equal(BK.balanceLine(592360, 0, 592360, '2026-12-28', null), 'Balance ₹5,92,360 due before the event (28/12/2026)');
  assert.equal(BK.balanceLine(null, 0, null, '2026-12-28', null), null);
  assert.match(bookletJs, /line \|\| "The payment schedule will be shared by the studio\."/);
  assert.match(store, /payTerms: \(token\) => \(supa \? rpc\("public_booklet_pay_terms"/);
});

// ---- E7 invite prefill
t('E7 a new invitation is prefilled from the quote (date, time, venue, address, host, names)', () => {
  assert.match(studio, /function prefillFromQuote\(\)/);
  for (const f of ['f_date', 'f_time', 'f_venue', 'f_address', 'f_host', 'f_hostPhone', 'f_names']) assert.match(studio, new RegExp('set\\("' + f + '"'));
  assert.match(studio, /else \{ (?:await prefillFromPlan\(\); )?prefillFromQuote\(\); applyTypeLabels\(\);/);
});

// ---- E8 dates in the studio's country style
t('E8 IN/AE "Monday, 28 December 2026 · 7:00 PM", US "Monday, December 28, 2026 · 7:00 PM"', () => {
  assert.equal(HC.formatEventDate('IN', '2026-12-28', '19:00'), 'Monday, 28 December 2026 · 7:00 PM');
  assert.equal(HC.formatEventDate('AE', '2026-12-28', '09:05'), 'Monday, 28 December 2026 · 9:05 AM');
  assert.equal(HC.formatEventDate('US', '2026-12-28', '19:00'), 'Monday, December 28, 2026 · 7:00 PM');
  assert.equal(HC.formatEventDate('IN', 'not a date', '19:00'), '');
  assert.match(portal, /HC\.formatEventDate\(cc,String\(d\),t\)/);
  assert.match(invite, /HC\.formatDate\(CC,String\(d\)\)/); assert.doesNotMatch(invite, /toLocaleDateString\(undefined/);
  assert.match(studio, /country:studioCC\(\)/);
});

// ---- E9 map link
t('E9 editor: only https:// map links, inline error; the old check read the wrong object', () => {
  assert.match(studio, /id="f_mapUrlErr" role="alert" hidden/);
  assert.match(studio, /g\.data&&g\.data\.mapUrl && !\(MAP_RE\.test\(g\.data\.mapUrl\)/);
  assert.doesNotMatch(studio, /if\(g\.mapUrl &&/);
  const MAP_RE = /^https:\/\/[^\s"'<>\\]+$/i;
  assert.ok(!MAP_RE.test('javascript:alert(1)')); assert.ok(!MAP_RE.test('http://maps.google.com')); assert.ok(MAP_RE.test('https://maps.app.goo.gl/abc'));
});
t('E9 public page: https only, else "Open in Maps" from venue + address', () => {
  assert.match(invite, /https:\/\/www\.google\.com\/maps\/search\/\?api=1&query="\+encodeURIComponent\(q\)/);
  assert.match(invite, /Open in Maps/);
});

// ---- E10 RSVP
t('E10 RSVP on WhatsApp + Call when a host phone exists; no "reply by" promise without one', () => {
  assert.match(invite, /RSVP on WhatsApp/); assert.match(invite, /https:\/\/wa\.me\/\$\{esc\(wa\)\}\?text=/);
  assert.match(invite, /BPStore\.waNumber/); assert.match(invite, /I'll attend /);
  assert.match(invite, /if\(digits\.replace\(\/\\D\/g,""\)\.length<7\) return "";/);
  assert.doesNotMatch(invite, /\$\{d\.rsvpBy\?`<p class="note rv">Kindly reply by/);
});

// ---- E11 portal
t('E11 portal cards: documents, receipts, contact - only what exists, DOM text only', () => {
  for (const id of ['docsCard', 'receiptsCard', 'contactCard']) assert.match(portal, new RegExp('id="' + id + '" hidden'));
  assert.match(portal, /BPStore\.portal\.extras\(token\)/);
  assert.match(portal, /"Event booklet"/); assert.match(portal, /"Invitation website"/); assert.match(portal, /"Quotation & terms"/); assert.match(portal, /"Floor plan pictures"/);
  assert.match(store, /extras: \(token\) => \(mode === "supabase" \? rpc\("public_portal_extras"/);
  const ex = portal.slice(portal.indexOf('async function extras'), portal.indexOf('BPUI.boot(load)'));
  assert.doesNotMatch(ex, /innerHTML/);
});

// ---- E12 record payment
t('E12 more than the balance due is explained (server refuses it, no "record anyway"); zero / negative blocked; one confirm at a time', () => {
  assert.match(settle, /more than the balance due/); assert.match(settle, /if\(over>0\.5\)\{ try\{ await BPUI\.alert\(/); assert.doesNotMatch(settle, /okLabel:over>0\.5\?"Record anyway"/);
  assert.match(settle, /if\(!av\.ok \|\| av\.value<=0\)/);
  assert.match(settle, /if\(paying\) return; paying=true;/);
});

// ---- E13 ex-tax revenue
t('E13 tax inside a total: 5,92,360 at 18% holds 90,360 GST; exempt 0; computed only for the same total', () => {
  assert.equal(B.quoteTaxAmount({ gstPct: 18 }, 592360), 90360);
  assert.equal(B.quoteTaxAmount({ gstPct: 18, taxExempt: true }, 592360), 0);
  assert.equal(B.quoteTaxAmount({ gstPct: 18, computed: { total: 118, totalGst: 18 } }, 118), 18);
  assert.equal(B.quoteTaxAmount({ gstPct: 18, computed: { total: 999, totalGst: 500 } }, 118), 18);
  assert.equal(B.quoteTaxAmount({ gstPct: 0 }, 1000), 0);
});
t('E13 closure P&L / budget / insights on ex-tax revenue; tax shown as payable', () => {
  assert.match(store, /const revenueExTax = Math\.round\(\(revenue - tax\) \* 100\) \/ 100;/);
  assert.match(store, /const estMargin = revenueExTax - estCost/);
  assert.match(store, /const rev = s\.revenueExTax != null \? s\.revenueExTax : s\.revenue/);
  assert.match(store, /balance = Math.round\(\(revenue - gross\) \* 100\) \/ 100;   \/\/ the client's balance includes tax/);
  assert.match(closure, /Revenue \(ex-\$\{esc\(taxLabel\(\)\)\}\)/); assert.match(closure, /collected \(payable\)/);
  assert.doesNotMatch(closure, /Revenue \(client\)/);
  assert.match(insights, /o\.revenue_ex_tax!=null\?Number\(o\.revenue_ex_tax\)/); assert.match(insights, /"Revenue \(ex-tax\)"/);
});

// ---- E14 future close
// 0198: no longer "close anyway?" - an event closes only after its event day (the server refuses too)
t('E14 / 0198 closing before the event day is over is refused; double-click opens one close flow', () => {
  assert.doesNotMatch(closure, /Close it anyway\?/);
  assert.match(closure, /d>=BPStore\.todayLocal\(\)/);
  assert.match(closure, /"You can close this event after "/);
  assert.match(closure, /if\(closing\) return; closing=true;/);
});

// ---- 0101 migration
t('0101: functions only, definer + empty search_path, token-scoped, additive insights fields', () => {
  assert.doesNotMatch(sql, /\b(create|alter|drop) table\b/i); assert.doesNotMatch(sql, /\bdelete from\b|\bupdate public\./i);
  for (const f of ['public_booklet_pay_terms', 'public_portal_extras', 'insights_range', '_r101_studio_contact'])
    assert.match(sql, new RegExp('function public\\.' + f + '\\([^)]*\\)\\s*returns jsonb language (plpgsql|sql) (volatile |stable )security definer set search_path = \'\''));
  assert.match(sql, /'revenue_ex_tax', rev - v_tax/); assert.match(sql, /insights_range__pre0101/);
  assert.match(sql, /x\.approval_token = p_token and x\.deleted_at is null/);
  assert.match(sql, /b\.quote_id = q\.id and b\.org_id = q\.org_id/); assert.match(sql, /s\.quote_id = q\.id and s\.org_id = q\.org_id/);
  assert.match(sql, /pm\.quote_id = q\.id and pm\.org_id = q\.org_id and pm\.status = 'paid'/);
  assert.doesNotMatch(sql.slice(sql.indexOf('function public.public_portal_extras')), /billing/);
});
t('APPLY-0101.sql: ASCII, one transaction, verify rows', () => {
  assert.ok(!/[^\x00-\x7F]/.test(apply)); assert.match(apply, /^begin;$/m); assert.match(apply, /^commit;$/m);
  assert.match(apply, /select item, ok from \(values/); assert.ok((apply.match(/\('0101 \d\d /g) || []).length >= 9);
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0101_e2e_usability\.sql/);
});
t('versions bumped', () => {
  for (const f of [flow, approve, portal, invite, studio, settle, closure]) { assert.match(f, /store-api\.js\?v=263/); assert.match(f, /event-name\.js\?v=9/); assert.match(f, /country-profile\.js\?v=4/); }
  assert.match(read('public/booklet.html'), /booklet\.js\?v=25/); assert.match(flow, /booklet\.js\?v=25/);
});

let pass = 0;
for (const [n, f] of tests) { try { f(); pass++; console.log('  ✓ ' + n); } catch (e) { console.error('  ✗ ' + n + '\n    ' + e.message); process.exitCode = 1; } }
console.log(`e2e-usability: ${pass}/${tests.length} passed`);
