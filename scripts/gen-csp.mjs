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
 * ========================================================================== */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeHashes, withHashes, htmlFiles } = require('./csp-hashes.cjs');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const check = process.argv.includes('--check');
let problems = 0;

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

// 2) vercel.json — every Content-Security-Policy header value
const vPath = join(ROOT, 'vercel.json');
const vRaw = readFileSync(vPath, 'utf8');
const vercel = JSON.parse(vRaw);
let cspCount = 0;
for (const rule of vercel.headers || []) {
  for (const h of rule.headers || []) {
    if (h.key.toLowerCase() === 'content-security-policy') { h.value = withHashes(h.value, hashes); cspCount++; }
  }
}
if (!cspCount) { console.error('  ✗ vercel.json has no Content-Security-Policy header'); problems++; }
const vNext = JSON.stringify(vercel, null, 2) + '\n';

// 3) public/_headers (Netlify / Cloudflare Pages format)
const hPath = join(PUBLIC, '_headers');
const hRaw = readFileSync(hPath, 'utf8');
const hNext = hRaw.replace(/^(\s*Content-Security-Policy:\s*)(.*)$/gm, (_, k, v) => k + withHashes(v, hashes));

if (check) {
  if (vNext !== vRaw) { console.error('  ✗ vercel.json CSP script hashes are stale — run: node scripts/gen-csp.mjs'); problems++; }
  if (hNext !== hRaw) { console.error('  ✗ public/_headers CSP script hashes are stale — run: node scripts/gen-csp.mjs'); problems++; }
  if (/script-src[^;]*'unsafe-inline'/.test(vRaw)) { console.error("  ✗ vercel.json script-src still allows 'unsafe-inline'"); problems++; }
  if (!problems) console.log(`  ✓ CSP script hashes current (${hashes.length} inline scripts, ${cspCount} policies)`);
} else {
  writeFileSync(vPath, vNext);
  writeFileSync(hPath, hNext);
  console.log(`  ✓ wrote ${hashes.length} script hashes into ${cspCount} vercel.json policies + public/_headers`);
}
process.exit(problems ? 1 : 0);
