// fix/invite-add-user: Add-user error text, forced first-login reset without the temp
// password box, direct invite sign-up bound to the invited e-mail, staff "record vs invite".
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const fn = r('supabase/functions/invite-signup/index.ts');
const login = r('public/login.html'), api = r('public/store-api.js'), control = r('public/control.html'), staff = r('public/staff.html');
const reset = r('public/reset-password.js');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
// edge function: server-side binding to the invited e-mail, pending + unexpired, confirmed account
ok(/bound !== email/.test(fn) && /email_mismatch/.test(fn), 'typed e-mail must equal the invited e-mail');
ok(/inv\.status !== "pending"/.test(fn) && /expires_at/.test(fn), 'pending + unexpired only');
ok(/email_confirm: true/.test(fn), 'account created confirmed');
ok(/if \(!bound\) return json\(\{ fallback: true \}\)/.test(fn), 'no bound e-mail -> confirm-by-e-mail fallback');
ok(/checkLimits\(/.test(fn) && /readJsonCapped\(/.test(fn) && /responders\(req\)/.test(fn), 'rate-limited, body-capped, CORS allowlist');
ok(!/console\.(log|error)\([^)]*(email|password|token)\b/.test(fn), 'no PII in logs');
// client
ok(/signupDirect\(token, email, password, fullName\)/.test(api) && /return \{ fallback: true \}/.test(api), 'store-api helper with fallback');
ok(/BPStore\.invitations\.signupDirect\(inviteTok0, email, pw, fullName\)/.test(login), 'login uses direct sign-up for invites');
ok(/function forcePasswordChange\(justSignedPw\)/.test(login) && /showCur\(!known\)/.test(login), 'forced reset hides temp password when just signed in');
ok(/known=null; showCur\(true\)/.test(login), 'falls back to asking when the remembered password is refused');
ok(/set_cur_pw/.test(reset), 'profile change-password still asks for the current password');
ok(/function addUserErr\(err\)/.test(control) && /send them an invitation instead/.test(control), 'add-user errors explained');
ok(/name="s_access" value="record"/.test(staff) && /name="s_access" value="invite"/.test(staff) && /wantInvite && added/.test(staff), 'staff: record-only vs invite');
console.log('invite-direct-signup: ' + n + ' checks passed');
