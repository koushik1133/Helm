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
const SRC = readFileSync(join(ROOT, 'public', 'config.js'), 'utf8');
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
    src = src
      .replace('hosts: []', 'hosts: ' + JSON.stringify(HOSTS))
      .replace('url: "",        //', 'url: "' + STG.url + '",//')
      .replace('anonKey: "",    //', 'anonKey: "' + STG.anonKey + '",//');
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
  for (const host of ['www.helm.events', 'helm.events', 'helm-v01.vercel.app', 'helm-alpha-nine.vercel.app']) {
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
t('router uses explicit allowlists, not broad substring match', () => {
  assert.ok(/PROD_HOSTS/.test(SRC) && /STAGING_HOSTS/.test(SRC), 'explicit allowlists present');
  assert.ok(!/\/staging\/\.test\(h\)/.test(SRC), 'no broad /staging/.test(h) substring rule');
});

console.log(`\nconfig-router: ${passed} assertion(s) passed.`);
