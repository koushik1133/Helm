// r20 coord (live QA as the Event coordinator on /sita): no event_pnl call without finance view, "View layout"
// for layouts view-only + builder view-only banner / inputs, Completed tile "done this week", phone "+ New" button,
// event-page stage strip gutters + studio-style date/time, calendar chips wrap, one event name on dashboard tasks +
// calendar, profile panel heading once, billable-change link needs finance, plan approval status/note one source,
// leads hint + follow-ups for view-only, logistics wording without finance, client tab counts = header counts,
// /<studio>/discovery + /<studio>/proposal routes, media page title.
// Static source checks + pure helpers run in a vm. No network, no DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

process.env.TZ = 'America/Chicago';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const EV = read('public/event.html'), Q = read('public/quotes.html'), B = read('public/builder.js'), ST = read('public/studio-templates.js');
const DASH = read('public/shell-b-dash.js'), SHB = read('public/shell-b.js'), SHP = read('public/shell-b-pages.css');
const POL = read('public/event-polish.css'), CALC = read('public/events-calendar.css'), CAL = read('public/calendar.html');
const AUI = read('public/auth-ui.js'), ISS = read('public/issues.html'), PLAN = read('public/plan.html'), LEADS = read('public/leads.html');
const LOG = read('public/logistics.html'), CLI = read('public/client.js'), API = read('public/store-api.js');
const fnSrc = (src, name) => { const s = src.indexOf('function ' + name + '('); assert.ok(s >= 0, name); let i = src.indexOf('{', s), d = 0;
  for (; i < src.length; i++) { if (src[i] === '{') d++; else if (src[i] === '}' && --d === 0) break; } return src.slice(s, i + 1); };

t('1 event page: closure.pl (server event_pnl) only with finance view; Closure card stays hidden without it', () => {
  assert.match(EV, /if\(!canFin\)\{ const c=await BPStore\.closure\.get\(id\); closureSummary=\{ profit:null[^}]*noFin:true \}; return; \}/);
  assert.match(EV, /closureSummary && !closureSummary\.noFin && billsDelta/);
  assert.match(EV, /\.\.\.\(canFin\?\[\]:\["budget","settle","closure"\]\)/);
});

t('2 quotes list: "View layout" for layouts view-only; builder view-only banner + Save & back / Save as template off', () => {
  assert.match(Q, /canEditLayouts = BPStore\.auth\.enabled\(\) \? await BPStore\.auth\.canEditArea\("layouts"\)/);
  assert.match(Q, /\$\{canEditLayouts\?"Edit":"View"\} layout<\/button>/);
  assert.doesNotMatch(Q, />Edit layout<\/button>/);
  assert.match(B, /'backToFlowBtn','st_saveBtn'\]\.forEach/);
  assert.match(ST, /if \(B\.ro\(\)\) \{ toast\("View only - your role can view layouts but not change them\.", true\); return; \}/);
});

t('11 builder view-only: right wording, name / capacity / guests inputs disabled', () => {
  assert.match(B, /'👁 View only — your role can view layouts but not change them\.'/);
  assert.doesNotMatch(B, /but not edit them/);
  assert.match(B, /'projName','capInput','bGuests'/);
  assert.match(B, /<input id="bGuests" type="number" min="0" value="[^`]*" \$\{RO\?'disabled':''\}>/);
});

t('3 Completed tile: "N done this week" (studio calendar, Monday start), not "N upcoming events"', () => {
  assert.match(DASH, /sub: tasks \? doneThisWeek\(tasks\.completed, today\) \+ " done this week"/);
  assert.doesNotMatch(DASH, /label: "Completed"[^\n]*upcoming events/);
  const S = () => ({ studioClock: (v) => ({ date: new Date(v).toISOString().slice(0, 10) }) });
  const f = vm.runInNewContext('(' + fnSrc(DASH, 'doneThisWeek').replace(/^function doneThisWeek/, 'function') + ')', { S });
  const list = [{ completed_at: '2026-10-19T10:00:00Z' }, { completed_at: '2026-10-21T10:00:00Z' }, { completed_at: '2026-10-18T10:00:00Z' }, { completed_at: null }, {}];
  assert.equal(f(list, '2026-10-21'), 2);   // Wed: Mon 19 + Wed 21; Sun 18 is last week
  assert.equal(f(list, '2026-10-18'), 1);   // Sun 18 closes the week that began Mon 12
  assert.equal(f(null, '2026-10-21'), 0); assert.equal(f(list, ''), 0);
});

t('4 phone top bar: the create-menu button alone is a 44px icon button with an aria-label', () => {
  assert.match(SHP, /\.hb-split \.hb-chev\.hb-solo \{ width: 44px; min-width: 44px; height: 44px;/);
  assert.match(SHB, /chev\.setAttribute\("aria-label", "New - open the create menu"\)/);
});

t('5 event page: stage strip keeps arrow gutters + snap on phones; read-only date row in studio style', () => {
  assert.match(EV, /w\.classList\.toggle\("ov",max>1\)/);
  assert.match(POL, /@media \(max-width:899px\)\{\n  \.stepwrap\.ov\{padding:0 34px\}/);
  assert.match(POL, /\.stepwrap\.ov \.steps\{scroll-snap-type:x proximity/);
  assert.match(EV, /"📅 "\+esc\(evDateLabel\(d\)\)\+\(tm\?\(" · 🕒 "\+esc\(evTimeLabel\(tm\)\)\):""\)/);
  const tl = vm.runInNewContext('(' + fnSrc(EV, 'evTimeLabel').replace(/^function evTimeLabel/, 'function') + ')');
  assert.equal(tl('19:00'), '7:00 pm'); assert.equal(tl('19:00:00'), '7:00 pm'); assert.equal(tl('00:30'), '12:30 am'); assert.equal(tl('12:05'), '12:05 pm');
  const BPStore = { todayLocal: () => '2026-10-18', fmtStudioDate: (s, o) => 'X:' + s + ':' + o.style + ':' + !!o.year };
  const dl = vm.runInNewContext('(' + fnSrc(EV, 'evDateLabel').replace(/^function evDateLabel/, 'function') + ')', { BPStore });
  assert.equal(dl('2026-10-29'), 'X:2026-10-29:medium:false'); assert.equal(dl('2027-01-02'), 'X:2027-01-02:medium:true');
});

t('28 event page time box: HH:MM (no seconds); child events list uses the studio time label', () => {
  assert.match(EV, /id="evTime" aria-label="Event time" value="\$\{esc\(evTimeInput\(tm\)\)\}"/);
  const ti = vm.runInNewContext('(' + fnSrc(EV, 'evTimeInput').replace(/^function evTimeInput/, 'function') + ')');
  assert.equal(ti('19:00:00'), '19:00'); assert.equal(ti('9:05'), '09:05'); assert.equal(ti(''), ''); assert.equal(ti(null), '');
  assert.match(EV, /\(e\.eventTime\?" \("\+evTimeLabel\(e\.eventTime\)\+"\)":/);
});

t('6 calendar: status chips wrap on a phone (no hidden-scrollbar row)', () => {
  assert.match(CALC, /\.evc-legend\{flex-wrap:wrap;width:100%;padding-bottom:2px\}/);
  assert.doesNotMatch(CALC, /\.evc-legend\{flex-wrap:nowrap/);
});

t('7 one event name: dashboard task rows + calendar shortage rows / date dialog use the shared name', () => {
  assert.match(DASH, /function evTitleOf\(t\) \{ return \(t && t\.quote_id && nameById\[t\.quote_id\]\) \|\| \(t && t\.event_title\) \|\| ""; \}/);
  assert.equal((DASH.match(/evTitleOf\((t|nextT)\)/g) || []).length, 4);   // the helper + 3 uses
  assert.doesNotMatch(DASH, /\[t\.event_title, t\.planned_end/);
  assert.match(CAL, /" · "\+esc\(evName\(x\.event\)\)/);
  assert.match(CAL, /const nm=evName\(ev\), label=/);
  // the list / page reads carry the fields HelmEventName.fromQuote needs (city / venue / guests)
  assert.match(API, /const QUOTE_PAGE_COLS = [^;]*client_city:client->>city[^;]*client_guests:client->>guests/);
});

t('8 profile panel: one "Your profile" heading when opened on the profile alone', () => {
  assert.match(AUI, /profileSection\(st, focusProfile, section === "profile"\)/);
  assert.match(AUI, /if \(!soloHead\) sec\.appendChild\(el\("h3", \{ id: "hauProfileTitle" \}, "Your profile"\)\)/);
  assert.match(AUI, /labelledBy: soloHead \? "hauTitle" : "hauProfileTitle"/);
});

t('10 issues: "Raise a billable change" (Budget = finance) hidden without finance view', () => {
  assert.match(ISS, /const fin=await BPStore\.auth\.canView\("finance"\)\.catch\(\(\)=>false\), cl=\$\("#changeLink"\); if\(cl && !fin\) cl\.hidden=true;/);
});

t('13 plan: status line and approval note read one truth; no payment note without finance', () => {
  const f = fnSrc(PLAN, 'renderApproval');
  assert.match(f, /paid:"Approved · advance paid"/);
  assert.match(f, /if\(!fin\)\{ hist\.hidden=true; hist\.innerHTML=""; return; \}/);
  assert.match(f, /setOnQuote \? `<div class="muted">\$\{st==="paid"\?"Marked approved and paid on the quote"/);
  assert.ok(f.indexOf('canView("finance")') < f.indexOf('approval.consents'), 'finance check before the ledger reads');
});

t('14 leads view-only: hint "Open a card to view it."; dashboard follow-ups no Reply', () => {
  assert.match(LEADS, /<div class="hintbar" id="boardHint">/);
  assert.match(LEADS, /if\(hb && !canEdit\) hb\.textContent="Open a card to view it\."/);
  assert.match(DASH, /href: leadHref\(l\), act: eLeads \? "Reply" : null \}/);
  assert.match(DASH, /leadHref\(l\), eLeads \? "Reply" : "View", null, "Not contacted"/);
  assert.match(DASH, /if \(it\.act\) li\.appendChild\(link\(it\.href, "hd-btn hd-ghost hd-sm", it\.act\)\)/);
});

t('15 logistics wording without finance: workspace card + page title', () => {
  assert.match(EV, /\(canFin\?"Guests, permits, comms &amp; the payment schedule\.":"Guests, permits &amp; comms\."\)/);
  assert.match(EV, /logistics:canFin\?"Logistics — guests, permits and the payment schedule":"Logistics — guests, permits and comms"/);
  assert.match(LOG, /h\.textContent="Logistics"; document\.title="Logistics — Helm Events";/);
});

t('16 client page: Leads / Events tabs count records, same as the header', () => {
  assert.match(CLI, /const rec = \(d\.key === "leads" \|\| d\.key === "events"\) && typeof m\.counts\[d\.key\] === "number" \? m\.counts\[d\.key\] : null;/);
});

t('29 /<studio>/discovery + /<studio>/proposal: rewrites, private headers, server.js, HelmUrl', async () => {
  const v = JSON.parse(read('vercel.json')), rx = (s) => new RegExp('^' + s + '$');
  const hit = (p) => v.rewrites.filter((r) => r.source !== '/i/:slug*' && rx(r.source).test(p)).map((r) => r.destination);
  assert.deepEqual(hit('/sita/discovery'), ['/discovery']); assert.deepEqual(hit('/sita/proposal'), ['/proposal']);
  assert.deepEqual(hit('/sita/proposal/tok-1'), ['/proposal-view']);   // the client proposal link is unchanged
  const vh = (p) => { const o = {}; for (const r of v.headers) { if (r.has) continue; if (rx(r.source).test(p)) for (const h of r.headers) o[h.key.toLowerCase()] = h.value; } return o; };
  for (const p of ['/sita/discovery', '/sita/proposal']) { const h = vh(p); assert.match(h['x-robots-tag'] || '', /noindex/, p); assert.match(h['cache-control'] || '', /no-store/, p); }
  assert.equal(vh('/sita/proposal')['content-security-policy'], vh('/proposal')['content-security-policy']);
  assert.equal(vh('/sita/discovery')['content-security-policy'], vh('/discovery')['content-security-policy']);
  const { createRequire } = await import('node:module'); const require = createRequire(import.meta.url);
  const server = require('../server.js');
  if (server && server.prettyPage) { assert.equal(server.prettyPage('/sita/discovery'), 'discovery'); assert.equal(server.prettyPage('/sita/proposal'), 'proposal'); }
  assert.match(API, /\|settlement\|discovery\|proposal\|budget\|closure\|runsheet\|resources\|logistics\|teardown\|command\|ready\|flow"\.split/);
  assert.match(API, /\|control\|settlement\|discovery\|proposal\|budget\|/);
});

t('30 media page title', () => {
  assert.match(read('public/media.html'), /<title>Media &amp; gallery — Helm Events<\/title>/);
});

t('33 sign-out ends THIS browser only: no bare supabase signOut() anywhere in public/, no "global" scope', async () => {
  const { readdirSync, statSync } = await import('node:fs'); const { join } = await import('node:path');
  const root = new URL('../public/', import.meta.url).pathname, files = [];
  (function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (!/vendor|node_modules/.test(f)) walk(p); } else if (/\.(js|html)$/.test(f) && !/\.min\.js$/.test(f)) files.push(p); } })(root);
  for (const f of files) {
    const src = readFileSync(f, 'utf8'); let m; const re = /([A-Za-z_$][\w$]*(?:\(\))?)\.auth\.signOut\(\s*\)/g;
    while ((m = re.exec(src))) assert.ok(/^(BPStore|S\(\)|S|st)$/.test(m[1]), f + ': bare ' + m[0] + ' (supabase-js default scope is global)');
    assert.doesNotMatch(src, /scope:\s*["']global["']|\? "global"/, f + ': no global sign-out');
  }
  assert.match(API, /async signOut\(\) \{[^\n]*await supa\.auth\.signOut\(\{ scope: "local" \}\)/);
  assert.match(API, /const \{ error \} = await supa\.auth\.signOut\(\{ scope: "others" \}\)/);   // signOutOthers unchanged
});

t('33 revoked session: refresh refusal codes -> &expired=1&reason=revoked; login says why once, then drops it from the URL', () => {
  assert.match(API, /const REVOKED_CODES = \/\^\(refresh_token_not_found\|session_not_found\|user_not_found\)\$\/;/);
  assert.match(API, /"&expired=1" \+ \(\(revoked \|\| refreshRevoked\) \? "&reason=revoked" : ""\)/);
  assert.match(API, /return expireSession\(isRevokedRefusal\(lastErr\)\);/);
  assert.match(API, /res\.status === 400 && \/\\\/auth\\\/v1\\\/token\\\?\(\?:\[\^#\]\*&\)\?grant_type=refresh_token\/\.test\(u\)/);
  const f = vm.runInNewContext('(' + fnSrc(API, 'isRevokedRefusal').replace(/^function isRevokedRefusal/, 'function') + ')', { REVOKED_CODES: /^(refresh_token_not_found|session_not_found|user_not_found)$/ });
  assert.equal(f({ code: 'refresh_token_not_found', status: 400 }), true); assert.equal(f({ code: 'session_not_found' }), true);
  assert.equal(f({ code: 'refresh_token_already_used', status: 400 }), false); assert.equal(f({ status: 500, code: 'session_not_found' }), false); assert.equal(f(null), false);
  const L = read('public/login.html');
  assert.match(L, /else if\(why==="revoked"\) \$\("#expiredMsg"\)\.textContent="You were signed out — this account was signed out on another browser or device, or the account changed\. Sign in again\.";/);
  assert.match(L, /u\.searchParams\.delete\("expired"\); u\.searchParams\.delete\("reason"\); history\.replaceState\(/);
});

t('33 login: a failed password sign-in shows the generic Google hint', () => {
  const L = read('public/login.html');
  assert.match(L, /<div class="info" id="gHint" role="note" hidden>If you signed up with Google, use Continue with Google\.<\/div>/);
  assert.match(L, /if\(mode==="signin" && err && err\.code==="invalid_credentials"\)\{ const g=\$\("#googleBtn"\), gh=\$\("#gHint"\); if\(gh && g && !g\.hidden\) gh\.hidden=false; \}/);
  assert.equal((L.match(/\$\("#err"\)\.hidden=true; \$\("#okmsg"\)\.hidden=true; \$\("#gHint"\)\.hidden=true;/g) || []).length, 3);
});

let n = 0;
for (const [name, fn] of tests) { try { await fn(); n++; } catch (e) { console.error('FAIL - ' + name); throw e; } }
console.log('r20-coord: ' + n + '/' + tests.length + ' passed');
