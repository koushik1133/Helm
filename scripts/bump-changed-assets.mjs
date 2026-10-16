#!/usr/bin/env node
/* bump-changed-assets.mjs — cache-busting for immutable assets.
 *
 *   node scripts/bump-changed-assets.mjs            dry run: list what would change
 *   node scripts/bump-changed-assets.mjs --apply    rewrite references in place
 *   node scripts/bump-changed-assets.mjs --verify   exit 1 if any changed asset still has a reference
 *                                                   whose version equals what git HEAD had
 *   --base <ref>                                    compare against <ref> instead of HEAD
 *
 * Changed assets = public/**\/*.js|css that differ from <base> (git diff) + untracked ones.
 * For each changed asset it bumps:
 *   1. static references  "file.js?v=N"  in public/*.html|js|css and scripts/gen-*.mjs
 *   2. loader constants   "file.js?v=" + SOME_V   -> the  SOME_V = "N"  declaration in that file
 *   3. shared SHELL_V in shell-proto.js for files loaded through its css()/js() helpers
 *   4. new static <script src>/<link href> with no ?v= at all  -> ?v=1
 * Idempotent: target version = max(current, baseVersion + 1), so re-running never double-bumps.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERIFY = args.includes('--verify');
const BASE = args.includes('--base') ? args[args.indexOf('--base') + 1] : 'HEAD';

const git = (c) => execSync('git ' + c, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
const atBase = (rel) => { try { return git(`show ${BASE}:${rel}`); } catch { return null; } };

const changed = [...new Set([
  ...git(`diff --name-only ${BASE} -- public`).split('\n'),
  ...git('ls-files --others --exclude-standard public').split('\n'),
])].filter((f) => /\.(js|css)$/.test(f) && existsSync(join(ROOT, f))).map((f) => f.slice('public/'.length));
const changedSet = new Set(changed);

/* files loaded via shell-proto.js css()/js()/optCss() helpers + shell-b.js addons + tour.js: all share SHELL_V */
const SHELL_GROUP = /^(shell-b[\w-]*\.(js|css)|ui-kit\.(js|css)|tables-mobile\.(js|css)|tour\.js)$/;

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) { if (n !== 'node_modules') walk(p, out); }
    else if (/\.(html|js|css)$/.test(n)) out.push(p);
  }
  return out;
}
const scan = [...walk(PUB), ...readdirSync(join(ROOT, 'scripts')).filter((n) => /^gen-.*\.mjs$/.test(n)).map((n) => join(ROOT, 'scripts', n))];

/* resolve a referenced path ("/x.js", "./a/x.js", "x.js", "../x.js") to a public-relative path */
function resolveRef(fromAbs, ref) {
  if (/^https?:|^\/\//.test(ref)) return null;
  if (ref.startsWith('/')) return ref.slice(1);
  const baseDir = fromAbs.startsWith(PUB) ? dirname(fromAbs) : PUB;   // scripts/gen-*.mjs refer to public paths
  const r = relative(PUB, join(baseDir, ref));
  return r.startsWith('..') ? ref.replace(/^\.\//, '') : r;
}

const STATIC_RE = /([\w./-]*?[\w.-]+\.(?:js|css))\?v=(\d+)/g;
const CONST_RE = /["'`]([\w./-]+\.(?:js|css))\?v=["'`]\s*\+\s*([A-Z_][A-Z0-9_]*)/g;
const declRe = (id) => new RegExp('(\\b' + id + '\\s*=\\s*["\'`]?)(\\d+)(["\'`]?)', 'g');

function staticRefs(abs, text) {
  const out = [];
  for (const m of text.matchAll(STATIC_RE)) {
    const asset = resolveRef(abs, m[1]);
    if (asset && changedSet.has(asset)) out.push({ asset, v: +m[2] });
  }
  return out;
}
function constRefs(text) {
  const out = [];
  for (const m of text.matchAll(CONST_RE)) {
    const asset = m[1].replace(/^\.?\//, '');
    if (changedSet.has(asset)) out.push({ asset, id: m[2] });
  }
  return out;
}
const declValues = (text, id) => [...text.matchAll(declRe(id))].map((m) => +m[2]);

/* ---- compute targets ---- */
const plan = [];   // { file, kind, what, from, to }
const problems = [];
const shellAssets = changed.filter((a) => SHELL_GROUP.test(a));

/* static: per asset, target = max(current max, base max + 1) */
const cur = new Map(), base = new Map(), texts = new Map(), baseTexts = new Map();
for (const abs of scan) {
  const rel = relative(ROOT, abs), t = readFileSync(abs, 'utf8'), b = atBase(rel);
  texts.set(abs, t); baseTexts.set(abs, b);
  for (const r of staticRefs(abs, t)) cur.set(r.asset, Math.max(cur.get(r.asset) || 0, r.v));
  if (b) for (const r of staticRefs(abs, b)) base.set(r.asset, Math.max(base.get(r.asset) || 0, r.v));
}
const target = new Map();
for (const a of changed) if (cur.has(a)) target.set(a, Math.max(cur.get(a), (base.get(a) || 0) + 1));

/* constants (file+id), including SHELL_V */
const constTargets = [];   // { abs, id, to, assets }
for (const abs of scan) {
  const t = texts.get(abs), b = baseTexts.get(abs) || '';
  const byId = new Map();
  for (const r of constRefs(t)) { if (!byId.has(r.id)) byId.set(r.id, new Set()); byId.get(r.id).add(r.asset); }
  if (abs.endsWith('/public/shell-proto.js') && shellAssets.length) byId.set('SHELL_V', new Set(shellAssets));
  for (const [id, assets] of byId) {
    const c = declValues(t, id), bv = declValues(b, id);
    if (!c.length) { problems.push(`${relative(ROOT, abs)}: no declaration for ${id} (${[...assets]})`); continue; }
    constTargets.push({ abs, id, assets: [...assets], to: Math.max(...c, (bv.length ? Math.max(...bv) : 0) + 1) });
  }
}

/* ---- rewrite ---- */
for (const abs of scan) {
  let t = texts.get(abs); const orig = t; const rel = relative(ROOT, abs);
  t = t.replace(STATIC_RE, (m, ref, v) => {
    const a = resolveRef(abs, ref);
    if (!a || !target.has(a) || +v === target.get(a)) return m;
    plan.push({ file: rel, what: ref, from: +v, to: target.get(a) });
    return `${ref}?v=${target.get(a)}`;
  });
  for (const ct of constTargets.filter((c) => c.abs === abs)) {
    t = t.replace(declRe(ct.id), (m, pre, v, post) => {
      if (+v === ct.to) return m;
      plan.push({ file: rel, what: `${ct.id} (${ct.assets.join(', ')})`, from: +v, to: ct.to });
      return pre + ct.to + post;
    });
  }
  if (abs.endsWith('.html')) {   // unversioned static tags for changed assets -> ?v=1
    t = t.replace(/(<(?:script[^>]*\ssrc|link[^>]*\shref)=")([^"?#]+\.(?:js|css))(")/g, (m, pre, ref, post) => {
      const a = resolveRef(abs, ref);
      if (!a || !changedSet.has(a)) return m;
      plan.push({ file: rel, what: ref, from: '(none)', to: 1 });
      return `${pre}${ref}?v=1${post}`;
    });
  }
  if (abs.endsWith('.js')) {   // JS loaders that set .src/.href to an unversioned changed asset -> ?v=1
    t = t.replace(/(\.(?:src|href)\s*=\s*["'])([^"'?#]+\.(?:js|css))(["'])/g, (m, pre, ref, post) => {
      const a = resolveRef(abs, ref);
      if (!a || !changedSet.has(a)) return m;
      plan.push({ file: rel, what: ref, from: '(none)', to: 1 });
      return `${pre}${ref}?v=1${post}`;
    });
  }
  if (APPLY && t !== orig) writeFileSync(abs, t);
  texts.set(abs, t);
}

/* ---- verify: every reference of a changed asset differs from what base had ---- */
const fails = [];
for (const a of changed) {
  const constCover = constTargets.filter((c) => c.assets.includes(a));
  const hasStatic = cur.has(a) || plan.some((p) => p.to === 1 && resolveRef(PUB, p.what) === a);
  const effective = APPLY ? texts : null;
  if (cur.has(a)) {
    const bv = base.get(a);
    for (const abs of scan) for (const r of staticRefs(abs, (effective || texts).get(abs))) {
      if (r.asset === a && bv !== undefined && r.v === bv && (APPLY || VERIFY)) fails.push(`${a}: ${relative(ROOT, abs)} still ?v=${r.v}`);
    }
  }
  for (const ct of constCover) {
    const bv = declValues(baseTexts.get(ct.abs) || '', ct.id);
    const now = declValues(texts.get(ct.abs), ct.id);
    if ((APPLY || VERIFY) && now.some((v) => bv.includes(v))) fails.push(`${a}: ${ct.id} in ${relative(ROOT, ct.abs)} still ${now}`);
  }
  if (!hasStatic && !constCover.length) problems.push(`${a}: no versioned reference found (unreferenced, or loaded some other way — check by hand)`);
}

console.log(`${changed.length} changed asset(s) vs ${BASE}; ${plan.length} edit(s) ${APPLY ? 'applied' : '(dry run)'}`);
for (const p of plan) console.log(`  ${p.file}: ${p.what}  ${p.from} -> ${p.to}`);
if (problems.length) { console.log('\nnotes:'); for (const p of problems) console.log('  ' + p); }
if (VERIFY || APPLY) {
  if (fails.length) { console.log('\nFAIL (reference version unchanged from base):'); for (const f of fails) console.log('  ' + f); }
  else console.log('\nverify: every reference of every changed asset differs from ' + BASE);
}
if (VERIFY && (fails.length || (!APPLY && plan.length))) process.exit(1);
