#!/usr/bin/env node
/* ============================================================================
 * vendor-three.mjs — rebuild public/vendor/three-<ver>/ from the npm tarball.
 *
 *   node scripts/vendor-three.mjs <unpacked npm "package" dir> [esbuild binary]
 *   node scripts/vendor-three.mjs --check     verify the committed files against
 *                                             public/vendor/three-<ver>/SHA384SUMS
 *
 * Why self-host: three.js r150+ ships ES modules only (examples/js was removed after
 * r148), and loading them from a CDN would need the CDN back in script-src plus SRI
 * that drifts whenever the CDN re-minifies. Vendored files are same-origin, so the
 * builder's CSP is plain 'self' and the hashes below are the integrity record.
 *
 * What it writes (dev-time only; esbuild is NOT a runtime / deploy dependency):
 *   three.module.min.js              build/three.module.js + three.core.js, bundled + minified
 *   addons/<dir>/<File>.js           each addon minified, its bare `from 'three'` import
 *                                    rewritten to the relative three.module.min.js (no importmap)
 *   scripts/three-vendor.SHA384SUMS  sha384 (base64, SRI format) of every vendored file (kept OUT of
 *                                    public/: FILE-01 allows only deployable types there). The MIT
 *                                    notice travels in each file's banner + public/vendor/README.md.
 * ========================================================================== */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const VERSION = '0.186.1';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'vendor', 'three-' + VERSION);
const SUMS = join(ROOT, 'scripts', 'three-vendor.SHA384SUMS');
// every addon the builder uses (+ what they import). Keep in sync with public/three-boot.js.
const ADDONS = ['controls/OrbitControls.js', 'controls/TransformControls.js', 'utils/BufferGeometryUtils.js',
  'loaders/GLTFLoader.js', 'utils/SkeletonUtils.js'];

const sri = (buf) => 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');
function listFiles(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base)); else out.push(relative(base, p).split('\\').join('/'));
  }
  return out.sort();
}

if (process.argv[2] === '--check') {
  const sums = readFileSync(SUMS, 'utf8').trim().split('\n').map((l) => l.split(/\s+/));
  let bad = 0;
  for (const [h, f] of sums) { const got = sri(readFileSync(join(OUT, f))); if (got !== h) { console.error('MISMATCH ' + f); bad++; } }
  const listed = new Set(sums.map((s) => s[1]));
  for (const f of listFiles(OUT)) if (!listed.has(f)) { console.error('UNLISTED ' + f); bad++; }
  if (bad) process.exit(1);
  console.log('vendor-three: ' + sums.length + ' files ok (three ' + VERSION + ')');
  process.exit(0);
}

const PKG = process.argv[2];
const ESBUILD = process.argv[3] || 'esbuild';
if (!PKG || !existsSync(join(PKG, 'package.json'))) { console.error('usage: vendor-three.mjs <npm package dir> [esbuild]'); process.exit(2); }
const pj = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
if (pj.name !== 'three' || pj.version !== VERSION) { console.error('expected three@' + VERSION + ', got ' + pj.name + '@' + pj.version); process.exit(2); }

mkdirSync(join(OUT, 'addons'), { recursive: true });
const banner = '/* three.js ' + VERSION + ' (r' + VERSION.split('.')[1] + ') | MIT License | Copyright 2010-2026 three.js authors | vendored by scripts/vendor-three.mjs */';
// 1. core: bundle module + core into one file (one request, one module instance)
execFileSync(ESBUILD, [join(PKG, 'build', 'three.module.js'), '--bundle', '--format=esm', '--minify', '--target=es2020',
  '--legal-comments=none', '--banner:js=' + banner, '--outfile=' + join(OUT, 'three.module.min.js'), '--log-level=warning']);
// 2. addons: rewrite the bare 'three' specifier, minify (no bundling: they share the one core module)
for (const a of ADDONS) {
  const src = readFileSync(join(PKG, 'examples', 'jsm', a), 'utf8');
  const rel = posix.relative(posix.dirname(posix.join('addons', a)), 'three.module.min.js');
  const rewritten = src.replace(/from\s+['"]three['"]/g, "from '" + rel + "'");
  const min = execFileSync(ESBUILD, ['--loader=js', '--format=esm', '--minify', '--target=es2020', '--legal-comments=none', '--log-level=warning'], { input: rewritten });
  if (/from\s*['"]three['"\/]/.test(String(min))) throw new Error('bare three import left in ' + a);   // (comments are stripped by now)
  mkdirSync(dirname(join(OUT, 'addons', a)), { recursive: true });
  writeFileSync(join(OUT, 'addons', a), '/* three.js ' + VERSION + ' examples/jsm/' + a + ' | MIT */\n' + min);
}
const files = listFiles(OUT);
writeFileSync(SUMS, files.map((f) => sri(readFileSync(join(OUT, f))) + '  ' + f).join('\n') + '\n');
console.log(readFileSync(SUMS, 'utf8'));
