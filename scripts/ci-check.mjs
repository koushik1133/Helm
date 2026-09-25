#!/usr/bin/env node
/* ============================================================================
 * ci-check.mjs — zero-dependency CI safety net for Helm.
 * Runs on every push (see .github/workflows/ci.yml) and locally via
 *   node scripts/ci-check.mjs
 *
 * Checks (fail the build on any error):
 *   1. Every public/*.js parses (node --check).
 *   2. Every server-side *.js (server.js, server/**, scripts/**) parses.
 *   3. Every inline <script> in public/*.html parses.
 *   4. store-api.js is referenced at ONE consistent ?v= across all pages
 *      (catches the cache-busting drift we've hit before).
 *   5. No Supabase service_role key is committed in client code (safety).
 * ========================================================================== */
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
let errors = 0;
const fail = (m) => { console.error('  ✗ ' + m); errors++; };
const ok = (m) => console.log('  ✓ ' + m);

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|\.git/.test(p)) walk(p, out); }
    else out.push(p);
  }
  return out;
}
function nodeCheck(file) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); return true; }
  catch (e) { fail(`${file.replace(ROOT + '/', '')} — ${String(e.stderr || e).split('\n').find(Boolean)}`); return false; }
}

// 1 + 2) parse every .js under public/, server, scripts, and server.js
console.log('JS syntax:');
const jsFiles = [
  ...walk(PUB).filter((f) => f.endsWith('.js')),
  ...(safeWalk(join(ROOT, 'server'))),
  ...(safeWalk(join(ROOT, 'scripts'))),
  join(ROOT, 'server.js'),
].filter((f) => { try { return statSync(f).isFile() && f.endsWith('.js'); } catch { return false; } });
function safeWalk(d) { try { return walk(d).filter((f) => f.endsWith('.js')); } catch { return []; } }
let jsOk = 0;
for (const f of jsFiles) if (nodeCheck(f)) jsOk++;
ok(`${jsOk}/${jsFiles.length} .js files parse`);

// 3) inline <script> in every html page
console.log('Inline page scripts:');
const tmp = mkdtempSync(join(tmpdir(), 'helm-ci-'));
const htmls = walk(PUB).filter((f) => f.endsWith('.html'));
let htmlOk = 0;
for (const f of htmls) {
  const html = readFileSync(f, 'utf8');
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!blocks.length) { htmlOk++; continue; }
  const t = join(tmp, 'x.js');
  writeFileSync(t, blocks.join('\n;\n'));
  if (nodeCheck(t)) htmlOk++; else fail(`inline script in ${f.replace(ROOT + '/', '')}`);
}
ok(`${htmlOk}/${htmls.length} pages' inline scripts parse`);

// 4) cache-bust version consistency for the shared assets (store-api.js AND
//    config.js — PERF-05: config.js had drifted across 6 versions, so stale
//    config could be served to some pages).
console.log('Cache-bust consistency:');
for (const asset of ['store-api', 'config']) {
  const versions = new Set();
  const re = new RegExp(asset.replace('.', '\\.') + '\\.js\\?v=(\\d+)');
  for (const f of htmls) {
    const m = readFileSync(f, 'utf8').match(re);
    if (m) versions.add(m[1]);
  }
  if (versions.size <= 1) ok(`${asset}.js uniform at v=${[...versions][0] || '(none)'}`);
  else fail(`${asset}.js version drift across pages: ${[...versions].sort().join(', ')}`);
}

// 5) no service_role key in client code
console.log('Secret safety:');
let leaked = 0;
for (const f of walk(PUB)) {
  if (!/\.(js|html)$/.test(f)) continue;
  if (/service_role|"role":"service_role"|SUPABASE_SERVICE_ROLE/.test(readFileSync(f, 'utf8'))) { fail(`possible service_role reference in ${f.replace(ROOT + '/', '')}`); leaked++; }
}
if (!leaked) ok('no service_role key in public/');

console.log('');
if (errors) { console.error(`FAILED — ${errors} problem(s).`); process.exit(1); }
console.log('All checks passed.');
