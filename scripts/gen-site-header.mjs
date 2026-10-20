#!/usr/bin/env node
/* gen-site-header.mjs - r23: ONE public header. The home page (public/index.html) is the source of truth:
 * its logo, Product / Solutions / Resources / Pricing menus, "Sign in" and "Start free trial" are copied
 * into every other public page (pricing, about, services, the legal pages) with the classes renamed to
 * the sh-* namespace (site-header.css / site-header.js) so they never collide with the page's own CSS,
 * and the in-page links (#modules) pointed back at the home page (/#modules).
 *   node scripts/gen-site-header.mjs          rewrite the pages
 *   node scripts/gen-site-header.mjs --check  exit 1 if any page's header is stale
 * Edit the home page header, then run this. No innerHTML at runtime: the header is static markup. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
export const CSS_HREF = '/site-header.css?v=1';
export const JS_SRC = '/site-header.js?v=1';
export const MARK_START = '<!-- site-header: generated from index.html by scripts/gen-site-header.mjs - do not edit here -->';
export const MARK_END = '<!-- /site-header -->';
/* legal pages keep their fixed glass bar (their hero is padded for it); the marketing pages use a sticky bar */
export const PAGES = {
  'pricing.html': 'sticky', 'about.html': 'sticky', 'services.html': 'sticky', 'contact-sales.html': 'sticky', 'suggest.html': 'sticky',
  'privacy.html': 'fixed', 'terms.html': 'fixed', 'refund-policy.html': 'fixed', 'data-deletion.html': 'fixed',
  'cookie-policy.html': 'fixed', 'dpa.html': 'fixed', 'acceptable-use.html': 'fixed', 'accessibility.html': 'fixed',
  'ai-notice.html': 'fixed', 'copyright.html': 'fixed', 'grievance.html': 'fixed', 'security.html': 'fixed',
  'sla.html': 'fixed', 'subprocessors.html': 'fixed',
};

const CLASS_MAP = {
  menu: 'sh-menu', mlist: 'sh-list', mi: 'sh-mi', 'has-mega': '', mlink: 'sh-link', mega: 'sh-mega', sm: 'sh-sm',
  'mega-in': 'sh-mega-in', 'mg-grid': 'sh-grid', two: 'sh-two', 'mg-item': 'sh-item', ic: 'sh-ic', 'mg-feat': 'sh-feat',
  'm-cta': 'sh-mcta', btn: 'sh-btn', 'btn-line': 'sh-btn-line', 'btn-dark': 'sh-btn-dark', 'btn-pill': 'sh-btn-pill',
  bi: 'sh-bi', brand: 'sh-brand', 'nav-act': 'sh-act', signin: 'sh-signin', burger: 'sh-burger',
  lockup: 'sh-lockup', 'hl-logo': 'hl-logo', 'hl-ring': 'hl-ring', 'hl-ink': 'hl-ink', 'hl-acc': 'hl-acc',
};
function renameClasses(html) {
  return html.replace(/class="([^"]*)"/g, (_, v) => {
    const out = v.split(/\s+/).filter(Boolean).map((t) => {
      if (!(t in CLASS_MAP)) throw new Error('gen-site-header: unknown class "' + t + '" in the home header - add it to CLASS_MAP');
      return CLASS_MAP[t];
    }).filter(Boolean);
    return 'class="' + out.join(' ') + '"';
  });
}
// home in-page anchors -> the home page; the two plan cards -> the full pricing page
function homeHref(h) {
  if (h === '#pricing') return '/pricing';
  if (h === '#top') return '/';
  if (/^#[a-z][a-z0-9-]*$/.test(h)) return '/' + h;
  return h;
}

/* the home page's HELM lockup (svg), with its mask id namespaced - also used by gen-try.mjs for /try's top bar */
export function homeLockup(indexHtml, prefix, cls) {
  const m = indexHtml.match(/<header class="nav" id="top"><div class="nav-bar">\s*<a class="brand"[^>]*>(<svg class="lockup hl-logo"[\s\S]*?<\/svg>)<\/a>/);
  if (!m) throw new Error('gen-site-header: cannot find the home page logo');
  return m[1].replace(/id="hlm-gap-h"/, 'id="' + prefix + '-hlm-gap"').replace(/url\(#hlm-gap-h\)/, 'url(#' + prefix + '-hlm-gap)')
    .replace('class="lockup hl-logo"', 'class="' + cls + ' hl-logo"');
}

export function buildHeader(indexHtml, mode) {
  const hdr = (indexHtml.match(/<header class="nav" id="top"><div class="nav-bar">([\s\S]*?)<\/div><\/header>/) || [])[1];
  if (!hdr) throw new Error('gen-site-header: cannot find the home page <header class="nav" id="top">');
  let h = hdr.trim();
  h = h.replace(/(<(?!use\b)[a-z]+[^>]*?\shref=")(#[^"]*)"/g, (_, pre, x) => pre + homeHref(x) + '"');
  h = h.replace(/id="menu"/, 'id="shMenu"').replace(/aria-controls="menu"/, 'aria-controls="shMenu"');
  h = h.replace(/(id|aria-controls)="mg-([a-z]+)"/g, '$1="sh-mg-$2"');
  h = h.replace(/id="hlm-gap-h"/, 'id="sh-hlm-gap"').replace(/url\(#hlm-gap-h\)/, 'url(#sh-hlm-gap)');
  h = renameClasses(h);
  // sprite: only the icons the header uses, ids namespaced
  const used = [...new Set([...h.matchAll(/<use href="#(i-[a-z0-9-]+)"\/>/g)].map((m) => m[1]))];
  const syms = used.map((id) => {
    const m = indexHtml.match(new RegExp('<symbol id="' + id + '" [^>]*>[\\s\\S]*?<\\/symbol>'));
    if (!m) throw new Error('gen-site-header: the home sprite has no symbol ' + id);
    return m[0].replace('id="' + id + '"', 'id="sh-' + id + '"');
  });
  h = h.replace(/<use href="#(i-[a-z0-9-]+)"\/>/g, '<use href="#sh-$1"/>');
  const cls = mode === 'fixed' ? 'sh sh-fixed' : 'sh';
  return MARK_START + '\n<header class="' + cls + '" id="top">\n<svg class="sh-sprite" aria-hidden="true" focusable="false"><defs>\n'
    + syms.join('\n') + '\n</defs></svg>\n<div class="sh-bar">\n' + h + '\n</div></header>\n' + MARK_END;
}

/* replace the marked block (or, the first time, the page's first <header>...</header>), and make sure the page
   loads site-header.css + site-header.js */
export function applyTo(page, block) {
  let out = page;
  const s = out.indexOf(MARK_START), e = out.indexOf(MARK_END);
  if (s >= 0 && e > s) out = out.slice(0, s) + block + out.slice(e + MARK_END.length);
  else {
    const m = out.match(/[ \t]*<header[\s>][\s\S]*?<\/header>/);
    if (!m) throw new Error('gen-site-header: page has no <header>');
    out = out.replace(m[0], block);
  }
  if (!/href="\/site-header\.css\?v=\d+"/.test(out)) out = out.replace('</head>', '<link rel="stylesheet" href="' + CSS_HREF + '">\n</head>');
  if (!/src="\/site-header\.js\?v=\d+"/.test(out)) out = out.replace('</body>', '<script src="' + JS_SRC + '" defer></script>\n</body>');
  return out;
}

function main() {
  const check = process.argv.includes('--check');
  const index = readFileSync(join(PUB, 'index.html'), 'utf8');
  let stale = 0;
  for (const [f, mode] of Object.entries(PAGES)) {
    const p = join(PUB, f), cur = readFileSync(p, 'utf8');
    const next = applyTo(cur, buildHeader(index, mode));
    if (next === cur) continue;
    if (check) { console.error('gen-site-header: ' + f + ' is stale - run node scripts/gen-site-header.mjs'); stale++; }
    else { writeFileSync(p, next); console.log('gen-site-header: wrote ' + f); }
  }
  if (check && stale) process.exit(1);
  if (check) console.log('gen-site-header: ' + Object.keys(PAGES).length + ' pages up to date');
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
