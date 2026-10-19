#!/usr/bin/env node
/* ============================================================================
 * build-manual.mjs - assemble the signed-in user manual from one file per section.
 *
 *   node scripts/build-manual.mjs          rewrite docs/manual/USER-MANUAL.html
 *   node scripts/build-manual.mjs --check  exit 1 if the HTML is out of date (CI)
 *
 * The manual (docs/manual/USER-MANUAL.html, served by /manual from the private
 * "helm-manual" bucket) has hand-written core chapters plus GENERATED chapters
 * between marker comments:
 *   <!-- @gen:nav-new --> ... <!-- /@gen:nav-new -->     sidebar links, "New & updated"
 *   <!-- @gen:nav-soon --> ... <!-- /@gen:nav-soon -->   sidebar links, "Coming soon"
 *   <!-- @gen:toc --> ... <!-- /@gen:toc -->             second contents box
 *   <!-- @gen:body-new --> ... <!-- /@gen:body-new -->   chapters for live features
 *   <!-- @gen:body-soon --> ... <!-- /@gen:body-soon --> "Coming soon" chapters
 *
 * Sources (Markdown, a small safe subset - see md() below):
 *   docs/manual/sections/*.md   live chapters
 *   docs/manual/soon/*.md       "Coming soon" placeholders
 *   docs/manual/r23-*.md        a chapter written by a feature branch. It needs NO front matter: the id comes
 *                               from the file name (r23-quote-validity.md -> quote-validity), the title from its
 *                               first "# " line. If a placeholder lists that file name in "replaced-by", the
 *                               feature chapter takes the placeholder's place (same id, group, order, areas),
 *                               so links keep working and the "Coming soon" box disappears.
 *
 * Optional front matter at the top of a file:
 *   ---
 *   id: closure-checklist          anchor (#closure-checklist); default = file name
 *   title: Closing an event        default = the first "# " heading
 *   nav: Closing an event          shorter sidebar label (default = title)
 *   order: 30                      sort key inside its group (default 500)
 *   areas: closure, finance        role areas (Control Center -> Roles & access). A signed-in user whose role
 *                                  can view NONE of them does not see the chapter; admins see everything;
 *                                  no "areas" = everyone. Use "admin" for admin-only chapters.
 *   replaced-by: r23-quote-validity.md, r23-validity.md    (placeholders only)
 *   ---
 *
 * Adding a new feature chapter: drop docs/manual/r23-<feature>.md in, run this script, commit both files.
 * --check only compares the chapters the HTML already includes; a NEW r23-*.md that is not built in yet is
 * reported as a warning (exit 0), so merging a feature branch never breaks CI - run the script to include it.
 * Pure Node, no deps. The output never contains <script>, inline handlers or remote URLs.
 * ========================================================================== */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'docs/manual');
const OUT = join(DIR, 'USER-MANUAL.html');
const CHECK = process.argv.includes('--check');

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// inline: escape first, then a few safe marks. Links: only #anchors, relative app pages or https.
export function inline(s) {
  let t = esc(s);
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000'; });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
    const h = href.replace(/&amp;/g, '&');
    if (/^#[\w-]+$/.test(h) || /^[\w-]+(\.html)?(#[\w-]+)?$/.test(h)) return `<a class="inl" href="${esc(h)}">${label}</a>`;
    if (/^https:\/\/[\w.-]+(\/[\w./#?=&%-]*)?$/.test(h)) return `<a class="inl" href="${esc(h)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    return label;
  });
  // plain-text dashes become typographic ones - but never inside <b>…</b> (those quote real UI labels)
  t = t.split(/(<b>[^<]*<\/b>)/).map((part, k) => (k % 2 ? part : part.replace(/ -&gt; /g, ' → ').replace(/ - /g, ' — '))).join('');
  t = t.replace(/ -&gt; /g, ' → ');
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
  return t;
}

// block Markdown subset: ## / ### headings, paragraphs, - bullets (nested by indent), 1. steps,
// | tables |, > notes, "> [!SOON]" / "> [!WARN]" boxes. Anything else is plain text (escaped).
export function md(src) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const isList = (l) => /^\s*([-*]|\d+[.)])\s+/.test(l);
  const isBlockStart = (l) => /^#{1,4}\s/.test(l) || /^\s*\|/.test(l) || /^>\s?/.test(l) || isList(l);
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = /^(#{2,4})\s+(.*)$/.exec(l))) {
      const lv = Math.min(4, m[1].length + 1);
      out.push(`<h${lv}>${inline(m[2].trim())}</h${lv}>`); i++; continue;
    }
    if (/^#\s/.test(l)) { i++; continue; }              // the title line is the chapter heading
    if (/^\s*\|/.test(l)) {                            // table
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r) => r.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const body = rows.filter((r) => !/^\s*\|?\s*:?-{3,}/.test(r));
      const head = rows.length > 1 && /^\s*\|?\s*:?-{3,}/.test(rows[1]) ? body.shift() : null;
      let h = '<div class="tbl"><table>';
      if (head) h += '<tr>' + cells(head).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr>';
      for (const r of body) h += '<tr>' + cells(r).map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>';
      out.push(h + '</table></div>'); continue;
    }
    if (/^>\s?/.test(l)) {                             // note box
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^>\s?/, '')); i++; }
      let cls = 'note';
      if (/^\[!SOON\]/i.test(buf[0])) { cls = 'note soonbox'; buf[0] = buf[0].replace(/^\[!SOON\]\s*/i, ''); }
      else if (/^\[!WARN(ING)?\]/i.test(buf[0])) { cls = 'warn'; buf[0] = buf[0].replace(/^\[!WARN(ING)?\]\s*/i, ''); }
      out.push(`<div class="${cls}">${inline(buf.join(' ').trim())}</div>`); continue;
    }
    if (isList(l)) {                                   // (nested) lists
      const items = [];
      while (i < lines.length && lines[i].trim() && (isList(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        const L = lines[i];
        const lm = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(L);
        if (lm) items.push({ ind: lm[1].length, ord: /\d/.test(lm[2]), text: lm[3] });
        else if (items.length) items[items.length - 1].text += ' ' + L.trim();
        i++;
      }
      let k = 0;
      const render = (ind) => {
        const first = items[k];
        const tag = first.ord ? 'ol' : 'ul';
        let h = first.ord && ind === 0 ? '<ol class="steps">' : `<${tag}>`;
        while (k < items.length && items[k].ind >= ind && !(items[k].ind === ind && items[k].ord !== first.ord)) {
          if (items[k].ind > ind) { h = h.replace(/<\/li>$/, '') + render(items[k].ind) + '</li>'; continue; }
          h += `<li>${inline(items[k].text)}</li>`; k++;
        }
        return h + `</${tag}>`;
      };
      while (k < items.length) out.push(render(items[k].ind));
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) { buf.push(lines[i].trim()); i++; }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

export function parse(file, text) {
  const meta = {};
  let body = text.replace(/^﻿/, '');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(body.replace(/\r\n?/g, '\n'));
  if (fm) {
    for (const line of fm[1].split('\n')) { const m = /^([\w-]+):\s*(.*)$/.exec(line); if (m) meta[m[1].toLowerCase()] = m[2].trim(); }
    body = body.replace(/\r\n?/g, '\n').slice(fm[0].length);
  }
  const name = basename(file).replace(/\.md$/, '');
  const h1 = /^#\s+(.+)$/m.exec(body);
  const id = (meta.id || name.replace(/^r23-/, '')).toLowerCase().replace(/[^\w-]+/g, '-');
  const title = meta.title || (h1 ? h1[1].trim() : name);
  const list = (v) => String(v || '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  return { file, name, id, title, nav: meta.nav || title, order: Number(meta.order || 500), areas: list(meta.areas),
    replacedBy: list(meta['replaced-by']), body };
}

const readDir = (d, re) => existsSync(d) ? readdirSync(d).filter((f) => re.test(f)).sort().map((f) => join(d, f)) : [];

export function collect({ only, dir = DIR } = {}) {
  const live = readDir(join(dir, 'sections'), /\.md$/).map((f) => ({ ...parse(f, readFileSync(f, 'utf8')), soon: false, src: 'sections/' + basename(f) }));
  const soon = readDir(join(dir, 'soon'), /\.md$/).map((f) => ({ ...parse(f, readFileSync(f, 'utf8')), soon: true, src: 'soon/' + basename(f) }));
  let feats = readDir(dir, /^r23-[\w-]+\.md$/).map((f) => ({ ...parse(f, readFileSync(f, 'utf8')), soon: false, src: basename(f) }));
  const skipped = [];
  if (only) { skipped.push(...feats.filter((f) => !only.has(f.src)).map((f) => f.src)); feats = feats.filter((f) => only.has(f.src)); }
  const soonLeft = [], used = new Set();
  for (const p of soon) {
    const hit = feats.find((f) => !used.has(f) && (p.replacedBy.includes(f.src) || f.id === p.id));
    if (hit) used.add(hit);
    if (hit) Object.assign(hit, { id: p.id, order: p.order, areas: hit.areas.length ? hit.areas : p.areas, replaces: p.src });
    else soonLeft.push(p);
  }
  const all = [...live, ...feats, ...soonLeft];
  const seen = new Set();
  for (const s of all) { if (seen.has(s.id)) throw new Error('duplicate manual section id: ' + s.id + ' (' + s.src + ')'); seen.add(s.id); }
  const by = (a, b) => a.order - b.order || a.src.localeCompare(b.src);
  return { live: [...live, ...feats].sort(by), soon: soonLeft.sort(by), skipped };
}

function chapter(s) {
  const areas = s.areas.length ? ` data-areas="${esc(s.areas.join(','))}"` : '';
  const tag = s.soon ? ' <span class="soon">Coming soon</span>' : '';
  const box = s.soon ? '\n<div class="note soonbox"><b>Coming soon.</b> This feature is being built. What is written here is a preview and may change before it goes live.</div>' : '';
  return `<section class="mch" data-src="${esc(s.src)}">\n<h2 id="${esc(s.id)}"${areas}>${inline(s.title)}${tag}</h2>${box}\n${md(s.body)}\n</section>`;
}
const navLinks = (list, grp) => list.length ? `<div class="grp">${grp}</div>\n` + list.map((s) => `      <a href="#${esc(s.id)}">${inline(s.nav)}</a>`).join('\n') : '';
function toc(live, soon) {
  const li = (s) => `        <li><a href="#${esc(s.id)}">${inline(s.title)}</a></li>`;
  return `<div class="toc toc-gen">\n      <b>New &amp; updated</b>\n      <ol>\n${live.map(li).join('\n')}\n      </ol>\n` +
    (soon.length ? `      <b>Coming soon</b>\n      <ol>\n${soon.map(li).join('\n')}\n      </ol>\n` : '') + '    </div>';
}

export function build(html, opts) {
  const { live, soon, skipped } = collect(opts);
  const put = (h, key, val) => {
    const re = new RegExp(`(<!-- @gen:${key} -->)[\\s\\S]*?(<!-- /@gen:${key} -->)`);
    if (!re.test(h)) throw new Error('marker missing in USER-MANUAL.html: @gen:' + key);
    return h.replace(re, (_, a, b) => `${a}\n${val}\n${b}`);
  };
  let h = html;
  h = put(h, 'nav-new', navLinks(live, 'New &amp; updated'));
  h = put(h, 'nav-soon', navLinks(soon, 'Coming soon'));
  h = put(h, 'toc', toc(live, soon));
  h = put(h, 'body-new', live.map(chapter).join('\n\n'));
  h = put(h, 'body-soon', soon.map(chapter).join('\n\n'));
  return { html: h, live, soon, skipped };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cur = readFileSync(OUT, 'utf8');
  if (CHECK) {
    const included = new Set([...cur.matchAll(/data-src="(r23-[\w-]+\.md)"/g)].map((m) => m[1]));
    const { html, skipped } = build(cur, { only: included });
    for (const s of skipped) console.warn(`build-manual: docs/manual/${s} is not in the manual yet - run node scripts/build-manual.mjs`);
    if (html !== cur) { console.error('build-manual: docs/manual/USER-MANUAL.html is out of date - run node scripts/build-manual.mjs'); process.exit(1); }
    console.log('build-manual: USER-MANUAL.html is up to date');
  } else {
    const { html, live, soon } = build(cur);
    if (html !== cur) writeFileSync(OUT, html);
    console.log(`build-manual: ${live.length} live + ${soon.length} coming-soon generated chapters${html !== cur ? ' (written)' : ' (no change)'}`);
  }
}
