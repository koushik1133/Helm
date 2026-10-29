// r39-staff-google.test.mjs - Google-only sign-in for Helm staff (@helm.events), SQL 0288:
//  * SQL: switch OFF by default; the 0053 password hook wrapped (staff first, then the untouched lockout body); HQ needs
//    amr 'oauth' + a helm.events Workspace Google identity (hd or verified e-mail); link / identity guards; optional token
//    hook; toggle = Owner via _hq_wgate (aal2 + fresh code) + own Google sign-in, audited; no app-side bypass
//  * APPLY-0288 verbatim between begin / commit + VERIFY + emergency undo; ASCII; MANIFEST + run-all + release lists
//  * store-api: helm.events check, password / sign-up / reset refused early, the server's refusal mapped (v291)
//  * login.html: a helm.events address (switch on) hides the password box and says "use Continue with Google" -
//    run against a small fake DOM; studio addresses keep the password box
//  * hq.html / hq.js: the Owner's switch card (warning, "Test my Google sign-in first" checklist, tick box, confirm),
//    the "Sign in with Google" gate before two-step set-up; textContent only
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const SQL = rd('supabase/migrations/0288_staff_google_only.sql'), APPLY = rd('supabase/APPLY-0288.sql');
const SA = rd('public/store-api.js'), LG = rd('public/login.html'), J = rd('public/hq.js'), H = rd('public/hq.html');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

await t('SQL: one switch, OFF by default; nothing changes while it is off', () => {
  assert.match(SQL, /add column if not exists staff_google_only boolean not null default false;/);
  assert.match(SQL, /if not public\._r39_on\(\) then return true; end if;/);
  assert.match(SQL, /coalesce\(\(select s\.staff_google_only from public\.helm_hq_settings s where s\.id\), false\)/);
});
await t('SQL: password hook = staff check first, then the 0053 body (renamed once to *__pre0288, re-wrapped after a 0053 re-run)', () => {
  assert.match(SQL, /alter function public\.hook_password_verification_attempt\(jsonb\) rename to hook_password_verification_attempt__pre0288;/);
  assert.match(SQL, /'decision', 'reject', 'message', public\._r39_message\(\), 'should_logout_user', false/);
  assert.match(SQL, /return public\.hook_password_verification_attempt__pre0288\(event\);/);
  assert.match(SQL, /select 'Helm staff sign in with Google\. Use ''Continue with Google''\.'::text/);
  assert.match(SQL, /exception when others then v_staff := false;/, 'our bug never blocks sign-in');
});
await t('SQL: HQ needs a Google session (amr oauth = GIS id token + redirect) and the helm.events Workspace identity', () => {
  assert.match(SQL, /e ->> 'method' = 'oauth'/);
  assert.match(SQL, /lower\(coalesce\(p_data -> 'custom_claims' ->> 'hd', ''\)\) = 'helm\.events'/);
  assert.match(SQL, /or lower\(coalesce\(p_data ->> 'email_verified', ''\)\) = 'true'/);
  assert.match(SQL, /i\.provider not in \('email', 'phone'\)/, 'a linked personal Gmail / other provider fails');
  const ipa = SQL.slice(SQL.indexOf('create or replace function public.is_platform_admin()'), SQL.indexOf('-- ---- 4)'));
  assert.match(ipa, /coalesce\(auth\.jwt\(\) ->> 'aal', ''\) <> 'aal2'/, 'two-step stays mandatory');
  assert.match(ipa, /return public\._r39_hq_ok\(\);/);
  assert.match(ipa, /r27-hq-staff-0277/);
});
await t('SQL: links + identities guarded only while ON and only for helm.events; optional token hook; toggle gated + audited', () => {
  assert.match(SQL, /create trigger a288_staff_google_recovery before update of recovery_token on auth\.users/);
  assert.match(SQL, /create trigger a288_staff_google_identity before insert on auth\.identities/);
  assert.match(SQL, /function public\.hook_custom_access_token_r39\(event jsonb\)[\s\S]*?'http_code', 403/);
  const set = SQL.slice(SQL.indexOf('function public.hq_set_staff_google_only'), SQL.indexOf('-- sign-in page (anyone)'));
  assert.match(set, /perform public\._hq_wgate\('hq\.staff\.google_only'/);
  assert.match(set, /me\.role <> 'owner'/);
  assert.match(set, /if p_on and not \(public\._r39_session_is_google\(\) and public\._r39_login_ok\(auth\.uid\(\)\)\)/);
  assert.match(set, /perform public\._hq27_event\('settings'/);
  assert.doesNotMatch(SQL, /\bdelete\s+from\b|\bdrop\s+(table|column)\b|\btruncate\b/i);
  assert.doesNotMatch(SQL, /bypass|break_glass\s*\(/i, 'no app-side bypass function');
});
await t('APPLY-0288: migration verbatim between begin / commit, VERIFY rows, emergency undo, ASCII, no temp tables; MANIFEST + run-all + release lists', () => {
  assert.ok(APPLY.includes('begin;\n' + SQL + 'commit;'));
  assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.match(APPLY, /update public\.helm_hq_settings set staff_google_only = false, staff_google_only_changed_at = now\(\),/);
  assert.doesNotMatch(APPLY, /[^\x00-\x7F]/);
  assert.doesNotMatch(APPLY, /temp(orary)? table|^\\/im);
  assert.ok(rd('supabase/migrations/MANIFEST').includes('forward  supabase/migrations/0288_staff_google_only.sql'));
  assert.match(rd('scripts/db-test/run-all.sh'), /R39-STAFF-GOOGLE-0288: ALL PASS \\\(49\/49\\\)/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0287'(, '0[23]\d\d')*, '0288'(, '0[23]\d\d')*\]/, f);   // loosened like r44 / r47: later releases may append after 0288
});
await t('store-api (v298): exactly helm.events; password, sign-up and reset refused early; the server refusal mapped', () => {
  const src = /function isStaffEmail\(email\) \{[\s\S]*?\n  \}/.exec(SA)[0];
  const isStaffEmail = new Function(src + '; return isStaffEmail;')();
  assert.ok(isStaffEmail('admin@helm.events') && isStaffEmail(' Sales@HELM.events. '));
  for (const e of ['me@gmail.com', 'x@team.helm.events', 'x@helm.events.evil.test', 'a@b@helm.events', '@helm.events', '']) assert.ok(!isStaffEmail(e), e);
  assert.match(SA, /const STAFF_GOOGLE_MESSAGE = "Helm staff sign in with Google\. Use 'Continue with Google'\.";/);
  assert.match(SA, /supa\.rpc\("staff_google_only_for", \{ p_email:/);
  assert.match(SA, /if \(await staffGoogleOnlyFor\(email\)\) throw staffGoogleError\(\);   \/\/ r39 \(0288\): the server refuses it too\n      localAuthOp\+\+;/);
  assert.match(SA, /if \(await staffGoogleOnlyFor\(email\)\) throw staffGoogleError\(\);   \/\/ r39 \(0288\): new Helm staff logins/);
  assert.match(SA, /if \(await staffGoogleOnlyFor\(email\)\) throw staffGoogleError\(\);   \/\/ r39 \(0288\): no reset link/);
  assert.match(SA, /if \(STAFF_GOOGLE_RE\.test\(m\)\) return staffGoogleError\(\);/);
  assert.match(SA, /isStaffEmail, STAFF_GOOGLE_MESSAGE, staffGoogleOnlyFor, staffGoogleSessionCheck,/);
  assert.match(LG, /store-api\.js\?v=307/);
});

// ---- login.html behaviour: the r39 block run against a tiny fake DOM ----
function fakeDom() {
  const nodes = {};
  const node = (id) => (nodes[id] = nodes[id] || { id, hidden: false, value: '', listeners: {}, addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); } });
  ['#staffGoogleNote', '#pwLabel', '.pwwrap', '#submit', '#forgotRow', '#pwHint', '#pwRules', '#pw2Row', '#pwMeter', '#pw', '#pw2', '#email'].forEach(node);
  nodes['#staffGoogleNote'].hidden = true; ['#pwHint', '#pwRules', '#pw2Row', '#pwMeter'].forEach((k) => { nodes[k].hidden = true; });
  return nodes;
}
async function runLogin(email, switchOn, mode = 'signin') {
  const blk = LG.slice(LG.indexOf('  var staffG=false, sgTimer=null;'), LG.indexOf('  // show / hide password'));
  const N = fakeDom(); const asked = [];
  const BPStore = { isStaffEmail: (e) => /^[^@\s]+@helm\.events$/.test(e), staffGoogleOnlyFor: async (e) => { asked.push(e); return switchOn; } };
  const env = { $: (s) => N[s], document: { querySelector: (s) => N[s.replace('#loginForm ', '')] }, window: { BPStore }, BPStore,
    normEmail: (v) => String(v || '').trim().toLowerCase(), setFieldErr: () => true, mode, setTimeout, clearTimeout };
  const fn = new Function(...Object.keys(env), blk + '\nreturn { checkStaffGoogle, state: () => staffG };');
  const api = fn(...Object.values(env));
  N['#email'].value = email; N['#pw'].value = 'secret';
  api.checkStaffGoogle(); await new Promise((r) => setTimeout(r, 5));
  return { N, asked, staff: api.state() };
}
await t('login.html: a helm.events address with the switch ON hides the password box and says "use Continue with Google"', async () => {
  const { N, staff } = await runLogin('Admin@helm.events', true);
  assert.ok(staff && !N['#staffGoogleNote'].hidden);
  for (const k of ['#pwLabel', '.pwwrap', '#submit', '#forgotRow']) assert.ok(N[k].hidden, k);
  assert.equal(N['#pw'].value, '', 'any typed password is cleared');
});
await t('login.html: switch OFF, or a studio address: the password box stays (studio people unaffected)', async () => {
  const off = await runLogin('admin@helm.events', false);
  assert.ok(!off.staff && off.N['#staffGoogleNote'].hidden && !off.N['.pwwrap'].hidden && !off.N['#submit'].hidden);
  const studio = await runLogin('owner@studio.example', true);
  assert.deepEqual(studio.asked, [], 'a studio address is never even asked about');
  assert.ok(!studio.staff && studio.N['#staffGoogleNote'].hidden && !studio.N['.pwwrap'].hidden && !studio.N['#forgotRow'].hidden);
});
await t('login.html: markup, submit guard, forgot-password + error mapping, CSS keeps [hidden] working', () => {
  assert.match(LG, /<div class="info" id="staffGoogleNote" role="status" hidden>Helm staff: please use <b>Continue with Google<\/b>\.<\/div>/);
  assert.match(LG, /<label for="pw" id="pwLabel">/);
  assert.match(LG, /if\(staffG\)\{ showErr\(\$\("#err"\), BPStore\.STAFF_GOOGLE_MESSAGE/);
  assert.match(LG, /\/\^\(rate_limited\|captcha_\|staff_google_only\)\//);
  assert.match(LG, /err\.code==="reserved_domain"\|\|err\.code==="staff_google_only"/);
  assert.match(LG, /#pwLabel\[hidden\],\.pwwrap\[hidden\],#submit\[hidden\],#staffGoogleNote\[hidden\],#pw2Row\[hidden\]\{display:none\}/);
  assert.match(LG, /if\(staffG\) applyStaffGoogle\(true\);/, 'switching sign-in / sign-up keeps it hidden');
});
await t('hq.html: Owner-only switch card with a strong warning, the "Test my Google sign-in first" checklist and a tick box', () => {
  assert.match(H, /<section class="card" id="sgCard" aria-labelledby="sgH" data-perm="staff\.manage" hidden>/);
  assert.match(H, /<div class="gwarn" role="note"><b>Careful\.<\/b> If Google sign-in does not work for you, you are locked out of HQ\./);
  assert.match(H, /<h3>Test my Google sign-in first<\/h3>/);
  assert.match(H, /id="sgTested"/); assert.match(H, /id="btnSgOn"/); assert.match(H, /id="btnSgOff"/);
  assert.match(H, /hq\.js\?v=30/);
  assert.doesNotMatch(H.slice(H.indexOf('id="sgCard"'), H.indexOf('id="tmRolesH"')), /\son[a-z]+=|style=/);
});
await t('hq.js: switch needs the tick box + confirm (fresh code via call()), Owner-only card, Google gate before two-step set-up, textContent only', () => {
  assert.match(J, /if \(!ME \|\| ME\.role !== "owner"\) \{ card\.hidden = true; return; \}/);
  assert.match(J, /if \(!\$\("#sgTested"\)\.checked\) \{ showErr/);
  assert.match(J, /call\("hq_set_staff_google_only", \{ p_on: !!want \}\)/);
  assert.match(J, /\$\("#btnSgOn"\)\.disabled = !sgData\.my_session_google;/);
  assert.match(J, /if \(\(g === "enroll" \|\| g === "hq"\) && await needsGoogle\(\)[^\n]*googleGate\(\); return; \}\n    if \(g === "enroll"\)/);
  assert.match(J, /blocked\("Sign in with Google", "Helm staff sign in to HQ with their helm\.events Google Workspace account\./);
  assert.doesNotMatch(J, /innerHTML|insertAdjacentHTML|document\.write/);
});

console.log(`r39-staff-google: ${n} passed${process.exitCode ? ', FAILURES above' : ''}`);
