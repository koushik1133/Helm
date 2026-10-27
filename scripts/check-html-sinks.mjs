#!/usr/bin/env node
/* ============================================================================
 * check-html-sinks.mjs — "no unsafe HTML" CI guard (zero dependencies).
 *
 * Scans public/**\/*.js and every inline <script> in public/**\/*.html for HTML
 * sinks:   el.innerHTML = / +=     el.outerHTML = / +=
 *          el.insertAdjacentHTML(pos, …)     document.write(…) / writeln(…)
 * For each sink it takes the assigned expression and checks EVERY value that
 * is interpolated into markup:
 *   - each ${…} inside a template literal (at any nesting depth, including
 *     templates inside .map(...) callbacks), and
 *   - each non-literal operand of a top-level "+" concatenation.
 * A value is accepted when it is
 *   - wrapped in an escaping/encoding helper   esc( escapeHtml( encodeURIComponent( …
 *   - a constant (string/number literal, template whose own ${} are checked)
 *   - numeric by construction  (.length, .toFixed(), Number(), Math.*, parseInt…)
 *   - a ternary / || / && / ?? whose result branches are all accepted
 *   - a call to a reviewed HTML-returning helper listed in SAFE_HELPERS
 *   - a .map(cb).join(…) whose callback is an arrow / function returning an accepted
 *     value (every `return` checked) or a SAFE_HELPERS name (R32 CLI-01); the
 *     templates inside the callback are checked as usual
 * Anything else must be listed in scripts/html-sinks-allowlist.json with a
 * written justification ("why"). Stale allowlist entries are reported so the
 * list cannot silently rot.
 *
 *   node scripts/check-html-sinks.mjs            # check (CI)
 *   node scripts/check-html-sinks.mjs --list     # print every unaccepted value
 * ========================================================================== */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
const ALLOW_PATH = join(ROOT, 'scripts', 'html-sinks-allowlist.json');
const LIST = process.argv.includes('--list');
const HELPERS = process.argv.includes('--helpers');   // R32b: print where each reviewed helper is accepted

// Helpers reviewed to return escaped HTML / fixed markup. Each was read and
// confirmed to esc() every caller-controlled value it emits.
// R32b (R2-CLI-01): an entry may name the files it was reviewed in ("files": [...]); the same helper NAME in any
// other file (card / tab / opt / cardHtml are different functions in different files) is then not accepted.
const HELPER_FILES = new Map();
for (const h of JSON.parse(readFileSync(ALLOW_PATH, 'utf8')).safeHelpers) {
  const prev = HELPER_FILES.get(h.name);
  const files = Array.isArray(h.files) ? h.files : null;
  HELPER_FILES.set(h.name, prev === undefined ? files : (prev === null || files === null ? null : prev.concat(files)));
}
export const SAFE_HELPERS = { has: (name) => helperOk(name) };
let CUR_FILE = null;                       // the file being scanned (set by scan(); tests may set it with setFile)
export function setFile(f) { CUR_FILE = f; }
export const HELPER_USE = new Map();       // name -> Set(files) where the scan accepted it (for --helpers)
function helperOk(name) {
  if (!HELPER_FILES.has(name)) return false;
  const files = HELPER_FILES.get(name);
  const ok = files === null || (CUR_FILE != null && files.includes(CUR_FILE));
  if (ok && CUR_FILE) { if (!HELPER_USE.has(name)) HELPER_USE.set(name, new Set()); HELPER_USE.get(name).add(CUR_FILE); }
  return ok;
}
const ESCAPERS = /^(?:esc|escapeHtml|escHtml|escAttr|encodeURIComponent|encodeURI|Number|parseInt|parseFloat|Math\.[a-z]+|Boolean|String\(Number|safeLink|safeQr)$/;

// Exact directory names only (a substring test also skipped e.g. public/vendors-*/).
const SKIP_DIRS = new Set(['vendor', 'node_modules', 'docs']);
function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(p, out); }
    else if (/\.(js|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

// ---- tiny JS lexer helpers --------------------------------------------------
// Skip a quoted string starting at i (s[i] is the quote). Returns index after it.
function skipStr(s, i) { const q = s[i]; i++; while (i < s.length && s[i] !== q) { if (s[i] === '\\') i++; else if (s[i] === '\n' && q !== '`') return i; i++; } return i + 1; }
// Skip a template literal; collects ${} bodies into out. Returns index after closing `.
function skipTpl(s, i, out) {
  i++;
  while (i < s.length && s[i] !== '`') {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === '$' && s[i + 1] === '{') { const st = i + 2; const en = skipBalanced(s, st, '}', out); if (out) out.push(s.slice(st, en)); i = en + 1; continue; }
    i++;
  }
  return i + 1;
}
function isRegexStart(s, i) { let j = i - 1; while (j >= 0 && /\s/.test(s[j])) j--; return j < 0 || /[(,=:[!&|?{};+\-*%<>~^]/.test(s[j]) || /\breturn$/.test(s.slice(Math.max(0, j - 6), j + 1)); }
function skipRegex(s, i) { i++; let cls = false; while (i < s.length) { const c = s[i]; if (c === '\\') { i += 2; continue; } if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) break; else if (c === '\n') return i; i++; } i++; while (/[a-z]/i.test(s[i] || '')) i++; return i; }
// Scan from i until the closing char at depth 0 (or ; / newline-at-depth-0 when close is null).
function skipBalanced(s, i, close, out) {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { i = skipStr(s, i); continue; }
    if (c === '`') { i = skipTpl(s, i, out); continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
    if (c === '/' && s[i + 1] === '*') { i = s.indexOf('*/', i + 2) + 2; if (i < 2) return s.length; continue; }
    if (c === '/' && isRegexStart(s, i)) { i = skipRegex(s, i); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return i; depth--; }
    else if (depth === 0 && close === null && (c === ';' || c === ',')) return i;
    i++;
  }
  return i;
}
// Split expression on a top-level operator token list; returns parts or null.
function splitTop(e, ops) {
  const parts = []; let depth = 0, last = 0;
  for (let i = 0; i < e.length;) {
    const c = e[i];
    if (c === '"' || c === "'") { i = skipStr(e, i); continue; }
    if (c === '`') { i = skipTpl(e, i, null); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0) {
      const op = ops.find((o) => e.startsWith(o, i));
      if (op && !(op === '+' && (e[i + 1] === '+' || e[i + 1] === '=' || e[i - 1] === '+'))
          && !(op === '?' && (e[i + 1] === '.' || e[i + 1] === '?' || e[i - 1] === '?'))) {
        parts.push(e.slice(last, i)); i += op.length; last = i; continue;
      }
    }
    i++;
  }
  parts.push(e.slice(last));
  return parts.length > 1 ? parts : null;
}
const strip = (e) => { e = e.trim(); while (e.startsWith('(') && skipBalanced(e, 1, ')') === e.length - 1) e = e.slice(1, -1).trim(); return e; };

// Is expression e accepted? (Its nested templates are checked separately.)
export function safeExpr(e) {
  e = strip(e);
  if (!e) return true;
  // R32b (R2-CLI-01): the comma operator - `(n > 0, evil)` is the value of its LAST operand only
  const cm = splitTop(e, [',']); if (cm) return safeExpr(cm[cm.length - 1]);
  if (/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|-?\d[\d_.e]*|true|false|null|undefined|""|'')$/.test(e)) return true;
  if (e[0] === '`' && skipTpl(e, 0, null) === e.length) return true; // template: own ${} checked elsewhere
  // ternary c ? a : b  → a, b
  const q = splitTop(e, ['?']);
  if (q) { const rest = q.slice(1).join('?'); const ab = splitTop(rest, [':']); if (ab && ab.length === 2) return safeExpr(ab[0]) && safeExpr(ab[1]); }
  const lo = splitTop(e, ['||', '??']); if (lo) return lo.every(safeExpr);
  const la = splitTop(e, ['&&']); if (la) return safeExpr(la[la.length - 1]); // left operands are falsy-only output
  const pl = splitTop(e, ['+']); if (pl) return pl.every(safeExpr);
  if (/^[\w$.]+\s*(?:===?|!==?|<=?|>=?)\s*/.test(e) && !/[`'"]/.test(e)) return true; // boolean
  if (/^!/.test(e)) return true;
  // constant tables / constants: ALL_CAPS, ALL_CAPS[k], ALL_CAPS.k, ALL_CAPS[k].name
  if (/^[A-Z][A-Z0-9_]*(?:\[[^\]]*\]|\.[\w$]+)*$/.test(e)) return true;
  if (/^(?:"[^"]*"|'[^']*')\.repeat\([^()]*\)$/.test(e)) return true;
  if (/(?:\.length|\.size|\.toFixed\(\d*\)|\.getTime\(\)|\.getFullYear\(\)|\.getDate\(\))$/.test(e)) return true;
  // whole-expression call: name(args)
  const call = e.match(/^([\w$.]+)\s*\(/);
  if (call && skipBalanced(e, call[0].length, ')') === e.length - 1) {
    const fn = call[1];
    if (ESCAPERS.test(fn) || SAFE_HELPERS.has(fn) || SAFE_HELPERS.has(fn.split('.').pop())) return true;
  }
  // x.map(cb).join(...)  (callback templates are checked as nested templates). R32 CLI-01: the callback
  // itself must be visibly safe too - an arrow returning an accepted expression, a block whose every
  // `return` is accepted, or a reviewed helper name from SAFE_HELPERS. `x => x.name` is NOT accepted.
  if (/\.map\s*\(/.test(e) && /\.join\s*\([^()]*\)$/.test(e)) return mapJoinSafe(e);
  { const hj = /^([\w$.]+)\.join\(([^()]*)\)$/.exec(e); if (hj && SAFE_HELPERS.has(hj[1]) && safeExpr(hj[2])) return true; }
  return false;
}

// R32 CLI-01: is the callback of a trailing .map(cb).join(sep) visibly safe?
function blockReturnsSafe(b) {
  const re = /\breturn\b/g; let m, n = 0;
  while ((m = re.exec(b))) {
    const st = m.index + m[0].length; let en = skipBalanced(b, st, null);
    while (b[en] === ',') en = skipBalanced(b, en + 1, null);   // R32b: `return a, evil` returns evil (comma operator)
    const ex = b.slice(st, en).trim();
    if (!safeExpr(ex)) return false;
    n++; re.lastIndex = Math.max(en, st);
  }
  return n > 0;
}
export function mapCallbackSafe(cb) {
  cb = strip(cb);
  if (/^[\w$.]+$/.test(cb)) return SAFE_HELPERS.has(cb) || SAFE_HELPERS.has(cb.split('.').pop()) || ESCAPERS.test(cb);
  let m = /^(?:async\s*)?(?:\([^()]*\)|[\w$]+)\s*=>\s*/.exec(cb);
  if (m) {
    const body = cb.slice(m[0].length).trim();
    if (body[0] === '{') return blockReturnsSafe(body.slice(1, skipBalanced(body, 1, '}')));
    return safeExpr(body);
  }
  m = /^function\s*[\w$]*\s*\([^()]*\)\s*\{/.exec(cb);
  if (m) return blockReturnsSafe(cb.slice(m[0].length, skipBalanced(cb, m[0].length, '}')));
  return false;
}
function mapJoinSafe(e) {
  const re = /\.map\s*\(/g; let m;
  while ((m = re.exec(e))) {
    const st = m.index + m[0].length, en = skipBalanced(e, st, ')');
    const j = /^\s*\.join\s*\(([^()]*)\)$/.exec(e.slice(en + 1));
    if (j) {
      // R32b (R2-CLI-01): the separator goes into the markup too - it must be accepted like any value
      if (!safeExpr(j[1])) return false;
      // the callback is the first argument (a 2nd thisArg is never used for HTML)
      const cbEnd = skipBalanced(e, st, null);
      return mapCallbackSafe(e.slice(st, Math.min(cbEnd, en)));
    }
  }
  return false;
}

// All interpolated values in a sink expression.
function valuesOf(rhs) {
  const vals = [];
  const tplBodies = [];
  // collect every ${} at any depth
  const collect = (src) => { for (let i = 0; i < src.length;) { const c = src[i]; if (c === '"' || c === "'") { i = skipStr(src, i); continue; } if (c === '`') { const bodies = []; i = skipTpl(src, i, bodies); tplBodies.push(...bodies); continue; } i++; } };
  collect(rhs);
  for (const b of tplBodies) vals.push(b);
  const pl = splitTop(strip(rhs), ['+']);
  if (pl) for (const p of pl) vals.push(p);
  else vals.push(rhs);
  return vals;
}

// audit run-3 ci/check-html-sinks: also srcdoc (iframe HTML), DOMParser.parseFromString
// and Range.createContextualFragment (both build live DOM from a markup string).
const SINK = /(?:\.(innerHTML|outerHTML|srcdoc)\s*(\+?=)(?!=)|\.insertAdjacentHTML\s*\(|\bdocument\.write(?:ln)?\s*\(|\.parseFromString\s*\(|\.createContextualFragment\s*\()/g;
function scan(code, file, baseLine) {
  const hits = [];
  CUR_FILE = file;
  let m;
  SINK.lastIndex = 0;
  while ((m = SINK.exec(code))) {
    let start = m.index + m[0].length, rhs;
    if (m[0].includes('insertAdjacentHTML')) { const comma = skipBalanced(code, start, null); start = comma + 1; rhs = code.slice(start, skipBalanced(code, start, ')')); }
    else if (m[0].includes('write') || m[0].includes('createContextualFragment')) rhs = code.slice(start, skipBalanced(code, start, ')'));
    else if (m[0].includes('parseFromString')) rhs = code.slice(start, skipBalanced(code, start, null));   // first argument only
    else rhs = code.slice(start, skipBalanced(code, start, null));
    const line = baseLine + code.slice(0, m.index).split('\n').length - 1;
    for (const v of valuesOf(rhs)) {
      const n = v.replace(/\s+/g, ' ').trim();
      if (!safeExpr(v)) hits.push({ file, line, expr: n });
    }
  }
  return hits;
}

// R32: the scan only runs as a script, so tests can import safeExpr / mapCallbackSafe
const IS_MAIN = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (IS_MAIN) main();
function main() {
const allow = JSON.parse(readFileSync(ALLOW_PATH, 'utf8'));
const allowMap = new Map(allow.sites.map((s) => [s.file + ' :: ' + s.expr, s]));
for (const s of allow.sites) if (!s.why || s.why.length < 12) { console.error('  ✗ allowlist entry without a real justification: ' + s.file + ' :: ' + s.expr); process.exitCode = 1; }
for (const h of allow.safeHelpers) if (!h.why || h.why.length < 12) { console.error('  ✗ safeHelper without justification: ' + h.name); process.exitCode = 1; }

const found = [];
for (const f of walk(PUB)) {
  const rel = relative(ROOT, f);
  const src = readFileSync(f, 'utf8');
  if (f.endsWith('.js')) found.push(...scan(src, rel, 1));
  else {
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi; let m;
    while ((m = re.exec(src))) {
      if (/\bsrc\s*=/.test(m[1]) || /type\s*=\s*["']?(?:application\/(?:ld\+)?json|text\/template)/i.test(m[1])) continue;
      const line = src.slice(0, m.index + m[0].indexOf('>') + 1).split('\n').length;
      found.push(...scan(m[2], rel, line));
    }
  }
}

// Count-anchored allowlist (audit run-3): an entry approves at most `max` sites
// (default 1) with that file + expression, so a NEW sink that happens to reuse an
// already-reviewed bare identifier in the same file is not silently approved.
const used = new Set();
const seen = new Map();
const bad = [];
for (const h of found) {
  const k = h.file + ' :: ' + h.expr;
  if (!allowMap.has(k)) { bad.push(h); continue; }
  used.add(k);
  const n = (seen.get(k) || 0) + 1; seen.set(k, n);
  const max = Number(allowMap.get(k).max || 1);
  if (n > max) bad.push({ ...h, extra: ` (allowlisted for ${max} site(s); this is site #${n} - review it, then raise "max")` });
}
if (HELPERS) { for (const [k, v] of [...HELPER_USE.entries()].sort()) console.log(k + '\t' + [...v].sort().join(' ')); process.exit(0); }
if (LIST) { for (const h of bad) console.log(`${h.file}:${h.line}\t${h.expr}`); console.log(bad.length + ' unaccepted'); process.exit(0); }
for (const h of bad) console.error(`  ✗ ${h.file}:${h.line} unescaped value into HTML sink: \${${h.expr}}${h.extra || ''}  → wrap in esc(), or allowlist with a reason`);
const stale = [...allowMap.keys()].filter((k) => !used.has(k));
for (const k of stale) console.error('  ✗ stale allowlist entry (site no longer exists — remove it): ' + k);
if (bad.length || stale.length || process.exitCode) { console.error(`check-html-sinks: ${bad.length} unescaped, ${stale.length} stale`); process.exit(1); }
console.log(`  ✓ HTML sinks: every interpolated value is escaped/constant or one of ${used.size} reviewed allowlist entries`);
}
