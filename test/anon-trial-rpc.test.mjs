// anon-trial-rpc.test.mjs - production logs showed "42501 permission denied for function my_trial_status" and
// "... my_trial_org" in pairs: signed-out pages (login, public pages) asked the trial RPCs, which are granted to
// authenticated only (0180 / 0183 / 0204). store-api.js now answers "not a trial" (null) without calling them
// when there is no signed-in session; a signed-in page still asks the server exactly as before.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const SRC = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);
const fnSrc = (head) => {
  const at = SRC.indexOf(head); assert.ok(at >= 0, head + ' not found');
  let depth = 0, i = SRC.indexOf('{', at);
  for (; i < SRC.length; i++) { if (SRC[i] === '{') depth++; else if (SRC[i] === '}' && --depth === 0) break; }
  return SRC.slice(at, i + 1);
};
const TRIAL_LINE = (() => { const m = /^ {6}trial: \(\) => .*$/m.exec(SRC); assert.ok(m, 'subscription.trial not found'); return m[0].trim().replace(/,$/, ''); })();

// a sandbox with the real trialSignedIn + trialOrgStatus + subscription.trial and stubbed helpers
function sandbox({ user = null, session = null } = {}) {
  const calls = [];
  const ctx = {
    calls, currentUser: user, trialOrgInflight: null,
    supa: { auth: { getSession: async () => ({ data: { session } }) } },
    rpc: async (fn) => { calls.push(fn); return fn === 'my_trial_status' ? { status: 'trial' } : { is_trial_org: true }; },
    rpcMissing: () => false,
    memoRead: (k, ms, f) => f(), swr: (k, f) => f(),
  };
  vm.createContext(ctx);
  vm.runInContext(fnSrc('async function trialSignedIn()') + '\n' + fnSrc('function trialOrgStatus()') + '\nvar sub = { ' + TRIAL_LINE + ' };', ctx);
  return ctx;
}

t('signed out: trialOrg + subscription.trial answer null and never call my_trial_org / my_trial_status', async () => {
  const c = sandbox();
  assert.equal(await vm.runInContext('trialOrgStatus()', c), null);
  assert.equal(await vm.runInContext('sub.trial()', c), null);
  assert.deepEqual(c.calls, []);
});
t('signed in (session restored, currentUser not set yet): both RPCs are still asked', async () => {
  const c = sandbox({ session: { access_token: 'x' } });
  assert.deepEqual(await vm.runInContext('trialOrgStatus()', c), { is_trial_org: true });
  assert.deepEqual(await vm.runInContext('sub.trial()', c), { status: 'trial' });
  assert.deepEqual(c.calls, ['my_trial_org', 'my_trial_status']);
});
t('signed in (currentUser known): asks without reading the session', async () => {
  const c = sandbox({ user: { id: 'u' } });
  c.supa.auth.getSession = async () => { throw new Error('must not be read'); };
  assert.deepEqual(await vm.runInContext('sub.trial()', c), { status: 'trial' });
  assert.deepEqual(c.calls, ['my_trial_status']);
});
t('a session read that fails counts as signed out (no RPC)', async () => {
  const c = sandbox();
  c.supa.auth.getSession = async () => { throw new Error('storage blocked'); };
  assert.equal(await vm.runInContext('sub.trial()', c), null);
  assert.deepEqual(c.calls, []);
});
t('inFreeTrial keeps its signed-in guard; no other direct my_trial_status / my_trial_org call', () => {
  assert.match(fnSrc('function inFreeTrial()'), /if \(mode !== "supabase" \|\| !supa \|\| !currentUser\) return Promise\.resolve\(false\);/);
  const direct = [...SRC.matchAll(/rpc\("my_trial_(status|org)"/g)].length;
  assert.equal(direct, 3, 'expected exactly the 3 guarded call sites (trialOrgStatus, inFreeTrial, subscription.trial)');
});

let pass = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('  ok  ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
console.log(`ANON-TRIAL-RPC: ${pass === tests.length ? 'ALL PASS' : 'FAILURES'} (${pass}/${tests.length})`);
if (pass !== tests.length) process.exit(1);
