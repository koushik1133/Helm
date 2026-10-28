#!/usr/bin/env node
/* page-tours-coverage.test.mjs — keeps "Tour this page" up to date as features change (R46).
 *
 * Fails the build when
 *   1. an app page that gets the shared header (the APP allowlist in public/shell-proto.js) has no
 *      entry in public/page-tours.js, or a page that includes tour.js (its own "? Tour" button) has none;
 *   2. Settings has a section (control-split.js SECTIONS) without its own tour;
 *   3. a step's selector no longer exists in that page's HTML / JS: every #id, .class and [attr="value"]
 *      it names must still appear in the page's HTML (inline scripts included), the local scripts that
 *      page loads, or the shared app-shell scripts that build the header and sidebar.
 *
 * When this fails: you changed a feature. Update its tour in public/page-tours.js (the file header
 * explains the step format). Pure Node, no deps.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
const r = (p) => readFileSync(join(PUB, p), 'utf8');
let passed = 0;
const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };

/* ---- the data file, evaluated as real JS ---- */
const ctx = { window: {}, document: { querySelector: () => null, documentElement: { classList: { contains: () => false } } }, location: { hash: '' } };
ctx.window.location = ctx.location; ctx.window.document = ctx.document; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(r('page-tours.js'), ctx);
const PT = ctx.window.HelmPageTours;
assert.ok(PT && PT.TOURS, 'page-tours.js defines window.HelmPageTours');

/* ---- which pages must have a tour ---- */
const proto = r('shell-proto.js');
const appBlk = /var APP = \{([\s\S]*?)\};/.exec(proto);
assert.ok(appBlk, 'shell-proto.js APP allowlist found');
const APP = [...appBlk[1].matchAll(/"?([a-z][\w-]*)"?\s*:\s*1/g)].map((m) => m[1] + '.html');
assert.ok(APP.length >= 30, 'APP allowlist parsed (' + APP.length + ' pages)');
const withTourJs = readdirSync(PUB).filter((f) => f.endsWith('.html') && /<script src="\/?tour\.js\?v=/.test(r(f)) && f !== 'try.html');

t('header: the file says to update tours with every feature change', () => {
  assert.match(r('page-tours.js'), /When you add or change a feature, update its tour here\./);
});

t('every app page with the shared header has a tour entry (' + APP.length + ' pages)', () => {
  const missing = APP.filter((p) => !PT.entry(p));
  assert.deepEqual(missing, [], 'no tour in page-tours.js for: ' + missing.join(', '));
});

t('every page with its own tour button (tour.js) has a tour entry, and includes page-tours.js before tour.js', () => {
  for (const f of withTourJs) {
    assert.ok(PT.entry(f), 'no tour in page-tours.js for ' + f);
    const H = r(f), a = H.search(/<script src="\/?page-tours\.js\?v=/), b = H.search(/<script src="\/?tour\.js\?v=/);
    assert.ok(a > 0 && a < b, f + ': page-tours.js must load just before tour.js');
  }
  for (const f of ['hq.html', 'builder.html', 'booklet.html']) assert.ok(withTourJs.includes(f), f + ' has a "? Tour" button');
});

/* ---- Settings: one tour per section ---- */
const SPLIT = r('control-split.js');
const SECTIONS = [...SPLIT.slice(SPLIT.indexOf('var SECTIONS=['), SPLIT.indexOf('];', SPLIT.indexOf('var SECTIONS=['))).matchAll(/\{key:"([\w-]+)"[^}]*hash:"(#[\w-]+)"/g)].map((m) => ({ key: m[1], hash: m[2] }));
t('Settings: every section has its own tour, and its #hash picks it (' + SECTIONS.length + ' sections)', () => {
  assert.ok(SECTIONS.length >= 15, 'sections parsed');
  const C = PT.entry('control.html');
  for (const s of SECTIONS) {
    assert.ok(Array.isArray(C.sections[s.key]) && C.sections[s.key].length, 'no tour for Settings section "' + s.key + '"');
    assert.equal(PT.HASH[s.hash], s.key, 'hash ' + s.hash + ' -> ' + s.key);
  }
  for (const k of Object.keys(C.sections)) assert.ok(SECTIONS.some((s) => s.key === k), 'tour for a section that no longer exists: ' + k);
});

/* ---- every selector still exists in that page's sources ---- */
const SHARED = ['shell-b.js', 'shell-b-dash.js', 'shell-b-privacy.js', 'shell-b-search.js', 'shell-b-money.js', 'mobile-nav.js', 'store-api.js', 'auth-ui.js', 'ui-kit.js']
  .filter((f) => existsSync(join(PUB, f))).map(r).join('\n');
const srcCache = {};
function sourcesOf(page) {
  if (srcCache[page]) return srcCache[page];
  const H = r(page);
  const local = [...H.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1].split('?')[0].replace(/^\//, ''))
    .filter((s) => !/^https?:|^\/\//.test(s) && existsSync(join(PUB, s)) && !/^(page-tours|tour)\.js$/.test(s));
  return (srcCache[page] = [H, ...local.map(r), SHARED].join('\n'));
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// the tokens a selector depends on: #ids, .classes, [attr] names and "values"
function tokens(sel) {
  const out = [];
  for (const m of sel.matchAll(/#([\w-]+)/g)) out.push({ k: 'id', v: m[1] });
  for (const m of sel.replace(/\[[^\]]*\]/g, '').matchAll(/\.([\w-]+)/g)) out.push({ k: 'class', v: m[1] });
  for (const m of sel.matchAll(/\[([\w-]+)(?:[~|^$*]?=\s*["']?([^"'\]]+)["']?)?\]/g)) { out.push({ k: 'attr', v: m[1] }); if (m[2]) out.push({ k: 'val', v: m[2] }); }
  return out;
}
function has(src, tok) {
  const v = esc(tok.v);
  if (tok.k === 'id') return new RegExp(`id=["']${v}["']|["'\`]${v}["'\`]|#${v}(?![\\w-])`).test(src);
  return new RegExp(`(^|[^\\w-])${v}([^\\w-]|$)`).test(src);
}
function stepsOf(page) {
  const e = PT.entry(page);
  if (Array.isArray(e)) return [['', e]];
  if (e && Array.isArray(e.steps)) return [['', e.steps]];
  if (e && e.sections) return Object.entries(e.sections);
  return [];
}
const pages = Object.keys(PT.TOURS);
t('every step selector still exists in its page (' + pages.length + ' pages)', () => {
  const bad = [];
  for (const page of pages) {
    if (!existsSync(join(PUB, page))) { bad.push(page + ': page file is gone'); continue; }
    const src = sourcesOf(page);
    for (const [sec, steps] of stepsOf(page)) for (const st of steps) {
      if (!st.sel) continue;
      for (const sel of [].concat(st.sel)) for (const tok of tokens(sel)) {
        if (!has(src, tok)) bad.push(`${page}${sec ? ' #' + sec : ''} "${st.title}": ${sel} (${tok.k} ${tok.v} not found)`);
      }
    }
  }
  assert.deepEqual(bad, [], 'stale tour steps - update public/page-tours.js:\n  ' + bad.join('\n  '));
});

t('every step is short plain English with a title and a description; 4-8 steps a page, 2-8 a section', () => {
  for (const page of pages) for (const [sec, steps] of stepsOf(page)) {
    const n = steps.length, where = page + (sec ? ' #' + sec : '');
    if (page === 'builder.html') assert.ok(n >= 4 && n <= 24, where + ' (the builder toolbar tour) has ' + n + ' steps');
    else if (sec) assert.ok(n >= 2 && n <= 8, where + ' has ' + n + ' steps (2-8)');
    else assert.ok(n >= 4 && n <= 8, where + ' has ' + n + ' steps (4-8)');
    for (const st of steps) {
      assert.ok(st.title && st.title.length <= 48, where + ': title ' + st.title);
      const d = st.desc; assert.ok(typeof d === 'string' && d.length >= 12 && d.length <= 240, where + ': desc of ' + st.title);
      assert.doesNotMatch(d + st.title, /TODO|lorem|undefined/i, where);
    }
  }
});

console.log(`page-tours-coverage: ${passed} checks OK`);
