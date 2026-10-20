#!/usr/bin/env node
/* r26-custom-domain.test.mjs — own API address (Supabase custom domain api.helm.events).
 * 1. Default (switch off) = the app keeps talking to https://<ref>.supabase.co (no behaviour change).
 * 2. Switch on = https://api.helm.events; any other customUrl is ignored (safe fallback).
 * 3. Browser try-out key works only on the production hosts.
 * 4. Sessions keep the same browser key on both addresses (nobody is signed out by the switch).
 * 5. Every production CSP that allows the project also allows api.helm.events (https + wss);
 *    the staging-site CSP never does. server.js (local dev) allows it too.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const CONFIG = read('public/config.js');
const STAGING = read('public/config.staging.js');
const PROJECT = 'https://nqltzgiwznphugcfhmbm.supabase.co';
const CUSTOM = 'https://api.helm.events';
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };

function run({ host = 'www.helm.events', pre = {}, store = {} } = {}) {
  const window = Object.assign({}, pre);
  const ls = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = v) };
  // no DOM (Node) → config.js routes immediately; staging file first, like the browser on non-prod hosts
  new Function('window', 'location', 'localStorage', 'console', STAGING + '\n' + CONFIG)(
    window, { hostname: host }, ls, { info() {}, warn() {}, error() {}, log() {} });
  return window.SUPABASE_CONFIG;
}

t('committed default: switch is OFF and the project address is unchanged', () => {
  assert.match(CONFIG, /useCustomDomain:\s*false/);
  assert.match(CONFIG, /url:\s*"https:\/\/nqltzgiwznphugcfhmbm\.supabase\.co"/);   // gen-csp reads PROD_REF from this line
  const c = run();
  assert.equal(c.url, PROJECT);
  assert.equal(c.projectUrl, PROJECT);
  assert.equal(c.authStorageKey, 'sb-nqltzgiwznphugcfhmbm-auth-token');
});

t('switch ON → production uses https://api.helm.events', () => {
  assert.equal(run({ pre: { HELM_API_DOMAIN: { useCustomDomain: true } } }).url, CUSTOM);
  assert.equal(run({ host: 'helm.events', pre: { HELM_API_DOMAIN: { useCustomDomain: true } } }).url, CUSTOM);
});

t('switch ON with any other address is ignored (stays on supabase.co)', () => {
  for (const u of ['https://evil.example', 'http://api.helm.events', 'https://api.helm.events/', 'https://x.helm.events', '']) {
    assert.equal(run({ pre: { HELM_API_DOMAIN: { useCustomDomain: true, customUrl: u } } }).url, PROJECT, u);
  }
  assert.equal(run({ pre: { HELM_API_DOMAIN: { useCustomDomain: 'yes' } } }).url, PROJECT);
});

t('browser try-out key works only on helm.events / www.helm.events', () => {
  assert.equal(run({ store: { 'helm.apiDomain': 'custom' } }).url, CUSTOM);
  assert.equal(run({ store: { 'helm.apiDomain': 'other' } }).url, PROJECT);
  // staging site / random host never reach production (or its custom address) through the key
  const stg = run({ host: 'helm-v01.vercel.app', store: { 'helm.apiDomain': 'custom' } });
  assert.notEqual(stg.url, CUSTOM); assert.notEqual(stg.url, PROJECT);
  const rnd = run({ host: 'evil.example', store: { 'helm.apiDomain': 'custom' } });
  assert.equal(rnd.url, '');
});

t('store-api keeps the session key on the custom address only, and preconnects to it', () => {
  const s = read('public/store-api.js');
  assert.match(s, /CFG\.authStorageKey && CFG\.url && !\/\\\.supabase\\\.co\\\/\?\$\/\.test\(CFG\.url\) && \/\^sb-\[a-z0-9\]\{20\}-auth-token\$\/\.test\(CFG\.authStorageKey\)\) \? \{ storageKey: CFG\.authStorageKey \} : \{\}/);
  assert.match(s, /api\\\.helm\\\.events\)\\\/\?\$\/\.test\(CFG\.url\)\) return;/);
  // the signed-in checks still recognise the pinned key
  assert.ok(/^sb-[a-z0-9]+-auth-token$/.test('sb-nqltzgiwznphugcfhmbm-auth-token'));
});

t('sim-pay treats the custom address as the production database', () => {
  assert.match(read('public/sim-pay.html'), /PROD_DB=\/\^https:\\\/\\\/\(nqltzgiwznphugcfhmbm\\\.supabase\\\.co\|api\\\.helm\\\.events\)\\\/\?\$\/i/);
});

function directives(v) {
  const m = new Map();
  for (const d of v.split(';').map((x) => x.trim()).filter(Boolean)) { const [k, ...r] = d.split(/\s+/); m.set(k, r); }
  return m;
}
function checkPolicy(where, v) {
  const d = directives(v);
  for (const [k, toks] of d) {
    if (toks.includes(PROJECT)) assert.ok(toks.includes(CUSTOM), `${where} ${k} allows the project but not ${CUSTOM}`);
    if (toks.includes('wss://nqltzgiwznphugcfhmbm.supabase.co')) assert.ok(toks.includes('wss://api.helm.events'), `${where} ${k} missing wss custom`);
  }
}

t('vercel.json: every production CSP allows both addresses; staging-site rule allows neither', () => {
  const v = JSON.parse(read('vercel.json'));
  let n = 0;
  for (const r of v.headers) for (const h of r.headers || []) {
    if (h.key.toLowerCase() !== 'content-security-policy') continue;
    const staging = r.has && r.has[0] && r.has[0].value === 'helm-v01.vercel.app';
    if (staging) { assert.ok(!h.value.includes('api.helm.events')); continue; }
    checkPolicy('vercel.json ' + r.source, h.value);
    if (directives(h.value).get('connect-src')?.includes(PROJECT)) n++;
  }
  assert.ok(n >= 10, 'expected many production policies, saw ' + n);
});

t('public/_headers: every CSP allows both addresses', () => {
  let n = 0;
  for (const line of read('public/_headers').split('\n')) {
    const m = /^\s+Content-Security-Policy:\s*(.*)$/.exec(line);
    if (m) { checkPolicy('_headers', m[1]); n++; }
  }
  assert.ok(n >= 10);
});

t('server.js (local dev) CSP allows the custom address', () => {
  const s = read('server.js');
  assert.match(s, /\['connect-src', "[^"]*https:\/\/api\.helm\.events[^"]*wss:\/\/api\.helm\.events/);
  assert.match(s, /\['img-src', "[^"]*https:\/\/api\.helm\.events/);
});

t('gen-csp adds the custom host from config (one source of truth)', () => {
  const g = read('scripts/gen-csp.mjs');
  assert.match(g, /CUSTOM_API_HOST/);
  assert.match(g, /withCustomDomain\(withHashes\(h\.value/);
  assert.match(g, /withCustomDomain\(withHashes\(v,/);
});

t('owner steps document exists in the repo docs', () => {
  const d = read('docs/ops/CUSTOM-DOMAIN.md');
  for (const s of ['supabase domains create --project-ref nqltzgiwznphugcfhmbm --custom-hostname api.helm.events',
    'supabase domains reverify --project-ref nqltzgiwznphugcfhmbm', 'supabase domains activate --project-ref nqltzgiwznphugcfhmbm',
    'https://api.helm.events/auth/v1/callback', 'useCustomDomain']) assert.ok(d.includes(s), s);
});

console.log(`\nr26-custom-domain: ${passed} passed`);
