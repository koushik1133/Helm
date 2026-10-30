// r84-otp-once-login.test.mjs - R84 fixes (staging e2e r81):
//  A) 0307: an older unused approval code can no longer approve a quote a second time (wrapper over
//     verify_and_consent; already-approved short-circuit; other open codes expired on success); APPLY-0307 + MANIFEST
//  B) login.html: a click on Sign in before the page script attaches never does a native submit (early external guard)
//  C) store-api.js org.current(): no studio id -> null, never organizations?id=eq.null
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(root + p, 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);

const MIG = read('supabase/migrations/0307_r84_otp_single_use.sql');
const APPLY = read('supabase/APPLY-0307.sql');
t('A1 0307 migration: ASCII, keeps __pre0307 once, wrapper with empty search_path + marker', () => {
  assert.ok(!/[^\x00-\x7F]/.test(MIG), 'ASCII only');
  assert.match(MIG, /if to_regprocedure\('public\.verify_and_consent__pre0307\([^)]*\)'\) is null then\n\s+alter function public\.verify_and_consent\([^)]*\) rename to verify_and_consent__pre0307;\n\s+create function public\.verify_and_consent\(/);
  assert.match(MIG, /returns jsonb language sql volatile security definer set search_path = ''\n\s+as 'select public\._r307_verify\(/);
  assert.match(MIG, /create or replace function public\._r307_verify\([\s\S]*?security definer set search_path = '' as/);
  assert.ok(!/create\s+or\s+replace\s+function\s+public\.verify_and_consent\s*\(/i.test(MIG), 'never CREATE OR REPLACE over a later wrapper');
  assert.match(MIG, /r84-otp-once-0307/);
  assert.match(MIG, /revoke all on function public\.verify_and_consent__pre0307\([^)]*\) from public;/);
  assert.match(MIG, /grant execute on function public\.verify_and_consent\([^)]*\) to %I/);
  assert.match(MIG, /revoke all on function public\._r307_verify\([^)]*\) from %I/);
  assert.ok(!/\b(drop|truncate|delete)\b/i.test(MIG.replace(/^--.*$/gm, '')), 'no drop / truncate / delete');
});
t('A2 0307 logic: already approved (not stale) -> no second consent; success -> expire other open codes', () => {
  assert.match(MIG, /for update;/);
  assert.match(MIG, /v_status in \('approved', 'paid'\) and not v_stale then\n\s+perform public\._a42_expire_open_otps\(v_q\);[\s\S]*?'already_approved', true/);
  assert.match(MIG, /coalesce\(\(v_out ->> 'approved'\)::boolean, false\) then\n\s+perform public\._a42_expire_open_otps\(v_q\);/);
  // the approval page treats approved === true as the approved step
  assert.match(read('public/approve.html'), /r && r\.approved === true/);
});
t('A3 APPLY-0307: begin / migration verbatim / commit / VERIFY rows; MANIFEST + db suite wired', () => {
  assert.ok(!/[^\x00-\x7F]/.test(APPLY), 'ASCII only');
  assert.ok(APPLY.includes('begin;\n' + MIG + 'commit;\n'), 'migration verbatim between begin / commit');
  assert.match(APPLY, /STOP 0307/);
  assert.equal((APPLY.match(/^  \('0\d /gm) || []).length, 4);
  assert.match(read('supabase/migrations/MANIFEST'), /^forward  supabase\/migrations\/0307_r84_otp_single_use\.sql$/m);
  assert.match(read('scripts/db-test/run-all.sh'), /tests\/db\/r84-otp-single-use-0307\.sql/);
});

const GUARD = read('public/login-submit-guard.js');
const LOGIN = read('public/login.html');
t('B1 login.html loads the external guard in <head> (no inline script added)', () => {
  const g = LOGIN.indexOf('<script src="/login-submit-guard.js?v='), body = LOGIN.indexOf('<body');
  assert.ok(g > 0 && g < body, 'guard runs in <head>');
  assert.ok(!/ defer|async/.test(LOGIN.slice(g, LOGIN.indexOf('</script>', g))), 'guard is a normal (blocking) script');
});
function harness() {
  const L = {}; const timers = [];
  const doc = { addEventListener: (type, fn, cap) => { (L[type] = L[type] || []).push(fn); } };
  const win = {};
  vm.runInNewContext(GUARD, { document: doc, window: win, setTimeout: (f) => timers.push(f) });
  const fire = (type, ev) => (L[type] || []).forEach((f) => f(ev));
  return { L, timers, win, fire };
}
t('B2 guard: a submit before ready is prevented + stopped, then replayed once after DOMContentLoaded', () => {
  const h = harness(); let prevented = 0, stopped = 0, replays = 0;
  const form = { isConnected: true, hidden: false, requestSubmit: (s) => { replays++; assert.equal(s, btn); } };
  const btn = { form };
  h.fire('submit', { target: form, submitter: btn, preventDefault: () => prevented++, stopImmediatePropagation: () => stopped++ });
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  h.fire('DOMContentLoaded', {}); assert.equal(replays, 0, 'replay waits a tick for the page handlers');
  h.timers.forEach((f) => f());
  assert.equal(replays, 1); assert.equal(h.win.HelmLoginSubmitReady, true);
  h.fire('submit', { target: form, preventDefault: () => prevented++, stopImmediatePropagation: () => stopped++ });
  assert.equal(prevented, 1, 'after ready the page handler owns submit');
});
t('B3 guard: no pending submit -> nothing replayed; hidden form not replayed', () => {
  const h = harness(); h.fire('DOMContentLoaded', {}); h.timers.forEach((f) => f()); assert.equal(h.win.HelmLoginSubmitReady, true);
  const h2 = harness(); let n = 0; const f = { isConnected: true, hidden: true, requestSubmit: () => n++ };
  h2.fire('submit', { target: f, preventDefault() {}, stopImmediatePropagation() {} });
  h2.fire('DOMContentLoaded', {}); h2.timers.forEach((x) => x()); assert.equal(n, 0);
});

t('C1 store-api org.current(): returns null when there is no studio id (no id=eq.null query)', () => {
  const S = read('public/store-api.js');
  assert.match(S, /async current\(opts\) \{ if \(!supa\) return null;\n\s+const oid = await this\.id\(\);\n\s+if \(!oid\) return null;/);
});

let fail = 0;
for (const [n, f] of tests) { try { f(); console.log('  ok  ' + n); } catch (e) { fail++; console.log('  FAIL ' + n + '\n    ' + e.message); } }
console.log(fail ? `R84: ${fail} FAILED` : `R84: ALL PASS (${tests.length}/${tests.length})`);
if (fail) process.exit(1);
