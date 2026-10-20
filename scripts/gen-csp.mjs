#!/usr/bin/env node
/* ============================================================================
 * gen-csp.mjs — keep the CSP script hashes in vercel.json and public/_headers
 * in sync with the inline <script> blocks in public/*.html.
 *
 *   node scripts/gen-csp.mjs          rewrite vercel.json + public/_headers
 *   node scripts/gen-csp.mjs --check  exit 1 if either is stale (CI)
 *
 * Run it after editing ANY inline <script> in a page — otherwise the browser
 * refuses that script in production (script-src has no 'unsafe-inline').
 * Also fails when a page carries an inline event-handler attribute (on*=) or a
 * javascript: URL, which a hash-based CSP blocks.
 *
 * Env split: every vercel.json and public/_headers CSP is STAGING-FREE (staging
 * Supabase origins are stripped), so production never allows staging — EXCEPT
 * one generated host-conditioned rule per STAGING_CSP_HOSTS entry (the staging
 * site helm-v01.vercel.app), which allows the staging project. server.js
 * (localhost dev) also adds staging to its CSP. We deliberately do NOT emit
 * per-host duplicate CSP rules: that grew vercel.json to 700 KB and Vercel
 * rejected it ("Invalid vercel.json file provided"). Guard: vercel.json must
 * stay < 200 KB and < 200 header+redirect rules, with only documented keys.
 * ========================================================================== */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeHashes, computeStyleHashes, withHashes, htmlFiles, scriptSrcProblem, frameAncestorsProblem, TRUSTED_TYPES_ENFORCE, TT_DIRECTIVES,
  cspReportUri, sentryIngestOrigin, withReporting, reportingEndpoints } = require('./csp-hashes.cjs');   // R8b: frame-ancestors route allowlist lives there

// Production hosts (must match PROD_HOSTS in public/config.js) and the staging
// Supabase project ref (from public/config.staging.js) that they must never allow.
export const PROD_HOSTS = ['www.helm.events', 'helm.events', 'helm-alpha-nine.vercel.app'];
// STAGING site host(s) served by the SAME Vercel project (must match
// SUPABASE_STAGING.hosts in public/config.staging.js). Each gets ONE generated
// host-conditioned CSP rule (appended last, so it overrides the per-page rules)
// = the union of every page policy + the staging Supabase origins. This is the
// ONLY place vercel.json may name the staging project; production hosts never do.
export const STAGING_CSP_HOSTS = ['helm-v01.vercel.app'];
export function isStagingCspRule(r) {
  return Array.isArray(r.has) && r.has.length === 1 && r.has[0].type === 'host' && STAGING_CSP_HOSTS.includes(r.has[0].value) &&
    r.source === '/(.*)' && (r.headers || []).length >= 1 && (r.headers || []).length <= 2 && r.headers[0].key.toLowerCase() === 'content-security-policy' &&
    (r.headers.length === 1 || ['x-frame-options', 'content-security-policy-report-only'].includes(r.headers[1].key.toLowerCase()));
}
function unionPolicy(values) {
  const m = new Map();
  for (const v of values) for (const d of v.split(';').map((x) => x.trim()).filter(Boolean)) {
    const [k, ...toks] = d.split(/\s+/);
    if (!m.has(k)) m.set(k, new Set());
    toks.forEach((t) => { if (!PROD_REF || !t.includes(PROD_REF)) m.get(k).add(t); });   // staging site never allows production
  }
  // audit run-3 deploy/vercel/helm-v01-union-csp-overrides-per-page: a union cannot
  // express per-page framing, and merging 'none' + 'self' widened every staging page to
  // 'self'. So the union carries NO frame-ancestors and the host rule sets no
  // X-Frame-Options: each page's own X-Frame-Options (catch-all DENY; SAMEORIGIN only on
  // /invite, /i/*, the branded invite link and /capture) keeps governing framing there.
  m.delete('frame-ancestors');
  m.delete('report-uri');   // r21: the staging site does not report into the production project
  m.delete('report-to');
  if (STAGING_REF) {
    const add = (k, list) => { if (m.has(k)) list.forEach((x) => m.get(k).add(x)); };
    add('connect-src', ['https://' + STAGING_REF + '.supabase.co', 'wss://' + STAGING_REF + '.supabase.co']);
    add('img-src', ['https://' + STAGING_REF + '.supabase.co']);
    add('media-src', ['https://' + STAGING_REF + '.supabase.co']);
  }
  return [...m].map(([k, set]) => [k, ...set].join(' ')).join('; ');
}
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const check = process.argv.includes('--check');
let problems = 0;
const STAGING_PATH = join(PUBLIC, 'config.staging.js');
const STAGING_REF = existsSync(STAGING_PATH)
  ? (/https:\/\/([a-z0-9]{20})\.supabase\.co/.exec(readFileSync(STAGING_PATH, 'utf8')) || [])[1] : '';
const PROD_REF = (/url:\s*"https:\/\/([a-z0-9]{20})\.supabase\.co"/.exec((existsSync(join(PUBLIC, 'config.js')) ? readFileSync(join(PUBLIC, 'config.js'), 'utf8') : '')) || [])[1] || '';
// r21 monitoring (scripts/csp-hashes.cjs): CSP violation reports -> the prod csp-report edge function, and the
// EXACT Sentry ingest origin of the DSN in public/config.js (none while telemetry is dormant).
const CONFIG_SRC = existsSync(join(PUBLIC, 'config.js')) ? readFileSync(join(PUBLIC, 'config.js'), 'utf8') : '';
const REPORTING = { reportUri: cspReportUri(PROD_REF), sentryOrigin: sentryIngestOrigin(CONFIG_SRC) };
function stripStaging(v) {
  if (!STAGING_REF) return v;   // no staging project configured → nothing to strip
  return v.split(';').map((d) => d.split(' ').filter((tok) => !tok.includes(STAGING_REF)).join(' ')).join(';');
}
function isProdCspRule(r) {
  return Array.isArray(r.has) && r.has.length === 1 && r.has[0].type === 'host' && PROD_HOSTS.includes(r.has[0].value) &&
    (r.headers || []).length === 1 && r.headers[0].key.toLowerCase() === 'content-security-policy';
}

// 1) inline handlers / javascript: URLs can't be hash-allowed — must not exist
const HANDLER = /<[a-z][^>]*\son[a-z]+\s*=\s*["']/i;
for (const f of htmlFiles(PUBLIC)) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (HANDLER.test(l) || /href\s*=\s*["']\s*javascript:/i.test(l)) {
      console.error(`  ✗ ${relative(ROOT, f)}:${i + 1} inline event handler / javascript: URL (blocked by CSP) — use addEventListener`);
      problems++;
    }
  });
}

const hashes = computeHashes(PUBLIC);
const styleHashes = computeStyleHashes(PUBLIC);

// 2) vercel.json — every Content-Security-Policy header value
const vPath = join(ROOT, 'vercel.json');
const vRaw = readFileSync(vPath, 'utf8');
const vercel = JSON.parse(vRaw);
let cspCount = 0;
// drop previously generated prod-host overrides; they are rebuilt below
vercel.headers = (vercel.headers || []).filter((r) => !r.__prodCsp && !isProdCspRule(r) && !isStagingCspRule(r));
for (const rule of vercel.headers || []) {
  for (const h of rule.headers || []) {
    if (h.key.toLowerCase() === 'content-security-policy') {
      h.value = withReporting(stripStaging(withHashes(h.value, hashes, styleHashes)), REPORTING); cspCount++;
      const fbad = frameAncestorsProblem(h.value, rule.source);
      if (fbad) { console.error(`  ✗ vercel.json ${rule.source}: ${fbad}`); problems++; }
      const bad = scriptSrcProblem(h.value, rule.source);
      if (bad) { console.error(`  ✗ vercel.json ${rule.source}: ${bad} — host sources live in scripts/csp-hashes.cjs`); problems++; }
    }
  }
}
if (!cspCount) { console.error('  ✗ vercel.json has no Content-Security-Policy header'); problems++; }
{ // r22: Reporting-Endpoints (the report-to group of every production CSP) on the catch-all rule
  const all = (vercel.headers || []).find((r) => r.source === '/(.*)' && !r.has && !r.missing && (r.headers || []).some((h) => h.key.toLowerCase() === 'content-security-policy'));
  const val = reportingEndpoints(REPORTING.reportUri);
  if (all) {
    all.headers = all.headers.filter((h) => h.key.toLowerCase() !== 'reporting-endpoints');
    if (val) { const i = all.headers.findIndex((h) => h.key.toLowerCase() === 'content-security-policy'); all.headers.splice(i + 1, 0, { key: 'Reporting-Endpoints', value: val }); }
  } else { console.error('  ✗ vercel.json has no catch-all /(.*) CSP rule for Reporting-Endpoints'); problems++; }
}
{ // staging-site host rules (generated; appended last so they override the page rules)
  const pols = [];
  for (const rule of vercel.headers || []) for (const h of rule.headers || [])
    if (h.key.toLowerCase() === 'content-security-policy') pols.push(h.value);
  const staged = unionPolicy(pols);
  for (const host of STAGING_CSP_HOSTS)
    vercel.headers.push({ source: '/(.*)', has: [{ type: 'host', value: host }], headers: [{ key: 'Content-Security-Policy', value: staged },
      // Trusted Types rollout, stage 1 (audit run-3 client/csp): REPORT-ONLY on the staging
      // site only, so the logged-in pass can collect violations before enforcement.
      // public/trusted-types.js runs in observe mode (logs, never rewrites markup) while
      // TRUSTED_TYPES_ENFORCE is false. Production hosts get no Trusted Types header yet.
      ...(!TRUSTED_TYPES_ENFORCE ? [{ key: 'Content-Security-Policy-Report-Only', value: TT_DIRECTIVES.join('; ') }] : [])] });
}
const stagingFree = (v) => JSON.stringify({ ...v, headers: (v.headers || []).filter((r) => !isStagingCspRule(r)) });
const vNext = JSON.stringify(vercel, null, 2) + '\n';
{ // Vercel config limits + documented schema keys
  const MAX_BYTES = 200 * 1024, MAX_RULES = 200;
  const bytes = Buffer.byteLength(vNext);
  const rules = (vercel.headers || []).length + (vercel.redirects || []).length;
  if (bytes >= MAX_BYTES) { console.error(`  ✗ vercel.json is ${bytes} bytes (limit ${MAX_BYTES})`); problems++; }
  if (rules >= MAX_RULES) { console.error(`  ✗ vercel.json has ${rules} header+redirect rules (limit ${MAX_RULES})`); problems++; }
  const allowed = { headers: ['source', 'has', 'missing', 'headers'], redirects: ['source', 'destination', 'permanent', 'statusCode', 'has', 'missing'] };
  for (const [k, keys] of Object.entries(allowed)) {
    (vercel[k] || []).forEach((r, i) => Object.keys(r).forEach((key) => {
      if (!keys.includes(key)) { console.error(`  ✗ vercel.json ${k}[${i}] has undocumented key "${key}"`); problems++; }
    }));
  }
  if (STAGING_REF && stagingFree(vercel).includes(STAGING_REF)) { console.error('  ✗ vercel.json names the staging Supabase project outside the staging-host CSP rule'); problems++; }
}

// 3) public/_headers (Netlify / Cloudflare Pages format)
const hPath = join(PUBLIC, '_headers');
const hRaw = readFileSync(hPath, 'utf8');
let hNext = hRaw.replace(/^(\s*Content-Security-Policy:\s*)(.*)$/gm, (_, k, v) => k + withReporting(stripStaging(withHashes(v, hashes, styleHashes)), REPORTING));
{ // r22: Reporting-Endpoints line right after the catch-all (/*) block's CSP
  const val = reportingEndpoints(REPORTING.reportUri);
  hNext = hNext.replace(/^\s+Reporting-Endpoints:.*\n/gm, '');
  if (val) hNext = hNext.replace(/^(\/\*\n(?:[ \t]+.*\n)*?[ \t]+Content-Security-Policy:.*\n)/m, (b) => b + '  Reporting-Endpoints: ' + val + '\n');
}
{ // script-src host allowlist per _headers block (route = the unindented line above)
  let route = '';
  for (const line of hRaw.split('\n')) {
    if (line.trim() && !line.trim().startsWith('#') && !/^\s/.test(line)) route = line.trim();
    const m = /^\s+Content-Security-Policy:\s*(.*)$/.exec(line);
    const fbad = m && frameAncestorsProblem(m[1], route);
    if (fbad) { console.error(`  ✗ public/_headers ${route}: ${fbad}`); problems++; }
    const bad = m && scriptSrcProblem(m[1], route);
    if (bad) { console.error(`  ✗ public/_headers ${route}: ${bad} — host sources live in scripts/csp-hashes.cjs`); problems++; }
  }
}

if (check) {
  if (vNext !== vRaw) { console.error('  ✗ vercel.json CSP script hashes are stale — run: node scripts/gen-csp.mjs'); problems++; }
  if (hNext !== hRaw) { console.error('  ✗ public/_headers CSP script hashes are stale — run: node scripts/gen-csp.mjs'); problems++; }
  if (/script-src[^;]*'unsafe-inline'/.test(vRaw)) { console.error("  ✗ vercel.json script-src still allows 'unsafe-inline'"); problems++; }
  if (/style-src(-elem)? [^;\n]*'unsafe-inline'/.test(vRaw + hRaw)) { console.error("  ✗ style-src / style-src-elem still allows 'unsafe-inline'"); problems++; }
  // audit run-3 client/csp: no wildcard host in connect-src (e.g. https://*.ingest.sentry.io
  // lets any Sentry org receive exfiltrated data). Pin exact hosts when a DSN exists.
  if (/connect-src[^;\n"]*https:\/\/\*\./.test(vRaw + hRaw)) { console.error('  ✗ connect-src allows a wildcard https://*. host - pin the exact host'); problems++; }
  if (!problems) console.log(`  ✓ CSP script hashes current (${hashes.length} inline scripts, ${cspCount} policies)`);
} else {
  writeFileSync(vPath, vNext);
  writeFileSync(hPath, hNext);
  console.log(`  ✓ wrote ${hashes.length} script + ${styleHashes.length} style hashes into ${cspCount} vercel.json policies + public/_headers`);
}
process.exit(problems ? 1 : 0);
