#!/usr/bin/env node
// R20 (fix/r20-planner): live-QA fixes from the PLANNER round (studio /sita/, role planner, "Create new quotes" off).
//  1. Top-bar "New quote" needs can("create") too; the create menu lists only what the role can make
//  2. "+ New lead" follows leads EDIT (RLS "ra ins" = has_area('leads','edit')); Convert -> quote keeps the create switch
//  3. Nurture "-> Lead" needs leads edit as well
//  4. Lead Notes: masked + read-only while amounts are hidden; Save sends the real note
//  5. Dashboard Follow-ups "Reply" opens that lead (leads.html?hs=<name>)
//  6. Trial teammate notice: a role without quote creation is not promised quotes
//  7. Greeting: 1-2 letter first word -> full name (chat's shortName rule)
//  8. Tour "Create something new" names the TOP-BAR menu; no quote wording without the create switch
//  9. Business: Insights links only for roles that can open Insights
// 10. Templates: the one-time notice (trial wording / role block) instead of a silent bounce
// 11. One lead -> quote rule for the dashboard AND Business
// 12. Flow payment copy when online links are off; 13. studio dates (flow, logistics)
// 14. Closure "Close anyway…" label with blockers; 15. Discovery budget placeholder masked
// 16. Flow "Send for approval" hidden once approved / paid; 17. Google sign-in wording; 18. neutral Work hint
// 19. Chat tick labels; 20. bell refreshes serialized + after the read mark; 21. Staff "Job role", Admin only for admins
// Pure Node, no deps.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const root = new URL('..', import.meta.url);
const rd = (p) => readFileSync(new URL(p, root), 'utf8');
const require = createRequire(import.meta.url);
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };

const SB = rd('public/shell-b.js'), DASH = rd('public/shell-b-dash.js'), MONEY = rd('public/shell-b-money.js');
const LEADS = rd('public/leads.html'), NUR = rd('public/nurture.html'), DH = rd('public/dashboard.html');
const PRIV = rd('public/shell-b-privacy.js'), TD = rd('public/trial-demo.js'), FLOW = rd('public/flow.html');
const LOG = rd('public/logistics.html'), CLO = rd('public/closure.html'), DISC = rd('public/discovery.html');
const AUI = rd('public/auth-ui.js'), CHAT = rd('public/chat.html'), API = rd('public/store-api.js'), STAFF = rd('public/staff.html');

t('1 top-bar New quote needs the create switch (capOk) as well as quotes edit', () => {
  assert.match(SB, /\{ label: "New quote", icon: "quotes", area: "quotes", edit: true, cap: "create", run: startQuote \}/);
  assert.match(SB, /c\.cap \? Promise\.all\(\[can\(c\.area, c\.edit\), capOk\(c\.cap\)\]\)/);
  assert.match(SB, /function capOk\(cap\) \{/);
  assert.match(SB, /Promise\.all\(\[can\("quotes", true\), capOk\("create"\)\]\)\.then\(function \(r\) \{ var ok = r\[0\] && r\[1\];/);
  // menu entries keep their area-edit gates (lead / inventory / vendor / staff)
  for (const a of ['leads', 'inventory', 'vendors', 'staff']) assert.match(SB, new RegExp('area: "' + a + '", edit: true, href: "' + a + '\\.html#hb-new"'));
});

t('2 New lead = leads edit; Convert -> quote = create switch + leads edit', () => {
  assert.match(LEADS, /canCreate=!!e1; canConvertQ=!!\(c1&&e1\);/);
  assert.match(LEADS, /const canConvert = canConvertQ && !l\.quote_id/);
  assert.match(LEADS, /\$\("#newBtn"\)\.hidden=!canCreate;/);
  // the server rule this follows: phase29 replaced every leads policy with has_area('leads','edit')
  assert.match(rd('supabase/phase29-role-access.sql'), /create policy "ra ins"  on public\.leads|create policy "ra ins"  on public\.%I for insert to authenticated with check \( public\.has_area\(%L,'edit'\) \)/);
  // other entry points already use leads edit
  assert.match(rd('public/studio-search.js'), /id: "new-lead",[^\n]*need: \[\["edit", "leads"\]\]/);
});

t('3 nurture -> Lead needs leads edit too (and says the trial cap)', () => {
  assert.match(NUR, /\[canEdit, canLead\]=await Promise\.all\(\[BPStore\.auth\.canEditArea\("nurture"\), BPStore\.auth\.canEditArea\("leads"\)/);
  assert.match(NUR, /\$\{canLead\?`<button type="button" class="lnk" data-conv=/);
  assert.match(NUR, /BPUI\.capToast\(e,"leads",/);
});

t('4 lead Notes masked + read-only while amounts are hidden; Save never writes the mask', () => {
  assert.match(PRIV, /hasMoney: hasMoney, maskText: function \(s\) \{ RE\.lastIndex = 0; return String\(s == null \? "" : s\)\.replace\(RE, "••••"\); \}/);
  assert.match(LEADS, /notes:\(notesMasked\?notesReal:\$\("#f_notes"\)\.value\)\.trim\(\)\|\|null/);
  assert.match(LEADS, /if\(!notesMasked\) notesReal=ta\.value;/);
  assert.match(LEADS, /notesMasked=mask; ta\.readOnly=mask; if\(hint\) hint\.hidden=!mask;/);
  assert.match(LEADS, /<p id="f_notesHint" class="nhint" hidden>Amounts in this note are hidden\. <button type="button" id="f_notesShow">Show amounts to edit notes<\/button><\/p>/);
  assert.match(rd('public/leads-polish.css'), /\.fld \.nhint\{/);
});

t('5 Follow-ups Reply deep-links to the lead', () => {
  assert.match(DASH, /function leadHref\(l\) \{ var n = l && l\.name \? String\(l\.name\)\.slice\(0, 80\) : ""; return n \? "leads\.html\?hs=" \+ encodeURIComponent\(n\) : "leads\.html"; \}/);
  assert.equal((DASH.match(/leadHref\(l\)/g) || []).length, 3, 'definition + Needs attention + Follow-ups');
  assert.ok(!/"came in " \+ ago\(l\.created_at\)\]\.filter\(Boolean\)\.join\(" · "\), "leads\.html"/.test(DASH));
});

t('6 teammate trial notice: 2 new quotes; no quote promise for a role that cannot create', () => {
  const F = require('../public/trial-facts.js');
  assert.match(F.NOTICE[3], /up to 2 new quotes \(events\)/);
  assert.match(F.NOTICE_NO_QUOTES, /Your role does not create new quotes/);
  assert.ok(!/as many|as it likes/.test(JSON.stringify([F.NOTICE, F.NOTICE_NO_QUOTES])));
  assert.match(rd('public/trial-facts.js'), /if \(i === NOTICE_QUOTES_AT\) li\.setAttribute\("data-k", "quotes"\);/);
  assert.match(TD, /Promise\.all\(\[A\.can\("create"\), A\.canEditArea\("quotes"\)\]\)\.then\(\(r\) => \{ if \(!\(r\[0\] === true && r\[1\] === true\)\) li\.textContent = F\.NOTICE_NO_QUOTES; \}/);
});

t('7 greeting keeps the full name when the first word is 1-2 letters', () => {
  assert.match(DASH, /var nm1 = nm\.split\(" "\)\[0\] \|\| ""; nm = nm1\.length > 2 \? nm1 : nm;/);
  const pick = (s) => { s = String(s || '').replace(/\s+/g, ' ').trim(); const a = s.split(' ')[0] || ''; return a.length > 2 ? a : s; };
  assert.equal(pick('S Koushik'), 'S Koushik'); assert.equal(pick('Sita Rao'), 'Sita'); assert.equal(pick('Al  Khan'), 'Al Khan');
});

t('8 tour "Create something new" names the top-bar menu, role-aware', () => {
  assert.match(SB, /window\.__helmTopNewMenu = items\.filter\(function \(c\) \{ return c\.run !== startQuote; \}\)\.map\(function \(c\) \{ return c\.label; \}\);/);
  assert.match(DH, /uses:\["create","edit:quotes"\], alt:\(can\)=>\(can\("create"\)&&can\("edit:quotes"\)\)\?null:\{desc:TOUR_NEW\(false\)\}/);
  const m = /const TOUR_NEW=\(quote\)=>\{[\s\S]*?\};\n/.exec(DH); assert.ok(m, 'TOUR_NEW');
  const run = (top, q) => { const window = { __helmTopNewMenu: top, __helmNewMenu: ['New lead', 'New client'] }; return new Function('window', m[0] + 'return TOUR_NEW(' + q + ');')(window); };
  assert.equal(run(['New lead', 'Vendor', 'Staff member'], true), '“New quote” starts pricing an event. The little arrow next to it opens more: a new lead, vendor or staff member.');
  assert.equal(run(['New lead', 'Inventory item'], false), '“New” opens a menu to add a new lead or inventory item.');
  assert.ok(!/client/.test(run(['New lead'], true)), 'no "new client" from the dashboard menu');
});

t('9 Business: Insights link only with insights view', () => {
  assert.match(rd('public/business.html'), /<a href="insights\.html" id="bzInsNav" hidden>Insights<\/a>/);
  assert.match(rd('public/business.js'), /ins\.hidden = !\(!A\.enabled\(\) \|\| \(await A\.canView\("insights"\)\) === true\)/);
  assert.match(MONEY, /var insL = link\("insights\.html", "bz-btn", "Insights"\); insL\.hidden = true;/);
  assert.match(MONEY, /IA\.canView\("insights"\)\)\.then\(function \(v\) \{ insL\.hidden = v !== true; \}/);
  assert.match(rd('public/business.css'), /\.bz-header \.nav a\[hidden\] \{ display: none; \}/);
});

t('10 Templates: one-time notice like the audit log', () => {
  assert.match(rd('public/templates.html'), /if\(!\(await BPStore\.auth\.requireView\("templates"\)\)\)\{ try\{ if\(window\.HelmTrialLock&&HelmTrialLock\.roleBlocked\) HelmTrialLock\.roleBlocked\(\); \}catch\(_\)\{\} return; \}/);
  assert.match(rd('public/trial-lock.js'), /templates: "Templates aren't available on the free trial\."/);
});

t('11 one lead -> quote rule on the dashboard and Business', () => {
  assert.match(SB, /if \(typeof R\.conv !== "function"\) R\.conv = function \(list\)/);
  assert.match(DASH, /if \(R && typeof R\.conv === "function"\) return R\.conv\(list\);/);
  assert.match(MONEY, /var allLc = leadConvAll\(leads\);/);
  assert.match(MONEY, /"↓ " \+ allLc\.conv \+ " of " \+ allLc\.n \+ " leads became quotes \(" \+ allLc\.pct \+ "%\)"/);
  assert.match(DASH, /"↓ " \+ allLc\.conv \+ " of " \+ allLc\.n \+ " leads became quotes \(" \+ allLc\.pct \+ "%\)"/);
});

t('12/13 flow payment copy + studio dates', () => {
  assert.match(FLOW, /<span id="pay_how">Send an online link or record cash\.<\/span>/);
  assert.match(FLOW, /ph\.textContent="Record a cash \/ offline payment \(online payment links aren't switched on yet\)\.";/);
  assert.match(FLOW, /"Balance due by "\+BPStore\.fmtDateIN\(t\.balanceDue\)/);
  assert.match(LOG, /\$\{esc\(i\.due_date\?BPStore\.fmtDateIN\(i\.due_date\):""\)\}/);
  assert.ok(!/esc\(i\.due_date\|\|""\)/.test(LOG));
});

t('14 closure: "Close anyway…" with blockers, same confirm flow (no new hard block)', () => {
  assert.match(CLO, /btn\.textContent=bl\.early\?"Can't close until after the event day":"Close anyway…";/);
  assert.match(CLO, /btn\.setAttribute\("aria-describedby","closeBlockers"\)/);
  assert.match(CLO, /closeLabel\(bl\);\n      if\(!bl\.lines\.length\)\{ box\.hidden=true; return; \}/);
  assert.match(CLO, /\{title:"Close with an override\?",okLabel:"Override & close",danger:true\}/);   // unchanged flow
});

t('15 discovery budget placeholder is •••• while amounts are hidden', () => {
  assert.match(DISC, /const ph=document\.documentElement\.classList\.contains\("hb-priv-on"\)\?"••••":"Not set yet";/);
});

t('16 flow: Send for approval goes away once approved / paid', () => {
  assert.match(FLOW, /sb\.hidden = paidCount>0 \|\| ap==="approved" \|\| ap==="paid";/);
  assert.match(FLOW, /function paintBookingBadge\(paidCount\)\{ const b=\$\("#bookingBadge"\); try\{ paintApprBtn\(paidCount\); \}catch\(_\)\{\}/);
});

t('17/18 account wording for Google sign-in; neutral Work hint', () => {
  assert.match(AUI, /var dvNoPw = !!\(st\.auth\.hasPassword && !st\.auth\.hasPassword\(\)\);/);
  assert.match(AUI, /then secure your Google account/);
  assert.match(AUI, /noPw \? "Off\. Turn it on so a Google account someone else gets into still can't open Helm without your code\."/);
  assert.match(AUI, /section\("Work", "Helps your studio assign the right jobs to you\.", true, wFilled\)/);
  assert.ok(!/Helps planners assign/.test(AUI));
});

t('19/20 chat ticks labelled; bell recount after the read mark, refreshes serialized', () => {
  assert.match(CHAT, /aria-label="Read" title="Read">✓✓<\/span>/);
  assert.match(CHAT, /aria-label="Delivered" title="Delivered">✓✓<\/span>/);
  assert.match(CHAT, /Promise\.resolve\(\)\.then\(\(\)=>BPStore\.chat\.markRead\(id\)\)\.catch\(\(\)=>\{\}\)\.then\(bumpBell\);/);
  assert.match(API, /const refresh = \(\) => \{ if \(!\(auth\.enabled\(\) && auth\.user\(\)\)\) \{ bellStop\(\); return Promise\.resolve\(null\); \} const p = rfChain\.then\(refreshNow, refreshNow\); rfChain = p\.then\(\(\) => \{\}, \(\) => \{\}\); return p; \};/);
  assert.match(API, /try \{ window\.__bpBellRefresh = refresh; \} catch \(e\) \{\}/);
});

t('21 staff: "Job role" for non-admins, Admin option admin-only, Admin invite confirmed', () => {
  assert.match(STAFF, /lb\.textContent=\(!linked&&!isAdminUser\)\?"Job role":"Role";/);
  assert.match(STAFF, /staffRoles\(\)\.filter\(r=>isAdminUser\|\|linked\|\|r\.key!=="admin"\|\|cur==="admin"\)/);
  assert.match(STAFF, /if\(key==="admin" && !\(await BPUI\.confirm\(`Invite \$\{s\.name\} \(\$\{s\.email\}\) to sign in as Admin\?/);
});

console.log('r20-planner ' + n + '/' + n + ' ok');
