// 0053: the sign-in page shows the server lockout message (Supabase password hook) verbatim.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const api = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
const login = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
const m = api.match(/const LOCKOUT_RE = (\/.+\/);/); assert.ok(m, 'LOCKOUT_RE defined');
const re = eval(m[1]);
assert.ok(re.test('Too many attempts. Try again in 15 minutes or reset your password.'));
assert.ok(re.test('Too many attempts. Try again in 1 hour or reset your password.'));
assert.ok(!re.test('Invalid login credentials'));
assert.match(api, /LOCKOUT_RE\.test\(m\)\) \{ const e = new Error\(m\); e\.code = "account_locked"/, 'signIn maps lockout before generic masking');
assert.match(api, /LOCKOUT_RE\.test\(String\(error\.message/, 'reverify keeps the lockout message');
assert.match(login, /err\.code==="account_locked"/, 'login shows account_locked message directly');
const sql = readFileSync(new URL('../supabase/migrations/0053_password_lockout.sql', import.meta.url), 'utf8');
for (const t of ['15 minutes', '1 hour']) assert.ok(sql.includes(`Too many attempts. Try again in ${t} or reset your password.`), 'SQL message matches UI: ' + t);
console.log('password-lockout-ui: ok');
