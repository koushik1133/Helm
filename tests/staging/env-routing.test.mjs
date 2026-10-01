// =============================================================================
// tests/staging/env-routing.test.mjs
//
// FAIL-CLOSED environment-routing test for public/config.js.
//
// Pure Node (ESM), NO browser, NO credentials, NO network. It loads the REAL
// public/config.js text and executes its host-selection IIFE inside a node:vm
// sandbox with simulated `location.hostname`, `localStorage`, and `window`
// opt-in flags, then inspects the resolved window.SUPABASE_CONFIG.url.
//
// Run:  node tests/staging/env-routing.test.mjs
// Exit: 0 = all assertions pass, 1 = any failure.
//
// It asserts the four contract points, and the hard invariant:
//   * production host            -> PRODUCTION ref
//   * Vercel branch-preview host -> STAGING ref
//   * localhost                  -> fail-closed-unless-explicit-opt-in (never prod)
//   * a PREVIEW host can NEVER resolve to the PRODUCTION ref (any opt-in state)
// =============================================================================
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', '..', 'public', 'config.js');
const SRC = readFileSync(CONFIG_PATH, 'utf8');

const PROD_REF = 'nqltzgiwznphugcfhmbm';
const STAGING_REF = 'xizehqgeyjcfpzrdymly';

// A variant simulating the "staging not yet created" committed state (blank
// SUPABASE_STAGING) so we can exercise the localhost opt-in / fail-closed paths.
const NO_STAGING_SRC = SRC.replace(
  /window\.SUPABASE_STAGING = \{[\s\S]*?\};/,
  'window.SUPABASE_STAGING = { url: "", anonKey: "", hosts: [] };'
);
if (NO_STAGING_SRC === SRC) {
  console.error('FATAL: could not blank SUPABASE_STAGING — config.js shape changed; update this test.');
  process.exit(1);
}

function makeLocalStorage(initial = {}) {
  const store = { ...initial };
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
}

// Execute config.js against a simulated environment and return the resolved config.
function evalConfig({ hostname, localStorage = {}, win = {}, source = SRC }) {
  const w = {
    location: { hostname },
    localStorage: makeLocalStorage(localStorage),
    console: { info() {}, warn() {}, error() {}, log() {} },
    ...win,
  };
  w.window = w; // self-reference so `window.*` and bare globals resolve to the same object
  const sandbox = { window: w, location: w.location, localStorage: w.localStorage, console: w.console };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'config.js' });
  const c = w.SUPABASE_CONFIG || {};
  return {
    url: c.url || '',
    anonKey: c.anonKey || '',
    staging: !!c.__staging,
    localFallback: !!c.__localFallback,
  };
}

// ---- tiny assertion runner -------------------------------------------------
let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok  - ' + name); }
  catch (e) { failed++; console.error('  FAIL- ' + name + '\n        ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
function resolvesToProd(r) { return r.url.includes(PROD_REF); }
function resolvesToStaging(r) { return r.url.includes(STAGING_REF); }
function isBlank(r) { return r.url === ''; }

const OPT_IN_TS = String(Date.now());                 // valid 8h opt-in timestamp
const ALLOW_WIN = { HELM_ALLOW_PROD_FROM_LOCALHOST: true };
const ALLOW_LS = { 'helm.allowProdFromLocalhost': OPT_IN_TS };

console.log('env-routing.test.mjs — fail-closed host->project routing\n');

// 1) PRODUCTION hosts -> PRODUCTION ref
for (const host of ['helm-v01.vercel.app', 'www.helm.events', 'helm.events', 'helm-alpha-nine.vercel.app']) {
  check(`prod host ${host} -> PROD ref`, () => {
    const r = evalConfig({ hostname: host });
    assert(resolvesToProd(r), `expected PROD ref, got "${r.url}"`);
    assert(!r.staging, 'must not be flagged __staging');
  });
}

// 2) VERCEL BRANCH-PREVIEW host -> STAGING ref (never prod)
for (const host of [
  'helm-git-harden-pre-react-canonical-koushik1133.vercel.app',
  'helm-abc123xyz-koushik1133.vercel.app',
  'helm-staging.vercel.app',
]) {
  check(`preview host ${host} -> STAGING ref`, () => {
    const r = evalConfig({ hostname: host });
    assert(resolvesToStaging(r), `expected STAGING ref, got "${r.url}"`);
    assert(!resolvesToProd(r), 'preview must NEVER resolve to PROD ref');
    assert(r.staging, 'must be flagged __staging');
  });
}

// 3) HARD INVARIANT: a preview host can NEVER resolve to PROD, under ANY opt-in
//    state, and with or without a staging project configured.
const previewHost = 'helm-git-harden-pre-react-canonical-koushik1133.vercel.app';
check('preview host + window opt-in -> still never PROD', () => {
  const r = evalConfig({ hostname: previewHost, win: ALLOW_WIN });
  assert(!resolvesToProd(r), 'preview+opt-in must not reach PROD');
  assert(resolvesToStaging(r), 'preview+opt-in should still select STAGING');
});
check('preview host + localStorage opt-in -> still never PROD', () => {
  const r = evalConfig({ hostname: previewHost, localStorage: ALLOW_LS });
  assert(!resolvesToProd(r), 'preview+opt-in must not reach PROD');
});
check('preview host with NO staging configured -> FAIL CLOSED (never PROD)', () => {
  const r = evalConfig({ hostname: previewHost, win: ALLOW_WIN, localStorage: ALLOW_LS, source: NO_STAGING_SRC });
  assert(isBlank(r), `expected blank fail-closed creds, got "${r.url}"`);
  assert(!resolvesToProd(r), 'preview must never fall back to PROD, even with no staging');
  assert(r.localFallback, 'must be flagged __localFallback (fail-closed)');
});

// 4) LOCALHOST -> fail-closed-unless-opt-in; never silently PROD.
check('localhost (staging committed) -> STAGING, never PROD', () => {
  const r = evalConfig({ hostname: 'localhost' });
  assert(!resolvesToProd(r), 'localhost must not silently use PROD');
  assert(resolvesToStaging(r), 'localhost should prefer STAGING when configured');
});
check('localhost, NO staging, NO opt-in -> FAIL CLOSED (blank, never PROD)', () => {
  const r = evalConfig({ hostname: 'localhost', source: NO_STAGING_SRC });
  assert(isBlank(r), `expected blank fail-closed creds, got "${r.url}"`);
  assert(!resolvesToProd(r), 'must not reach PROD without opt-in');
  assert(r.localFallback, 'must be flagged __localFallback');
});
check('localhost, NO staging, WITH window opt-in -> PROD (opt-in preserved)', () => {
  const r = evalConfig({ hostname: 'localhost', win: ALLOW_WIN, source: NO_STAGING_SRC });
  assert(resolvesToProd(r), 'explicit localhost opt-in should reach PROD');
});
check('localhost, NO staging, WITH localStorage opt-in -> PROD (opt-in preserved)', () => {
  const r = evalConfig({ hostname: 'localhost', localStorage: ALLOW_LS, source: NO_STAGING_SRC });
  assert(resolvesToProd(r), 'explicit localStorage opt-in should reach PROD');
});
check('localhost, NO staging, STALE/legacy opt-in "1" -> FAIL CLOSED (never PROD)', () => {
  const r = evalConfig({ hostname: 'localhost', localStorage: { 'helm.allowProdFromLocalhost': '1' }, source: NO_STAGING_SRC });
  assert(!resolvesToProd(r), 'legacy "1" opt-in must be treated as expired');
  assert(isBlank(r), 'stale opt-in must fail closed');
});

// 5) UNKNOWN host -> FAIL CLOSED (never PROD), even with opt-in flags set.
check('unknown host -> FAIL CLOSED (never PROD)', () => {
  const r = evalConfig({ hostname: 'evil.example.com' });
  assert(isBlank(r), `expected blank, got "${r.url}"`);
  assert(!resolvesToProd(r), 'unknown host must never reach PROD');
});
check('unknown host + opt-in flags -> STILL FAIL CLOSED (never PROD)', () => {
  const r = evalConfig({ hostname: 'evil.example.com', win: ALLOW_WIN, localStorage: ALLOW_LS });
  assert(!resolvesToProd(r), 'opt-in must not open PROD on a non-local host');
  assert(isBlank(r), 'unknown host must fail closed regardless of opt-in');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
