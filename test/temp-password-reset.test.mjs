// fix/temp-password-reset: the forced first-login "Set your password" box must only ask
// New + Confirm. When the just-typed sign-in password is not in memory (page reloaded /
// reopened, session resumed), the person signs in again instead of typing it into the box.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const login = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
const reset = readFileSync(new URL('../public/reset-password.js', import.meta.url), 'utf8');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const gate = login.slice(login.indexOf('async function finishGate()'), login.indexOf('async function finishGate()') + 900);
ok(/if\(!jp\)\{ await tempPwSignInAgain\(\); return false; \}/.test(gate), 'no remembered password -> sign in again, never the temp box');
ok(gate.indexOf('tempPwSignInAgain') < gate.indexOf('forcePasswordChange(jp)'), 'check happens before the box opens');
ok(/async function tempPwSignInAgain\(\)/.test(login) && /BPStore\.auth\.signOut\(\)/.test(login.slice(login.indexOf('async function tempPwSignInAgain'))), 'half-finished session is ended');
ok(!/sessionStorage\.setItem\([^)]*justPw|localStorage\.setItem\([^)]*justPw/.test(login), 'password never stored');
ok((login.match(/justPw=pw;/g) || []).length >= 2, 'both sign-in paths remember the typed password in memory');
ok(/set_cur_pw/.test(reset), 'profile change-password still asks for the current password');
console.log('temp-password-reset: ' + n + ' checks passed');
