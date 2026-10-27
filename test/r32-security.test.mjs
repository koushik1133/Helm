// r32-security.test.mjs - r32 security review (owner-authorised), the browser / CI / repo side:
//  * hq.js CSV export: same formula-injection rule as reports.html (leading spaces, full-width = + - @)
//  * check-html-sinks: x.map(cb).join() is accepted only when the callback is visibly safe (CLI-01)
//  * telemetry: stack-frame file names lose ?token= / link refs; /<studio>/booklet/<token>; &k= (CLI-02, AUTH-1)
//  * store-api: a lockout reads like any refused sign-in (AUTH-5); no session from a #access_token fragment (AUTH-4);
//    the e-mailed invitation link's mail key (&k=) is passed to invite-signup (AUTH-1); cache-buster v285 everywhere
//  * auth-confirm: invite / magic links ask "Continue as <e-mail>" before keeping the session (AUTH-4)
//  * Control Center: "Approve discounts" + "Close events with money owed" are one-switch money permissions (BIZ-01);
//    paid plan seat wording (BIZ-03); the Join page explains a full plan
//  * SQL 0282: MANIFEST + run-all + APPLY-0282 (verbatim, VERIFY, ASCII, begin/commit, additive only)
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = async (name, fn) => { try { await fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

await t('hq.js csvCell: formula guard matches reports.html (leading spaces, full-width), numbers stay numbers', () => {
  const src = rd('public/hq.js');
  const m = /function csvCell\(v\) \{[\s\S]*?\n  \}/.exec(src); assert.ok(m, 'csvCell found');
  const csvCell = vm.runInNewContext('(' + m[0] + ')');
  for (const bad of ['=SUM(A1)', ' =1+1', '\t=1', '　=HYPERLINK("x")', '＝cmd', '＋1', '－1', '＠x', ' @x', '-2+3']) {
    assert.ok(csvCell(bad).startsWith('"\''), JSON.stringify(bad) + ' -> ' + csvCell(bad));
  }
  assert.equal(csvCell(-500), '"-500"', 'a real number is not prefixed');
  assert.equal(csvCell('Studio "A"'), '"Studio ""A"""');
  assert.equal(csvCell(null), '""');
  assert.match(rd('public/hq.html'), /hq\.js\?v=24/);
});

await t('CLI-01 check-html-sinks: map(cb).join() needs a visibly safe callback', async () => {
  const S = await import('../scripts/check-html-sinks.mjs');
  assert.equal(S.safeExpr('rows.map(r => r.name).join("")'), false, 'arrow returning a raw field');
  assert.equal(S.safeExpr('rows.map(function (r) { const h = r.html; return h; }).join("")'), false, 'block returning a variable');
  assert.equal(S.safeExpr('rows.map(rowHtmlUnreviewed).join("")'), false, 'unreviewed helper name');
  assert.equal(S.safeExpr('rows.map(r => `<li>${esc(r.name)}</li>`).join("")'), true, 'arrow -> template');
  assert.equal(S.safeExpr('rows.map(r => esc(r.name)).join(", ")'), true, 'arrow -> esc()');
  assert.equal(S.safeExpr('rows.map(function (r) { if (!r) return ""; return `<b>${esc(r)}</b>`; }).join("")'), true, 'every return checked');
  assert.equal(S.safeExpr('rows.map(function (r) { if (!r) return r.x; return ""; }).join("")'), false, 'one unsafe return is enough');
  S.setFile('public/staff.html');   // R32b: a reviewed helper is accepted only in the file it was reviewed in
  assert.equal(S.safeExpr('people.map(personCard).join("")'), true, 'reviewed SAFE_HELPERS name');
  S.setFile(null);
  const allow = JSON.parse(rd('scripts/html-sinks-allowlist.json'));
  for (const h of ['cardHtml', 'card', 'rowChk', 'rowGuest', 'rowPay', 'tab', 'opt', 'crewOption', 'taskRow', 'personCard']) {
    const e = allow.safeHelpers.find((x) => x.name === h); assert.ok(e && /R32 CLI-01 review/.test(e.why), h);
  }
  assert.doesNotMatch(rd('scripts/check-html-sinks.mjs'), /block-bodied callbacks that return a variable are not visible[^\n]*\n\s*return true;/);
});

function loadTel() {
  const w = { HELM_TELEMETRY: {}, addEventListener() {}, document: { head: { appendChild() {} }, createElement: () => ({}) } };
  vm.runInNewContext(rd('public/telemetry.js'), { window: w, document: w.document, location: { pathname: '/', reload() {} }, navigator: {}, console });
  return w.HelmTelemetry;
}
await t('CLI-02 telemetry: stack frames lose ?token= and link refs; booklet links + &k= are redacted', () => {
  const T = loadTel();
  const TOK = '11111111-2222-3333-4444-555555555555';
  const ev = T.redactEvent({ message: 'boom', exception: { values: [{ value: 'TypeError', stacktrace: { frames: [
    { filename: 'https://www.helm.events/approve.html?token=' + TOK, abs_path: 'https://www.helm.events/approve.html?token=' + TOK + '#x', function: 'f' },
    { filename: 'https://www.helm.events/aurora/booklet/bk_secret123/x', abs_path: 'https://www.helm.events/store-api.js?v=286', module: 'login?invite=abc&k=' + 'ab'.repeat(24) },
  ] } }] } });
  const s = JSON.stringify(ev);
  assert.ok(!s.includes(TOK) && !s.includes('bk_secret123') && !s.includes('ab'.repeat(24)), s);
  const f = ev.exception.values[0].stacktrace.frames;
  assert.equal(f[0].filename, 'https://www.helm.events/approve.html');
  assert.equal(f[1].abs_path, 'https://www.helm.events/store-api.js?v=286', 'asset version kept');
  assert.match(T.redact('/login?invite=abc&k=' + 'cd'.repeat(24)), /k=\[REDACTED\]/);
  for (const p of readdirSync(new URL('../public/', import.meta.url)).filter((x) => x.endsWith('.html'))) {
    const m = rd('public/' + p).match(/telemetry\.js\?v=(\d+)/); if (m) assert.equal(m[1], '9', p);
  }
});

const API = rd('public/store-api.js');
await t('AUTH-5 a server lockout on the sign-in form reads exactly like any refused sign-in (no "real account" tell)', () => {
  const m = /const LOCKOUT_RE = (\/.+\/);/.exec(API); const LOCKOUT_RE = eval(m[1]);
  const g = /function genericSignInError\(error\) \{[\s\S]*?\n  \}/.exec(API)[0];
  const fn = vm.runInNewContext(`(function(){ const GENERIC_SIGNIN = "Invalid email or password."; const LOCKOUT_RE = ${m[1]}; const global = {}; return ${g}; })()`);
  const locked = fn({ message: 'Too many attempts. Try again in 15 minutes or reset your password.', status: 400 });
  const wrong = fn({ message: 'Invalid login credentials', code: 'invalid_credentials', status: 400 });
  assert.equal(locked.message, wrong.message); assert.equal(locked.code, wrong.code);
  assert.ok(LOCKOUT_RE.test('Too many attempts. Try again in 1 hour or reset your password.'));
  assert.match(API, /LOCKOUT_RE\.test\(String\(error\.message/, 're-checking your OWN password keeps the lockout text');
});
await t('AUTH-4 no session is ever made from a #access_token fragment (legacy invite path removed)', () => {
  assert.doesNotMatch(API, /inviteFragment/);
  assert.doesNotMatch(API, /setSession\(\{ access_token: /);
  assert.match(API, /error\|error_code\|error_description\)=/, 'the fragment is still stripped');
  const AC = rd('public/auth-confirm.js');
  const i = AC.indexOf('if (link.invite) {'), j = AC.indexOf('askContinue(user.email, { title: "Join your studio on Helm"', i), k = AC.indexOf('markInviteLinkSession(need)', j);
  assert.ok(i > 0 && j > i && k > j, 'invite / magic link: asks first, marks the session only on Continue');
  assert.ok(!/markInviteLinkSession\(need\);\s*go\(link\.next\)/.test(AC), 'never continues silently');
  assert.match(AC, /if \(o\.onContinue\) o\.onContinue\(\); else handoff\(\);/);
  assert.match(rd('public/auth-confirm.html'), /auth-confirm\.js\?v=7/);
});
await t('AUTH-1 the join page sends the e-mailed mail key (&k=) to invite-signup; fallback otherwise', () => {
  const m = /async signupDirect\([\s\S]*?\n    \},/.exec(API)[0];
  assert.match(m, /get\("k"\)/); assert.match(m, /\[0-9a-f\]\{32,128\}/); assert.match(m, /mailKey \? \{ k: mailKey \} : \{\}/);
  const S = rd('supabase/functions/invite-signup/index.ts');
  const iKey = S.indexOf('if (!(await mailKeyOk(body.k,'), iCreate = S.indexOf('admin.auth.admin.createUser({');
  assert.ok(iKey > 0 && iCreate > iKey, 'mail key checked before a confirmed login is made');
  assert.match(S, /return json\(\{ fallback: true \}\);\n\n    const \{ data: made/);
  assert.match(S, /invite_signup_record/);
  const M = rd('supabase/functions/invite-mailer/index.ts');
  assert.match(M, /const key = branded \? await mintMailKey\(admin, String\(r\?\.token \?\? ""\)\) : "";/);
  const TPL = rd('supabase/functions/invite-mailer/templates.ts');
  assert.match(TPL, /invite_mail_key_set/); assert.match(TPL, /p_hash: await sha256Hex\(key\)/);
});
await t('store-api cache-buster: every page loads store-api.js?v=289', () => {
  for (const p of readdirSync(new URL('../public/', import.meta.url)).filter((x) => x.endsWith('.html'))) {
    const m = rd('public/' + p).match(/store-api\.js\?v=(\d+)/); if (m) assert.equal(m[1], '289', p);
  }
});

await t('BIZ-01 Control Center: "Approve discounts" + "Close events with money owed" are one-switch permissions (admin only by default)', () => {
  for (const [k, lbl] of [['discount_approve', 'Approve discounts'], ['close_owed', 'Close events with money owed']]) {
    const m = new RegExp(`\\{ key: "${k}",\\s+label: "([^"]+)"[^}]*group: "Finance", permission: true \\}`).exec(API);
    assert.ok(m && m[1].startsWith(lbl), k);
    assert.doesNotMatch(m[0], /defaultOn/, k + ' default off (admin only)');
  }
  const C = rd('public/control.html');
  assert.match(C, /if\(a\.permission\)\{/);
  assert.match(C, /data-perm="1"/);
  assert.match(C, /saveCell\(selRole, area, chip\.dataset\.perm \? "perm" :/);
  assert.match(C, /if\(kind==="perm"\)\{ view=edit=!\(cur\.view&&cur\.edit\); \}/);
  assert.match(C, /kind==="perm"\?\(edit\?"allowed":"not allowed"\)/);
  const SQL = rd('supabase/migrations/0282_r32_security_review.sql');
  assert.match(SQL, /has_area\('discount_approve', 'edit'\)/); assert.match(SQL, /has_area\('close_owed', 'edit'\)/);
});
await t('BIZ-03 invite screen: a paid plan at its limit says "Your plan allows N team invites. Contact sales to add more."', () => {
  const C = rd('public/control.html');
  const i = C.indexOf('async function renderSeats()'), j = C.indexOf('async function renderInvites()');
  const body = C.slice(i, j);
  assert.match(body, /if\(!r\.trial\)\{/);
  assert.match(body, /Your plan allows \$\{extra\} team invite\$\{extra===1\?"":"s"\}\. Contact sales to add more\./);
  assert.match(body, /lock\(!!r\.at_limit\); return;/);
  assert.match(rd('public/login.html'), /err\.hint==="plan_seat_limit"/);
  const SQL = rd('supabase/migrations/0282_r32_security_review.sql');
  assert.match(SQL, /'Your plan allows % team invite%\. Contact sales to add more\.'/);
  assert.match(SQL, /update public\.helm_plans set seat_limit = 3  where code = 'starter' and seat_limit is null;/);
  assert.match(SQL, /update public\.helm_plans set seat_limit = 15 where code = 'studio'  and seat_limit is null;/);
});

await t('SQL 0282: registered (MANIFEST, run-all, release lists), APPLY verbatim + VERIFY, ASCII, additive only', () => {
  const SQL = rd('supabase/migrations/0282_r32_security_review.sql'), APPLY = rd('supabase/APPLY-0282.sql');
  assert.match(rd('supabase/migrations/MANIFEST'), /^forward  supabase\/migrations\/0282_r32_security_review\.sql$/m);
  assert.match(rd('scripts/db-test/run-all.sh'), /run "r32-security-0282" "R32-SECURITY-0282: ALL PASS \\\(\d+\/\d+\\\)" psql -q -f tests\/db\/r32-security-0282\.sql/);
  // 0279 / 0281 (other PRs) may sit between 0277 and 0282 once merged
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0277', ('0279', )?('0281', )?'0282'[\],]/, f);
  assert.match(rd('scripts/db-test/run-all.sh'), /run "r32b-round2-0282" "R32B-ROUND2-0282: ALL PASS \\\(\d+\/\d+\\\)" psql -q -f tests\/db\/r32b-round2-0282\.sql/);
  assert.ok(APPLY.includes(SQL.trimEnd()), 'APPLY carries the migration verbatim');
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m); assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.ok((APPLY.match(/^  \('\d\d /gm) || []).length >= 10, 'VERIFY rows');
  for (const s of [SQL, APPLY, rd('tests/db/r32-security-0282.sql'), rd('tests/db/r32b-round2-0282.sql')]) assert.ok(/^[\x00-\x7f]*$/.test(s), 'ASCII only');
  const code = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  assert.doesNotMatch(code, /\bdrop\s+(table|column|function|policy|schema|view)\b/i, 'no drops (triggers are re-created only)');
  assert.doesNotMatch(code, /\bdelete\s+from\b|\btruncate\b/i, 'no data deleted');
  assert.doesNotMatch(code, /create\s+temp|pg_temp/i, 'no temp tables / session state');
  assert.match(code, /add column if not exists mail_key_hash text;/); assert.match(code, /add column if not exists seat_limit integer;/);
  assert.match(code, /STOP 0282:/, 'STOP guard when prerequisites are missing');
});

console.log(`r32-security: ${n} test(s) passed.`);
