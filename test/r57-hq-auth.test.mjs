// r57-hq-auth.test.mjs - R57 "HQ and sign-in hardening" (audit 2026-10-28), browser / edge / repo side:
//  * hq.js: values arrive masked from the database; "Show", "Reply by email", the business-details form and the
//    two-step reset confirm use hq_reveal (role check + log + value in one call); the page's maskers give the SAME
//    text as the database's (_r57_mask_*), so a typed address can be matched against a masked one
//  * hq-referrals.js: partner-code edit / new only with billing.write (G-HQ-2)
//  * store-api.js: invitations listed with explicit columns (never token / mail_key_hash); the sign-up e-mail look-up
//    is yes / no only; the invite mail key can come from this tab's storage (A-4, A-5, A-7)
//  * login.html: invite token + &k= leave the address bar after they are read (A-7)
//  * edge: clientIp never uses the first x-forwarded-for hop (E-02); send-phone-code checks sign-in before 503 and
//    refuses banned / deactivated logins (A-10); invite-signup look-up yes / no (A-4)
//  * SQL 0298: MANIFEST + run-all + release lists, APPLY verbatim + VERIFY, ASCII, additive only, STOP guard
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };
const J = rd('public/hq.js'), REF = rd('public/hq-referrals.js'), API = rd('public/store-api.js'), LOGIN = rd('public/login.html');
const LIM = rd('supabase/functions/_shared/limits.ts'), SPC = rd('supabase/functions/send-phone-code/index.ts'), INV = rd('supabase/functions/invite-signup/index.ts');
const SQL = rd('supabase/migrations/0298_r57_hq_auth_hardening.sql'), APPLY = rd('supabase/APPLY-0298.sql'), DBT = rd('tests/db/r57-hq-auth-0298.sql');
function fnSrc(src, name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i >= 0, 'function ' + name + ' not found');
  let d = 0; const j = src.indexOf('{', i);
  for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } }
  throw new Error('unbalanced ' + name);
}
const cx = { String, Number, Math, Array };
vm.createContext(cx);
vm.runInContext('var DOT = "\\u2022";\n' + ['maskEmail', 'maskPhone', 'maskId', 'isMasked', 'sameAddr'].map((f) => fnSrc(J, f)).join('\n')
  + '\nthis.maskEmail = maskEmail; this.maskPhone = maskPhone; this.maskId = maskId; this.isMasked = isMasked; this.sameAddr = sameAddr;', cx);
const D = '\u2022';

t('hq.js maskers = the database maskers (same text for the same value)', () => {
  // the expected strings are what tests/db/r57-hq-auth-0298.sql and APPLY VERIFY 03 expect from _r57_mask_*
  assert.equal(cx.maskEmail('koushik@helm.events'), 'ko' + D.repeat(3) + '@helm.events');
  assert.equal(cx.maskEmail('riya.contact@studio-a.test'), 'ri' + D.repeat(3) + '@studio-a.test');
  assert.equal(cx.maskEmail('a_admin@a.test'), 'a_' + D.repeat(3) + '@a.test');
  assert.equal(cx.maskEmail('abc@x.com'), 'a' + D.repeat(3) + '@x.com');
  assert.equal(cx.maskPhone('+919876543210'), D.repeat(10) + '10');
  assert.equal(cx.maskPhone('+91 98765 43210'), '+91 ' + D.repeat(8) + '10');
  assert.equal(cx.maskId('ABCDE1234F'), 'AB' + D.repeat(6) + '4F');
  assert.equal(cx.maskId('AB12'), D.repeat(4));
  assert.ok(cx.isMasked('ko' + D.repeat(3) + '@x.com') && !cx.isMasked('ko@x.com'));
});

t('hq.js: two-step reset compares a typed address with the masked one, then with the real one (hq_reveal)', () => {
  const shown = 'ko' + D.repeat(3) + '@helm.events';
  assert.ok(cx.sameAddr(shown, 'KOUSHIK@helm.events'));
  assert.ok(!cx.sameAddr(shown, 'kx@helm.events'));
  assert.ok(cx.sameAddr('a@b.co', 'A@B.CO') && !cx.sameAddr('a@b.co', 'c@b.co'));
  const r = fnSrc(J, 'resetMfa');
  assert.match(r, /revealValue\(rec\[0\], rec\[1\], "email", email\)/);
  assert.match(r, /call\("hq_mfa_reset", \{ p_email: isMasked\(email\) \? again : email, p_reason: why \}\)/);
  assert.match(J, /mfaCell\(r\.email, r\.mfa_enabled, function \(\) \{ loadUsers\(uOff\)\.catch\(showErr\); \}, r\.user_id \? \["person", r\.user_id\] : null\)/);
});

t('hq.js: Show / Reply / business details use hq_reveal; a masked address never becomes a mailto link', () => {
  const rv = fnSrc(J, 'revealValue');
  assert.match(rv, /call\("hq_reveal"/);
  assert.match(fnSrc(J, 'masked'), /var hid = isMasked\(v\) \? v : \(MASKERS\[kind\] \|\| maskId\)\(v\);/);
  assert.match(fnSrc(J, 'mailtoHref'), /if \(e\.indexOf\("\\u2022"\) >= 0\) return null;/);
  assert.match(fnSrc(J, 'replyTo'), /isMasked\(e\) \? \{ email: e, subject: subject, name: name \} : mailtoHref\(e, subject, name\)/);
  assert.match(fnSrc(J, 'detailBox'), /revealValue\(rec \? rec\[0\] : "", rec \? rec\[1\] : null, "reply_email", reply\.email\)/);
  for (const s of ['replyTo(x.contact_email, "Your Helm plan request", x.contact_name)', 'replyTo(x.email, "Helm — your enquiry", x.name)',
                   'replyTo(x.email, "Thanks for your Helm suggestion", x.who)']) assert.ok(J.includes(s), s);
  // the edit form is filled from the real account and compared against it (never saves masked text back)
  assert.match(J, /p_field: "business_details" \}\)\.then\(function \(r\) \{\s*real = /);
  assert.match(J, /if \(v !== \(real\[f\[0\]\] == null \? "" : String\(real\[f\[0\]\]\)\)\) patch\[f\[0\]\] = v;/);
  assert.match(J, /Object\.keys\(real\)\.some\(function \(k\) \{ return isMasked\(real\[k\]\); \}\)/);
  assert.doesNotMatch(J, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

t('hq-referrals.js: partner codes are edited / created with billing.write only (G-HQ-2)', () => {
  assert.match(REF, /mayEdit = can\("billing\.write"\);/);
  assert.match(REF, /if \(REAL && !can\("billing\.write"\)\) \{ \$\("btnNewCode"\)\.hidden = true;/);
  assert.doesNotMatch(REF, /can\("billing\.write"\) \|\| can\("inbox\.write"\)/);
});

t('store-api: invitations listed with explicit columns; e-mail look-up yes / no; the mail key may come from this tab', () => {
  const a = API.indexOf('const invitations = {'), b = API.indexOf('resendEmail:', a);
  const list = API.slice(a, b).replace(/\/\/[^\n]*/g, '');
  assert.match(list, /\.from\("invitations"\)\.select\("id,org_id,email,role,status,invited_by,expires_at,accepted_at,accepted_by,created_at"\)/);
  assert.doesNotMatch(list, /select\("\*"\)|token|mail_key_hash"\)/);
  assert.doesNotMatch(API, /from\("invitations"\)\.select\("\*"\)/);
  const look = API.slice(API.indexOf('async openForEmail(email, opts)'), API.indexOf('async emailInviteLink(email)'));
  assert.match(look, /return \{ invited: true \};/);
  assert.doesNotMatch(look, /j\.studio|j\.role/);
  assert.match(API, /sessionStorage\.getItem\("bp_pending_invite_k"\)/);
});

t('login.html: the invite token and &k= leave the address bar once read (kept in this tab only)', () => {
  const m = LOGIN.slice(LOGIN.indexOf('(function migrateInvite(){'), LOGIN.indexOf('const pendingInviteK='));
  assert.match(m, /sessionStorage\.setItem\(INVITE_K_KEY, inviteK\)/);
  assert.match(m, /u\.searchParams\.delete\("invite"\); u\.searchParams\.delete\("k"\); history\.replaceState\(/);
  assert.match(LOGIN, /const clearInvite=\(\)=>\{ try\{ sessionStorage\.removeItem\(INVITE_KEY\); sessionStorage\.removeItem\(INVITE_K_KEY\); \}/);
  assert.match(fnSrc(LOGIN, 'inviteReloadUrl'), /if\(!k && typeof pendingInviteK==="function"\) k=pendingInviteK\(\);/);
  // the sign-up page no longer learns the studio / role from the look-up; the card still works without them
  assert.match(fnSrc(LOGIN, 'showInvited'), /"This e-mail has an invitation to join a studio on Helm"/);
});

t('edge: clientIp never trusts the first x-forwarded-for hop; send-phone-code signs in before 503; look-up yes / no', () => {
  const c = LIM.slice(LIM.indexOf('export function clientIp'), LIM.indexOf('\n}\n', LIM.indexOf('export function clientIp')));
  assert.ok(c.indexOf('cf-connecting-ip') < c.indexOf('x-forwarded-for'));
  assert.match(c, /for \(let i = hops\.length - 1; i >= 0; i--\)/);
  assert.doesNotMatch(c, /split\(","\)\[0\]/);
  const i503 = SPC.indexOf('"phone verification is not available yet" }, 503'), iUser = SPC.indexOf('if (!user) return json({ error: "sign in first" }, 401);');
  assert.ok(iUser > 0 && i503 > iUser, 'the 503 comes after the sign-in check');
  assert.match(SPC, /banned_until/);
  assert.match(SPC, /from\("team_member_status"\)/);
  const la = INV.slice(INV.indexOf('export function lookupAnswer'), INV.indexOf('\n}\n', INV.indexOf('export function lookupAnswer')));
  assert.match(la, /return \{ invited: true \};/);
  assert.doesNotMatch(la, /studio|role_label/);
});

t('SQL 0298: registered, APPLY verbatim + VERIFY, ASCII, additive only, STOP guard, re-run safe', () => {
  assert.match(rd('supabase/migrations/MANIFEST'), /^forward  supabase\/migrations\/0298_r57_hq_auth_hardening\.sql$/m);
  assert.match(rd('scripts/db-test/run-all.sh'), /R57-HQ-AUTH-0298: ALL PASS \\\(56\/56\\\)/);
  for (const f of ['test/release-1019.test.mjs', 'test/release-1020.test.mjs']) assert.match(rd(f), /'0298'/, f);
  assert.ok(APPLY.includes('begin;\n' + SQL), 'APPLY carries the migration verbatim inside begin / commit');
  assert.match(APPLY, /\ncommit;\n\n-- VERIFY \(every row must say ok = true\)\n/);
  assert.equal((APPLY.match(/^  \('\d\d /gm) || []).length, 16, '16 VERIFY rows');
  for (const [nm, s] of [['migration', SQL], ['APPLY', APPLY], ['db suite', DBT]]) assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(s), nm + ' is ASCII');
  const code = SQL.replace(/--[^\n]*/g, '');
  assert.doesNotMatch(code, /\b(drop\s+table|drop\s+column|delete\s+from|truncate)\b/i);
  assert.match(code, /STOP 0298:/);
  assert.match(code, /position\('r57-0298' in /);
  assert.match(DBT, /\\ir \.\.\/\.\.\/supabase\/migrations\/0298_r57_hq_auth_hardening\.sql\n\\ir \.\.\/\.\.\/supabase\/migrations\/0298_r57_hq_auth_hardening\.sql/);
  assert.match(DBT, /^rollback;$/m);
});

console.log(process.exitCode ? 'r57-hq-auth: FAILED' : 'r57-hq-auth: ' + n + ' passed');
