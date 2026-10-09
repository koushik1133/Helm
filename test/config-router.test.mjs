#!/usr/bin/env node
/* config-router.test.mjs — hostname → Supabase routing regression (READ-ONLY).
 * Proves public/config.js uses EXPLICIT allowlists and fails closed on unknown
 * hosts, and that staging can never fall back to production.
 *
 * Invariants:
 *   1. known production hosts → PROD
 *   2. known (allow-listed) staging host → STAGING
 *   3. localhost → STAGING (creds) or DISABLED (default)
 *   4. random public hostname → DISABLED
 *   5. hostname merely containing "staging" but NOT allow-listed → DISABLED
 *   6. staging host cannot be forced to production via the local prod opt-in
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Staging config now lives in public/config.staging.js (loaded only on non-prod
// hosts). Evaluating it BEFORE config.js reproduces the browser order: when
// SUPABASE_STAGING is already defined, config.js routes immediately.
const CONFIG_SRC = readFileSync(join(ROOT, 'public', 'config.js'), 'utf8');
const STAGING_SRC = readFileSync(join(ROOT, 'public', 'config.staging.js'), 'utf8');
const SRC = STAGING_SRC + '\n' + CONFIG_SRC;
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };

const STG = { url: 'https://stgref123.supabase.co', anonKey: 'stgkey' };
const HOSTS = ['helm-staging.vercel.app'];

// Evaluate config.js under a simulated browser env. To simulate the FINAL committed
// state (staging block filled + host allow-listed) we substitute those literals,
// exactly mirroring what filling window.SUPABASE_STAGING would produce.
function run({ host, withStaging, allow }) {
  let src = SRC;
  if (withStaging) {
    // Simulate the committed staging block being filled + a host allow-listed.
    // (The block may already be filled in the committed file; these replaces are
    // idempotent — they normalise it to the test's known STG/HOSTS values.)
    src = src
      .replace(/hosts:\s*\[[^\]]*\]/, 'hosts: ' + JSON.stringify(HOSTS))
      .replace(/(window\.SUPABASE_STAGING\s*=\s*\{[\s\S]*?url:\s*")[^"]*(")/, '$1' + STG.url + '$2')
      .replace(/(window\.SUPABASE_STAGING\s*=\s*\{[\s\S]*?anonKey:\s*")[^"]*(")/, '$1' + STG.anonKey + '$2');
  } else {
    // Simulate NO staging configured, regardless of whether the committed block
    // currently holds real staging values — blank the staging url+anonKey so we
    // genuinely exercise the fail-closed default path.
    src = src
      .replace(/(window\.SUPABASE_STAGING\s*=\s*\{[\s\S]*?url:\s*")[^"]*(")/, '$1$2')
      .replace(/(window\.SUPABASE_STAGING\s*=\s*\{[\s\S]*?anonKey:\s*")[^"]*(")/, '$1$2');
  }
  const store = {}; if (allow) store['helm.allowProdFromLocalhost'] = '1';
  const window = {};
  const sandbox = {
    window, location: { hostname: host },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = v) },
    console: { info() {}, warn() {}, error() {} },
  };
  new Function('window', 'location', 'localStorage', 'console', src)(
    sandbox.window, sandbox.location, sandbox.localStorage, sandbox.console);
  const c = window.SUPABASE_CONFIG;
  return c.__staging ? 'STAGING' : (c.url ? 'PROD' : 'DISABLED');
}

t('1. production hosts → PROD', () => {
  for (const host of ['www.helm.events', 'helm.events', 'helm-alpha-nine.vercel.app']) {
    assert.equal(run({ host }), 'PROD', host);
  }
});
t('2. allow-listed staging host → STAGING', () =>
  assert.equal(run({ host: 'helm-staging.vercel.app', withStaging: true }), 'STAGING'));
t('3a. localhost with staging creds → STAGING', () =>
  assert.equal(run({ host: 'localhost', withStaging: true }), 'STAGING'));
t('3b. localhost default (no staging) → DISABLED', () =>
  assert.equal(run({ host: 'localhost' }), 'DISABLED'));
t('4. random public hostname → DISABLED', () =>
  assert.equal(run({ host: 'app.random-example.com', withStaging: true }), 'DISABLED'));
t('5. non-allow-listed "staging" host → DISABLED', () =>
  assert.equal(run({ host: 'staging.evil.com', withStaging: true }), 'DISABLED'));
t('6. staging host + prod opt-in → STAGING (never PROD)', () =>
  assert.equal(run({ host: 'helm-staging.vercel.app', withStaging: true, allow: true }), 'STAGING'));
t('2b. Vercel branch-preview alias (NOT allow-listed) → STAGING, never PROD', () => {
  // This is the exact hostname shape an auto-generated preview produces
  // (helm-<branch|hash>-<scope>.vercel.app). It is NOT in STAGING_HOSTS, so it
  // exercises config.js step 2b: any *.vercel.app that is not a prod alias must
  // resolve to STAGING when configured, else FAIL CLOSED — never production.
  assert.equal(run({ host: 'helm-staging-abc123-koushik1133.vercel.app', withStaging: true }), 'STAGING');
  assert.equal(run({ host: 'helm-staging-abc123-koushik1133.vercel.app' }), 'DISABLED'); // no staging → blank, not PROD
});
t('7. production host never resolves to STAGING even when staging IS configured', () => {
  for (const host of ['www.helm.events', 'helm.events', 'helm-alpha-nine.vercel.app']) {
    assert.equal(run({ host, withStaging: true }), 'PROD', host);
  }
});
t('11. helm-v01.vercel.app is the STAGING site: staging when configured, fail-closed otherwise, never PROD', () => {
  assert.equal(run({ host: 'helm-v01.vercel.app', withStaging: true }), 'STAGING');
  assert.equal(run({ host: 'helm-v01.vercel.app', withStaging: true, allow: true }), 'STAGING');
  assert.equal(run({ host: 'helm-v01.vercel.app' }), 'DISABLED');
  const r = browserLoad('helm-v01.vercel.app');
  assert.equal(r.writes.length, 1, 'helm-v01 must load config.staging.js');
  assert.equal(r.before.url, '', 'blank before staging loads');
  assert.ok(r.after.__staging && /xizehqgeyjcfpzrdymly/.test(r.after.url) && !/nqltzgiwznphugcfhmbm/.test(r.after.url));
  assert.match(STAGING_SRC, /hosts:\s*\["helm-v01\.vercel\.app"\]/);
});
t('router uses explicit allowlists, not broad substring match', () => {
  assert.ok(/PROD_HOSTS/.test(SRC) && /STAGING_HOSTS/.test(SRC), 'explicit allowlists present');
  assert.ok(!/\/staging\/\.test\(h\)/.test(SRC), 'no broad /staging/.test(h) substring rule');
});

// ---- browser load order: config.js alone, then (non-prod only) config.staging.js ----
function browserLoad(host, { stagingLoads = true, store = {} } = {}) {
  const writes = [];
  const window = {};
  const document = { readyState: 'loading', title: 'Helm', write: (h) => writes.push(h),
    documentElement: { setAttribute() {} }, addEventListener() {}, getElementById: () => null, body: null };
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = v), removeItem: (k) => delete store[k] };
  const con = { info() {}, warn() {}, error() {} };
  const exec = (src) => new Function('window', 'location', 'localStorage', 'console', 'document', src)(window, { hostname: host }, ls, con, document);
  exec(CONFIG_SRC);
  const before = { ...window.SUPABASE_CONFIG };
  if (writes.length && stagingLoads) exec(STAGING_SRC);
  return { writes, before, after: window.SUPABASE_CONFIG };
}
t('8. config.js itself carries NO staging project URL/key (prod bundle is clean)', () => {
  assert.ok(!/xizehqgeyjcfpzrdymly/.test(CONFIG_SRC), 'staging ref in config.js');
  assert.ok(!/window\.SUPABASE_STAGING\s*=/.test(CONFIG_SRC), 'SUPABASE_STAGING defined in config.js');
});
t('9. production hosts never request config.staging.js and keep prod creds', () => {
  for (const host of ['www.helm.events', 'helm.events', 'helm-alpha-nine.vercel.app']) {
    const r = browserLoad(host);
    assert.equal(r.writes.length, 0, host + ' requested staging config');
    assert.ok(/nqltzgiwznphugcfhmbm/.test(r.after.url), host);
    assert.ok(!r.after.__staging, host);
  }
});
t('10. localhost / preview load config.staging.js and are BLANK until it runs → STAGING', () => {
  for (const host of ['localhost', 'helm-git-x-team.vercel.app']) {
    const r = browserLoad(host);
    assert.equal(r.writes.length, 1, host);
    assert.match(r.writes[0], /<script src="\/config\.staging\.js\?v=[^"]+"><\/script>/);
    assert.equal(r.before.url, '', host + ' must be blank before staging loads');
    assert.ok(r.after.__staging && /xizehqgeyjcfpzrdymly/.test(r.after.url), host);
  }
});
t('11. staging file fails to load → stays fail-closed (never prod), even with the localhost opt-in', () => {
  const r = browserLoad('localhost', { stagingLoads: false, store: { 'helm.allowProdFromLocalhost': String(Date.now()) } });
  assert.equal(r.after.url, ''); assert.equal(r.after.anonKey, ''); assert.ok(r.after.__localFallback);
});

console.log(`\nconfig-router: ${passed} assertion(s) passed.`);
