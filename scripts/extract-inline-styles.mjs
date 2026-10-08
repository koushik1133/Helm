#!/usr/bin/env node
/* ============================================================================
 * extract-inline-styles.mjs — one-shot, idempotent migration of static
 * style="" attributes (in page MARKUP, not in <script> templates) to classes.
 *
 * Each distinct declaration list becomes ONE class  .s-<hash>  whose selector is
 *     .s-<hash>:not(#_):not(#_):not(#_)        specificity (3,1,0)
 * so it out-ranks every class/ID rule the pages ship — the same cascade
 * position an inline style had — while a later el.style.x = … from JS (a real
 * inline declaration) still wins, exactly as before.
 *
 * Rules are written between markers into the page's shared stylesheet:
 *   theme.css (most pages) · landing.css · builder.css · or, for a page with no
 *   external sheet, appended inside its own first <style> (hash picked up by
 *   scripts/gen-csp.mjs).
 *
 *   node scripts/extract-inline-styles.mjs           # migrate
 *   node scripts/extract-inline-styles.mjs --check   # fail if any static style="" remain
 * ========================================================================== */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
const CHECK = process.argv.includes('--check');
const BEGIN = '/* BEGIN generated: inline-style classes (scripts/extract-inline-styles.mjs) */';
const END = '/* END generated: inline-style classes */';
const SHEETS = ['theme.css', 'landing.css', 'builder.css'];

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const norm = (s) => decode(s).split(';').map((d) => d.trim()).filter(Boolean).map((d) => d.replace(/\s*:\s*/, ':')).join(';');
const cls = (n) => 's-' + createHash('sha1').update(n).digest('hex').slice(0, 7);
const rule = (n) => `.${cls(n)}:not(#_):not(#_):not(#_){${n}}`;

// Split a page into [markup, script/style/comment] segments; only markup is touched.
function segments(src) {
  const re = /<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi;
  const out = []; let last = 0, m;
  while ((m = re.exec(src))) { out.push([false, src.slice(last, m.index)], [true, m[0]]); last = m.index + m[0].length; }
  out.push([false, src.slice(last)]);
  return out;
}
const TAG = /<[a-zA-Z][\w-]*\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const STYLE = /\sstyle\s*=\s*("([^"]*)"|'([^']*)')/i;

// Elements a script later reveals with el.style.display="" — keep them hidden via the
// `hidden` attribute instead of a display:none class (the script is updated to match).
const HIDDEN_VIA_ATTR = new Set(['bookingBadge', 'pay_online']);

const bySheet = new Map(SHEETS.map((s) => [s, new Set()]));
let remaining = 0, converted = 0;
for (const f of readdirSync(PUB).filter((x) => x.endsWith('.html'))) {
  const p = join(PUB, f); const src = readFileSync(p, 'utf8');
  const sheet = SHEETS.find((s) => new RegExp(`href="/?${s.replace('.', '\\.')}`).test(src)) || null;
  const pageRules = new Set();
  const segs = segments(src).map(([skip, txt]) => skip ? txt : txt.replace(TAG, (tag) => {
    const m = tag.match(STYLE); if (!m) return tag;
    remaining++;
    if (CHECK) return tag;
    let n = norm(m[2] ?? m[3]);
    let t = tag.replace(STYLE, '');
    const id = (t.match(/\sid\s*=\s*"([^"]*)"/) || [])[1];
    if (id && HIDDEN_VIA_ATTR.has(id) && /(^|;)display:none(;|$)/.test(n)) {
      n = n.split(';').filter((d) => d !== 'display:none').join(';');
      if (!/\shidden\b/.test(t)) t = t.replace(/\s*(\/?>)$/, ' hidden$1');
    }
    converted++;
    if (!n) return t;
    const c = cls(n); (sheet ? bySheet.get(sheet) : pageRules).add(n);
    if (/\sclass\s*=\s*"/.test(t)) return t.replace(/(\sclass\s*=\s*")([^"]*)"/, (_, a, v) => `${a}${v ? v + ' ' : ''}${c}"`);
    return t.replace(/^(<[a-zA-Z][\w-]*)/, `$1 class="${c}"`);
  }));
  if (CHECK) continue;
  let next = segs.join('');
  if (pageRules.size) {
    const block = `\n${BEGIN}\n${[...pageRules].sort().map(rule).join('\n')}\n${END}\n`;
    next = next.replace(/\n?\/\* BEGIN generated: inline-style classes[\s\S]*?\/\* END generated: inline-style classes \*\/\n?/, '');
    if (!/<\/style>/i.test(next)) throw new Error(f + ': no external sheet and no <style> to host rules');
    next = next.replace(/<\/style>/i, block + '</style>');
  }
  if (next !== src) writeFileSync(p, next);
}
if (CHECK) {
  if (remaining) { console.error(`  ✗ ${remaining} static style="" attribute(s) left in page markup — run node scripts/extract-inline-styles.mjs`); process.exit(1); }
  console.log('  ✓ no static style="" attributes in page markup'); process.exit(0);
}
for (const [s, set] of bySheet) {
  const p = join(PUB, s); let css = readFileSync(p, 'utf8');
  const prev = css.match(/\/\* BEGIN generated: inline-style classes[^\n]*\n([\s\S]*?)\/\* END generated/);
  const old = prev ? prev[1].split('\n').filter(Boolean) : [];
  const all = [...new Set([...old, ...[...set].map(rule)])].sort();
  if (!all.length) continue;
  css = css.replace(/\n?\/\* BEGIN generated: inline-style classes[\s\S]*?\/\* END generated: inline-style classes \*\/\n?/, '');
  writeFileSync(p, css.replace(/\s*$/, '\n') + `\n${BEGIN}\n${all.join('\n')}\n${END}\n`);
}
console.log(`converted ${converted} static style="" attributes`);
