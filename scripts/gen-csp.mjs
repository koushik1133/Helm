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
 * Supabase origins are stripped), so production never allows staging. Only
 * server.js (localhost dev) adds staging to its CSP. Trade-off: Vercel preview
 * deployments cannot reach the staging Supabase (CSP blocks it) — use localhost
 * for staging work (see docs/STAGING-SETUP.md). We deliberately do NOT emit
 * per-host duplicate CSP rules: that grew vercel.json to 700 KB and Vercel
 * rejected it ("Invalid vercel.json file provided"). Guard: vercel.json must
 * stay < 200 KB and < 200 header+redirect rules, with only documented keys.
 * ========================================================================== */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeHashes, computeStyleHashes, withHashes, htmlFiles, scriptSrcProblem } = require('./csp-hashes.cjs');

// Production hosts (must match PROD_HOSTS in public/config.js) and the staging
// Supabase project ref (from public/config.staging.js) that they must never allow.
export const PROD_HOSTS = ['www.helm.events', 'helm.events', 'helm-v01.vercel.app', 'helm-alpha-nine.vercel.app'];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const check = process.argv.includes('--check');
let problems = 0;
const STAGING_PATH = join(PUBLIC, 'config.staging.js');
const STAGING_REF = existsSync(STAGING_PATH)
  ? (/https:\/\/([a-z0-9]{20})\.supabase\.co/.exec(readFileSync(STAGING_PATH, 'utf8')) || [])[1] : '';
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
vercel.headers = (vercel.headers || []).filter((r) => !r.__prodCsp && !isProdCspRule(r));
for (const rule of vercel.headers || []) {
  for (const h of rule.headers || []) {
    if (h.key.toLowerCase() === 'content-security-policy') {
      h.value = stripStaging(withHashes(h.value, hashes, styleHashes)); cspCount++;
      const bad = scriptSrcProblem(h.value, rule.source);
      if (bad) { console.error(`  ✗ vercel.json ${rule.source}: ${bad} — host sources live in scripts/csp-hashes.cjs`); problems++; }
    }
  }
}
if (!cspCount) { console.error('  ✗ vercel.json has no Content-Security-Policy header'); problems++; }
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
  if (STAGING_REF && vNext.includes(STAGING_REF)) { console.error('  ✗ vercel.json names the staging Supabase project'); problems++; }
}

// 3) public/_headers (Netlify / Cloudflare Pages format)
const hPath = join(PUBLIC, '_headers');
const hRaw = readFileSync(hPath, 'utf8');
const hNext = hRaw.replace(/^(\s*Content-Security-Policy:\s*)(.*)$/gm, (_, k, v) => k + stripStaging(withHashes(v, hashes, styleHashes)));
{ // script-src host allowlist per _headers block (route = the unindented line above)
  let route = '';
  for (const line of hRaw.split('\n')) {
    if (line.trim() && !line.trim().startsWith('#') && !/^\s/.test(line)) route = line.trim();
    const m = /^\s+Content-Security-Policy:\s*(.*)$/.exec(line);
    const bad = m && scriptSrcProblem(m[1], route);
    if (bad) { console.error(`  ✗ public/_headers ${route}: ${bad} — host sources live in scripts/csp-hashes.cjs`); problems++; }
  }
}

if (check) {
  if (vNext !== vRaw) { console.error('  ✗ vercel.json CSP script hashes are stale — run: node scripts/gen-csp.mjs'); problems++; }
  if (hNext !== hRaw) { console.error('  ✗ public/_headers CSP script hashes are stale — run: node scripts/gen-csp.mjs'); problems++; }
  if (/script-src[^;]*'unsafe-inline'/.test(vRaw)) { console.error("  ✗ vercel.json script-src still allows 'unsafe-inline'"); problems++; }
  if (/style-src(-elem)? [^;\n]*'unsafe-inline'/.test(vRaw + hRaw)) { console.error("  ✗ style-src / style-src-elem still allows 'unsafe-inline'"); problems++; }
  if (!problems) console.log(`  ✓ CSP script hashes current (${hashes.length} inline scripts, ${cspCount} policies)`);
} else {
  writeFileSync(vPath, vNext);
  writeFileSync(hPath, hNext);
  console.log(`  ✓ wrote ${hashes.length} script + ${styleHashes.length} style hashes into ${cspCount} vercel.json policies + public/_headers`);
}
process.exit(problems ? 1 : 0);
