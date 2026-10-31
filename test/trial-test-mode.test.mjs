// 0128 trial test mode: static checks (no database).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const mig = r('supabase/migrations/0128_trial_test_mode.sql');
const apply = r('supabase/APPLY-0128.sql');
const verify = r('supabase/VERIFY-0128.sql');
const page = r('public/approve.html');
const api = r('public/store-api.js');
const code = mig.replace(/--[^\n]*/g, ' ');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

ok(/create or replace function public\.trial_test_approve\(/.test(code), 'trial_test_approve defined');
ok(/security definer/.test(code), 'security definer');
ok(/if not public\._trial_test_mode_ok\(v_org\)/.test(code), 'server re-checks the active trial');
ok(/trial_ends_at > now\(\)/.test(code) && /_trial_locked\(p_org\)/.test(code) && /status = 'active'/.test(code), 'active, unlocked, unpaid trial only');
ok(/public\.verify_and_consent\(p_token, v_phone, v_code, true/.test(code), 'reuses the real consent path');
ok(!/_notify\(/.test(code), 'no SMS / email queued');
ok(/gen_random_bytes/.test(code) && !/'[0-9]{4,}'/.test(code), 'no fixed PIN');
ok(/'approval\.trial_test_skip'/.test(code), 'audit labelled trial test');
ok(/revoke all on function public\._trial_test_mode_ok\(uuid\) from public, anon, authenticated/.test(code), 'helper private');
ok(!/\b(drop\s+(table|function|trigger)|delete\s+from|truncate|alter\s+table)\b/i.test(code), 'additive only');
ok(!/create or replace function public\.(verify_and_consent|request_otp|otp_send_authorize)\(/.test(code), 'OTP functions untouched');
ok(/^-- APPLY 0128/.test(apply) && /\nbegin;/.test(apply) && /\ncommit;/.test(apply) && apply.includes(mig.trim().slice(0, 200)), 'APPLY wraps migration');
ok(/^-- VERIFY 0128/.test(verify) && !/\b(insert|update|delete)\b/i.test(verify.replace(/'[^']*'/g, '')), 'VERIFY read-only');
ok(/^[\x00-\x7F]*$/.test(mig), 'migration ASCII');
ok(/rpc\("trial_test_approve"/.test(api) && /rpc\("trial_test_mode_for_token"/.test(api), 'store-api wired');
ok(/id="trialSkip" hidden/.test(page), 'skip hidden by default');
// R113 (0322): test mode shows only on an explicit server answer (public_trial_approval_mode test_mode true, or the 0128
// boolean true before 0322) - HelmApproveTestMode.spec() returns null otherwise; the approval needs the test code 000000
ok(/const tm=HelmApproveTestMode\.spec\(m\); if\(!tm\) return;/.test(page), 'shown only on explicit server true');
ok(/trialTestApproveCode\(/.test(page) && /r && r\.approved === true/.test(page), 'fail-closed approve');
ok(!/id="trialSkip"[^>]*style=/.test(page), 'no inline style');
console.log(`trial-test-mode: ${n} checks passed`);
