#!/usr/bin/env node
// ============================================================================
// tests/staging/a11y-perf.mjs — Helm STAGING accessibility + performance harness
// ----------------------------------------------------------------------------
// PREPARE-ONLY posture: this file is SAFE to `node --check` with no env set.
// It performs NO network I/O on import and refuses to run without PREVIEW_URL.
//
// WHAT IT DOES (only when PREVIEW_URL is set):
//   * Drives the PUBLIC (unauthenticated) route matrix of a deployed preview.
//   * Runs axe-core accessibility checks per route.
//   * Captures per-route console errors, failed network requests (broken
//     assets), and navigation/web-vitals timings (LCP / FCP / CLS) injected
//     into the page via a PerformanceObserver snippet.
//
// WHAT IT NEVER DOES:
//   * No authenticated or write/mutating flows. Public routes only, for now.
//   * No reads/writes against Supabase. No secrets. No tokens. No .env reads.
//   * Routes that require auth are reported as "auth-required → deferred",
//     never FAIL, never PASS.
//
// axe availability:
//   * Preferred: @axe-core/playwright (a devDependency). If present we use it.
//   * Fallback: if @axe-core/playwright is NOT installed we DO NOT add it;
//     we attempt to inject axe-core from a CDN string at runtime.
//   * If axe cannot be obtained either way, the route's a11y result is BLOCKED
//     (never reported as PASS — a skipped check is not a pass).
//
// USAGE (later, once a staging-wired preview exists):
//   PREVIEW_URL=https://<preview>.vercel.app node tests/staging/a11y-perf.mjs
//
// EXIT CODES:
//   0 = all RUN public routes PASS (deferred/auth routes do not fail the gate)
//   1 = at least one public route FAILED (a11y violations or broken assets)
//   3 = BLOCKED (no PREVIEW_URL, Playwright missing, or axe unavailable) —
//       never reported as PASS.
// ============================================================================

const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_BLOCKED = 3;

// ---- safety: refuse obviously-wrong targets --------------------------------
const STAGING_REF = 'xizehqgeyjcfpzrdymly';
const PROD_REF    = 'nqltzgiwznphugcfhmbm';

// axe-core CDN string used ONLY as a runtime fallback when the dev dep is absent.
const AXE_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.13.0/axe.min.js';

// ----------------------------------------------------------------------------
// Public route matrix. `auth` routes are DEFERRED (reported, never failed)
// until a DB migration + seed + a staging-wired preview exist.
//   path   — the clean URL path requested against PREVIEW_URL
//   file   — the backing static file (documents the crm.html → /crm mapping)
//   auth   — true if the route's real content requires authentication
// ----------------------------------------------------------------------------
export const ROUTES = [
  { path: '/login',     file: 'login.html',     auth: false },
  { path: '/dashboard', file: 'dashboard.html', auth: true  },
  { path: '/crm',       file: 'crm.html',       auth: true  },
  { path: '/quotes',    file: 'quotes.html',    auth: true  },
  { path: '/builder',   file: 'builder.html',   auth: false },
  { path: '/design',    file: 'design.html',    auth: false },
  { path: '/inventory', file: 'inventory.html', auth: true  },
  { path: '/portal',    file: 'portal.html',    auth: false },
];

// ---- performance thresholds (field-approximate; see STAGING-A11Y-PERF-PLAN) --
export const PERF_THRESHOLDS = {
  LCP_MS: 2500,   // Largest Contentful Paint — "good" <= 2.5s
  FCP_MS: 1800,   // First Contentful Paint   — "good" <= 1.8s
  CLS:    0.1,    // Cumulative Layout Shift  — "good" <= 0.10
};

// axe rule categories we care about (tags passed to axe.run / withTags).
export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'];

const NAV_TIMEOUT_MS = 30_000;
const VITALS_SETTLE_MS = 2_500; // let LCP/CLS observers settle after load

class BlockedError extends Error {
  constructor(msg) { super(msg); this.name = 'BlockedError'; this.blocked = true; }
}

// web-vitals-ish snippet injected BEFORE page scripts via addInitScript.
// Uses PerformanceObserver only; no external web-vitals dependency.
function vitalsInitScript() {
  return `(() => {
    window.__vitals = { lcp: null, fcp: null, cls: 0 };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__vitals.lcp = e.startTime;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch (_) {}
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.name === 'first-contentful-paint') window.__vitals.fcp = e.startTime;
        }
      }).observe({ type: 'paint', buffered: true });
    } catch (_) {}
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (!e.hadRecentInput) window.__vitals.cls += e.value;
        }
      }).observe({ type: 'layout-shift', buffered: true });
    } catch (_) {}
  })();`;
}

// Resolve how we obtain axe: prefer the dev dep, else CDN inject, else block.
async function resolveAxeStrategy() {
  try {
    const mod = await import('@axe-core/playwright');
    const AxeBuilder = mod.default || mod.AxeBuilder;
    if (AxeBuilder) return { kind: 'devdep', AxeBuilder };
  } catch (_) { /* not installed — fall through to CDN */ }
  return { kind: 'cdn', url: AXE_CDN };
}

// Run axe for a page using whichever strategy resolved.
async function runAxe(page, strategy) {
  if (strategy.kind === 'devdep') {
    const builder = new strategy.AxeBuilder({ page }).withTags(AXE_TAGS);
    const results = await builder.analyze();
    return { ok: true, violations: results.violations || [] };
  }
  // CDN fallback: inject axe source, then run in-page.
  try {
    await page.addScriptTag({ url: strategy.url });
  } catch (err) {
    return { ok: false, reason: `axe CDN inject failed: ${err.message}` };
  }
  const hasAxe = await page.evaluate(() => typeof window.axe !== 'undefined');
  if (!hasAxe) return { ok: false, reason: 'axe did not load from CDN' };
  const results = await page.evaluate(async (tags) => {
    return await window.axe.run(document, { runOnly: { type: 'tag', values: tags } });
  }, AXE_TAGS);
  return { ok: true, violations: results.violations || [] };
}

function baseUrl() {
  const raw = (process.env.PREVIEW_URL || '').trim();
  if (!raw) throw new BlockedError('PREVIEW_URL is not set — nothing to run against (prepare-only).');
  let u;
  try { u = new URL(raw); } catch { throw new BlockedError(`PREVIEW_URL is not a valid URL: ${raw}`); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new BlockedError(`PREVIEW_URL must be http(s): ${raw}`);
  }
  // Guard: never point this at the known PROD project ref by accident.
  if (u.hostname.includes(PROD_REF)) {
    throw new BlockedError(`PREVIEW_URL resolves to the PROD ref (${PROD_REF}) — refusing.`);
  }
  return u.origin + u.pathname.replace(/\/$/, '');
}

async function auditRoute(browser, strategy, base, route) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  const failedRequests = [];

  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => {
    failedRequests.push({ url: req.url(), method: req.method(), failure: req.failure()?.errorText || 'failed' });
  });
  page.on('response', (res) => {
    const s = res.status();
    if (s >= 400) failedRequests.push({ url: res.url(), status: s });
  });

  await page.addInitScript(vitalsInitScript());

  const url = base + route.path;
  const record = {
    path: route.path, file: route.file, auth: route.auth,
    status: 'PENDING', a11y: null, vitals: null,
    consoleErrors, failedRequests, notes: [],
  };

  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    record.httpStatus = resp ? resp.status() : null;

    // Let LCP/CLS observers settle, then snapshot vitals.
    await page.waitForTimeout(VITALS_SETTLE_MS);
    record.vitals = await page.evaluate(() => window.__vitals || null);

    // axe accessibility pass.
    const axeRes = await runAxe(page, strategy);
    if (!axeRes.ok) {
      record.a11y = { status: 'BLOCKED', reason: axeRes.reason };
      record.notes.push(`a11y BLOCKED: ${axeRes.reason}`);
    } else {
      const violations = axeRes.violations.map((v) => ({
        id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length,
      }));
      record.a11y = { status: violations.length === 0 ? 'PASS' : 'FAIL', violations };
    }

    // Auth-required routes: report but DEFER (never pass/fail the gate).
    if (route.auth) {
      record.status = 'DEFERRED';
      record.notes.push('auth-required → deferred until seed + staging-wired preview');
      return record;
    }

    // Public route verdict: a11y must not be BLOCKED/FAIL, no broken assets.
    const a11yBad = !record.a11y || record.a11y.status !== 'PASS';
    const brokenAssets = failedRequests.length > 0;
    record.status = (!a11yBad && !brokenAssets) ? 'PASS' : 'FAIL';
    if (a11yBad && record.a11y?.status === 'BLOCKED') record.status = 'BLOCKED';
    return record;
  } catch (err) {
    record.status = 'ERROR';
    record.notes.push(`navigation/audit error: ${err.message}`);
    return record;
  } finally {
    await context.close();
  }
}

export async function run() {
  const base = baseUrl();

  let chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch (err) {
    throw new BlockedError(`Playwright not available: ${err.message}`);
  }

  const strategy = await resolveAxeStrategy();
  if (strategy.kind === 'cdn') {
    console.warn('[a11y-perf] @axe-core/playwright not found — falling back to CDN-injected axe-core.');
  }

  const browser = await chromium.launch();
  const records = [];
  try {
    for (const route of ROUTES) {
      console.log(`\n========== ${route.path}  (${route.file})${route.auth ? '  [auth]' : ''} ==========`);
      const rec = await auditRoute(browser, strategy, base, route);
      records.push(rec);
      printRecord(rec);
    }
  } finally {
    await browser.close();
  }

  return summarize(records, strategy);
}

function printRecord(rec) {
  console.log(`  status: ${rec.status}`);
  if (rec.vitals) {
    const v = rec.vitals;
    console.log(`  vitals: LCP=${fmt(v.lcp)}ms FCP=${fmt(v.fcp)}ms CLS=${v.cls?.toFixed?.(3) ?? 'n/a'}`
      + `  (budgets LCP<=${PERF_THRESHOLDS.LCP_MS} FCP<=${PERF_THRESHOLDS.FCP_MS} CLS<=${PERF_THRESHOLDS.CLS})`);
  }
  if (rec.a11y) {
    console.log(`  a11y:   ${rec.a11y.status}` + (rec.a11y.violations ? ` (${rec.a11y.violations.length} rule violations)` : ''));
    for (const v of rec.a11y.violations || []) console.log(`          - [${v.impact}] ${v.id}: ${v.help} (${v.nodes} nodes)`);
  }
  if (rec.failedRequests.length) {
    console.log(`  broken: ${rec.failedRequests.length} failed request(s)`);
    for (const f of rec.failedRequests) console.log(`          - ${f.status || f.failure} ${f.url}`);
  }
  if (rec.consoleErrors.length) console.log(`  console errors: ${rec.consoleErrors.length}`);
  for (const n of rec.notes) console.log(`  note: ${n}`);
}

function fmt(n) { return (n == null) ? 'n/a' : Math.round(n); }

function summarize(records, strategy) {
  const pub = records.filter((r) => !r.auth);
  const pass = pub.filter((r) => r.status === 'PASS').length;
  const fail = pub.filter((r) => r.status === 'FAIL' || r.status === 'ERROR').length;
  const blocked = pub.filter((r) => r.status === 'BLOCKED').length;
  const deferred = records.filter((r) => r.status === 'DEFERRED').length;

  console.log('\n========== A11Y / PERF SUMMARY ==========');
  console.log(`  axe strategy : ${strategy.kind === 'devdep' ? '@axe-core/playwright (dev dep)' : 'CDN-injected axe-core'}`);
  console.log(`  public PASS  : ${pass}`);
  console.log(`  public FAIL  : ${fail}`);
  console.log(`  public BLOCK : ${blocked}`);
  console.log(`  deferred     : ${deferred} (auth-required)`);

  return { records, pass, fail, blocked, deferred, ok: fail === 0 && blocked === 0 };
}

// ---- CLI entry -------------------------------------------------------------
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  run()
    .then((s) => process.exit(s.ok ? EXIT_PASS : EXIT_FAIL))
    .catch((err) => {
      if (err instanceof BlockedError) {
        console.error(`[a11y-perf] BLOCKED — ${err.message}`);
        process.exit(EXIT_BLOCKED);
      }
      console.error(`[a11y-perf] ERROR — ${err?.stack || err}`);
      process.exit(EXIT_FAIL);
    });
}
