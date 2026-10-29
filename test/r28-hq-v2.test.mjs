// r28-hq-v2.test.mjs - Helm HQ v2 (local): new IA (+ Settings), masked personal details with a LOGGED reveal (SQL 0278),
// phone menu + bottom bar, tables -> cards (data-label), localhost-only demo mode (hq-demo.js, never deployed).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const J = rd('public/hq.js'), H = rd('public/hq.html'), D = rd('public/hq-demo.js');
const SQL = rd('supabase/migrations/0278_hq_reveal_log.sql'), APPLY = rd('supabase/APPLY-0278.sql');
const S = require('../public/hq-staff.js');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'function ' + name + ' not found');
  let d = 0, j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } }
  throw new Error('unbalanced ' + name);
}
const cx = { String, Number, Math, Array };
vm.createContext(cx);
vm.runInContext('var DOT = "\\u2022";\n' + ['maskEmail', 'maskPhone', 'maskId', 'demoWanted'].map((f) => fnSrc(J, f)).join('\n')
  + '\nthis.maskEmail = maskEmail; this.maskPhone = maskPhone; this.maskId = maskId; this.demoWanted = demoWanted;', cx);
const B = '\u2022';

t('maskers: a hint only, never the whole value', () => {
  assert.equal(cx.maskEmail('kavya@shaadisquad.in'), 'ka' + B + B + B + '@shaadisquad.in');
  assert.equal(cx.maskEmail('ab@x.in'), 'a' + B + B + B + '@x.in');
  assert.equal(cx.maskEmail(''), ''); assert.equal(cx.maskEmail(null), '');
  assert.equal(cx.maskPhone('+91 98490 11223'), '+91 ' + B.repeat(8) + '23');
  assert.equal(cx.maskPhone('+971 50 123 4567'), '+971 ' + B.repeat(7) + '67');
  assert.ok(!/98490|11223/.test(cx.maskPhone('+91 98490 11223')));
  assert.equal(cx.maskId('ABCDE1234F'), 'AB' + B.repeat(6) + '4F');
  assert.equal(cx.maskId('36ABCDE1234F1Z5'), '36' + B.repeat(11) + 'Z5', 'the PAN inside a GSTIN is hidden too');
  assert.equal(cx.maskId('AB1'), B.repeat(3));
});
t('reveal: logged FIRST (hq_log_reveal, fallback heartbeat tick), role refusal = nothing shown; the value is never sent', () => {
  const lr = fnSrc(J, 'logReveal');
  assert.match(lr, /call\("hq_log_reveal", \{ p_entity: entity, p_entity_id: id == null \? null : String\(id\), p_field: field \|\| "value" \}\)/);
  assert.match(lr, /if \(S && S\.errKind\(e\)\) throw e;/);
  assert.match(lr, /BPStore\.hq\("hq_heartbeat", \{ p_page: "reveal" \}\)/);
  const m = fnSrc(J, 'masked');
  // r57 (0298): the value comes back from hq_reveal (role check + log + value in one call); an older database falls
  // back to "log first, then show the value the page already has"
  assert.match(m, /revealValue\(entity, id, field \|\| kind, v\)\.then\(function \(r\) \{/);
  const rv = fnSrc(J, 'revealValue');
  assert.match(rv, /call\("hq_reveal", \{ p_entity: entity, p_entity_id: id == null \? null : String\(id\), p_field: field \|\| "value" \}\)/);
  assert.match(rv, /!isMasked\(shown\)\) \{\s*return logReveal\(entity, id, field\)/);
  assert.doesNotMatch(m, /p_value/);
  // business-details form (every value unmasked) is filled only after the reveal (hq_reveal business_details, logged)
  assert.match(J, /call\("hq_reveal", \{ p_entity: "studio", p_entity_id: String\(org\), p_field: "business_details" \}\)/);
  assert.match(J, /\.then\(function \(\) \{ fillForm\(\); filled = true; more\.appendChild\(af\); \}\)/);
  assert.match(J, /logReveal\("billing", "payments", "csv_export"\)/);
  // masked places: studios list, drawer contact (email, phone, billing e-mail, GSTIN, PAN), members, people, requests
  for (const s of ['contactLine(r.primary_contact_email, r.primary_contact_phone, "studio", r.org_id)', 'masked(acc.gstin, "id", "studio", org, "gstin")',
    'masked(acc.pan, "id", "studio", org, "pan")', 'masked(m.email, "email", "member", m.user_id || org, m.user_id ? "email" : "member_email")', 'masked(r.email, "email", "person", r.user_id || null, "email")',
    'contactLine(x.contact_email, x.contact_phone, "request", x.id)', 'contactLine(x.email, x.phone, "enquiry", x.id)', 'masked(x.email, "email", "suggestion", x.id, "email")'])
    assert.ok(J.includes(s), s);
  assert.doesNotMatch(J, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/);
});
t('IA: nine pages incl. Settings; tab ids kept; roles unchanged (Sales / Support / Viewer never see Settings)', () => {
  assert.match(J, /var TABS = \["overview", "studios", "billing", "requests", "plans", "people", "activity", "staff", "settings", "privacy"\];/);
  assert.match(H, /<button type="button" class="tab" id="tab-settings" aria-pressed="false">Settings<\/button>/);
  assert.match(H, /id="tab-activity" aria-pressed="false">Security &amp; activity</); assert.match(H, /id="tab-staff" aria-pressed="false">HQ team</);
  assert.equal(S.TAB_PERM.settings, 'settings.read');
  assert.ok(!S.allowedTabs(S.ROLE_PERMS.sales).includes('settings') && !S.allowedTabs(S.ROLE_PERMS.support).includes('settings'));
  assert.ok(S.allowedTabs(S.ROLE_PERMS.admin).includes('settings'));
  // invoice + checkout settings now live in Settings (same ids), loaded when Settings opens
  const pane = H.slice(H.indexOf('<section id="pane-settings"'), H.indexOf('</section>\n    </div>\n  </div>\n  <nav class="bnav"'));
  for (const id of ['sName', 'sGstin', 'btnSettings', 'coLive', 'coBypass', 'btnCheckout']) assert.ok(pane.includes(`id="${id}"`), id);
  assert.match(J, /if \(t === "settings" && can\("billing\.read"\)\) loadSettings\(\)\.catch\(showErr\);/);
});
t('responsive: slide-in menu, bottom bar, tables -> cards with column labels', () => {
  for (const id of ['btnMenu', 'navScrim', 'bnav']) assert.ok(H.includes(`id="${id}"`), id);
  assert.match(H, /@media \(max-width:1023px\)\{[\s\S]*?\.hq\.nav-open \.side\{transform:none;visibility:visible/);
  assert.match(H, /\.rt thead\{display:none\}/); assert.match(H, /content:attr\(data-label\)/);
  assert.match(fnSrc(J, 'labelTables'), /td\.setAttribute\("data-label", heads\[i\] \|\| ""\)/);
  assert.match(J, /new MutationObserver\(/);
  assert.doesNotMatch(H, /\son[a-z]+=/i); assert.doesNotMatch(H, /\sstyle="/);
});
t('demo: localhost + ?demo=1 only, checked twice; never deployed; no network; changes refused', () => {
  for (const [h, q, ok] of [['127.0.0.1', '?demo=1', true], ['localhost', '?x=1&demo=1', true], ['[::1]', 'demo=1', true], ['www.helm.events', '?demo=1', false],
    ['helm-v01.vercel.app', '?demo=1', false], ['127.0.0.1.evil.com', '?demo=1', false], ['localhost', '?demo=10', false], ['localhost', '', false]])
    assert.equal(cx.demoWanted(h, q), ok, h + q);
  assert.match(J, /sc\.src = "hq-demo\.js\?v=1"/);
  assert.match(D, /if \(!\/\^\(localhost\|127\\\.0\\\.0\\\.1\|\\\[::1\\\]\)\$\/i\.test\(host\)\) return;/);
  assert.doesNotMatch(D, /fetch\(|XMLHttpRequest|supabase|createClient|localStorage|sendBeacon/);
  assert.match(D, /Demo mode - nothing is saved/);
  assert.ok(rd('.vercelignore').split('\n').includes('public/hq-demo.js'), 'hq-demo.js never deployed');
  assert.doesNotMatch(H, /hq-demo\.js/, 'not referenced by the page');
});
t('HQ still shows no studio business data', () => {
  assert.doesNotMatch(J + H + D, /recent_events|open_milestones|revenue|events_count|confirmed_count|milestone/i);
});
t('SQL 0278: one gated function, never the value, signed-in only, additive, ASCII, APPLY verbatim + VERIFY, MANIFEST', () => {
  const code = SQL.replace(/--[^\n]*/g, '');
  assert.match(code, /perform public\._hq27_require\(v_perm, false\);/);
  assert.match(code, /'hq\.reveal', v_entity, nullif\(v_id, ''\), jsonb_build_object\('field', v_field\)/);
  assert.doesNotMatch(code, /\b(delete\s+from|drop\s+(table|column)|truncate|alter\s+table|update\s+public)\b/i);
  assert.match(code, /revoke all on function public\.hq_log_reveal\(text, text, text\) from anon/);
  assert.doesNotMatch(code, /grant execute on function public\.hq_log_reveal\([^)]*\) to anon/);
  assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(SQL + APPLY), 'ASCII');
  assert.ok(APPLY.includes('begin;\n' + SQL + 'commit;'));
  assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.ok(rd('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/0278_hq_reveal_log.sql'));
});
t('owner round 2: money in US dollars (display only, marked), studio facts, users, referrals; demo names', () => {
  const c2 = { Number, isFinite, Intl }; vm.createContext(c2);
  vm.runInContext(fnSrc(J, 'num') + '\n' + fnSrc(J, 'toUsd') + '\nthis.toUsd = toUsd;', c2);
  assert.deepEqual(JSON.parse(JSON.stringify(c2.toUsd(8400, 'INR', { cur: 'USD', rate: 84 }))), { usd: 100, approx: true });
  assert.deepEqual(JSON.parse(JSON.stringify(c2.toUsd(119, 'USD', { cur: 'USD', rate: 84 }))), { usd: 119, approx: false });
  assert.equal(c2.toUsd(100, 'INR', { cur: 'ORIG', rate: 84 }), null);
  assert.equal(c2.toUsd(100, 'EUR', { cur: 'USD', rate: 84 }), null, 'unknown rate: shown as it is');
  assert.match(J, /function moneyRaw\(v, cur\)/); assert.match(J, /"\?\\n\\nPayment " \+ moneyBoth\(a\.p_amount\)/);
  assert.match(H, /<th>Plan &amp; currency<\/th><th>Status<\/th><th>Created<\/th><th class="n">Team<\/th>/);
  for (const s of ['fact("Team size"', 'fact("Last active"', 'fact("Created"', '"Using Helm"', '"Active days (last 30)"', '"Sign-ins (last 30 days)"', 'el("h2", { text: "Credits & free months" })',
    'el("h2", { text: "Referrals" })', '["Studios they referred"', '["Credits earned"']) assert.ok(J.includes(s), s);
  assert.doesNotMatch(D, /k9@|Koushik/); assert.match(D, /name: "Helm Admin"/); assert.match(D, /email: "support@helm\.events", name: "Support", role: "owner", role_label: "Owner", status: "invited"/);
});
t('round 2: full studio page, credits (0280), plan editor, sessions, info@, Data & privacy, live website prices', () => {
  assert.match(H, /<aside id="studioDrawer" class="drawer full"/);
  assert.ok(H.indexOf('id="dt-people"') < H.indexOf('id="dt-plan"'), 'tabs: Overview, People, Billing & plan, Name & link, Activity');
  assert.match(J, /call\("hq_grant_studio_credit", \{ p_org: org, p_kind: kind\.value, p_months: Number\(months\.value\), p_reason: rs \}\)/);
  assert.match(J, /\.then\(function \(\) \{ return co \? call\("hq_set_plan_checkout", co\) : null; \}\)/);
  for (const id of ['planEditor', 'btnPlanNew', 'plInrY', 'sessInfo', 'seEmailList', 'pane-privacy', 'tab-privacy', 'dispCur']) assert.ok(H.includes(`id="${id}"`), id);
  assert.match(H, /<option value="info@helm\.events">/);
  assert.match(J, /blocked\("Session expired — sign in again"/);
  const c3 = { Date, Math, Number, isFinite }; vm.createContext(c3); vm.runInContext(fnSrc(J, 'sessionEnds') + '\nthis.f = sessionEnds;', c3);
  assert.equal(c3.f('2026-10-21T00:00:00Z', '2026-10-21T11:50:00Z', 30, 12), '2026-10-21T12:00:00.000Z', 'max hours wins');
  assert.equal(c3.f('2026-10-21T00:00:00Z', '2026-10-21T01:00:00Z', 30, 12), '2026-10-21T01:30:00.000Z', 'idle wins');
  assert.equal(S.TAB_PERM.privacy, 'self');
  for (const href of ['/privacy', '/terms', '/dpa']) assert.ok(H.includes(`href="${href}" target="_blank" rel="noopener"`), href);
  const PL = rd('public/pricing-live.js'), PH = rd('public/pricing.html');
  assert.match(PL, /\/rest\/v1\/rpc\/public_pricing_plans/); assert.doesNotMatch(PL, /innerHTML|insertAdjacentHTML|document\.write|eval\(/);
  assert.match(PL, /if \(!matched\.length\) return;/, 'fallback: nothing changes unless a card matches');
  for (const c of ['starter', 'studio', 'enterprise']) assert.ok(PH.includes(`data-plan="${c}"`), c);
  assert.match(PH, /<b>\$24<\/b>/, 'built-in prices stay as the fallback');
  const S80 = rd('supabase/migrations/0280_hq_v2_round2.sql'), A80 = rd('supabase/APPLY-0280.sql'), code = S80.replace(/--[^\n]*/g, '');
  assert.ok(A80.includes('begin;\n' + S80 + 'commit;')); assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(S80 + A80), 'ASCII');
  assert.doesNotMatch(code, /\b(delete\s+from|drop\s+(table|column)|(?<!before )truncate|update\s+public)\b/i);   // r42: 'before truncate' = the no-truncate guard
  assert.doesNotMatch(code.slice(code.indexOf('function public.public_pricing_plans'), code.indexOf('function public.hq_my_session')), /razorpay/i);
  assert.match(code, /perform public\._hq27_require\('billing\.write', true\);/);
  assert.match(code, /create trigger a280_credits_no_delete before delete on public\.hq_studio_credits/);
  assert.ok(rd('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/0280_hq_v2_round2.sql'));
});
console.log(process.exitCode ? 'r28-hq-v2: FAILED' : `r28-hq-v2: ${n} passed`);
