#!/usr/bin/env node
// r23 manual: the user manual is back for every signed-in studio role, PER ROLE, and built from one file per section.
//  1. config.js HELM_FEATURES.manual = true (one flag) - the gated private-bucket page itself is unchanged.
//  2. manual.js hides chapters whose <h2 data-areas> the role can't view (admin sees all; "admin" = admin only),
//     and their sidebar / contents links; fails open when the role can't be read.
//  3. scripts/build-manual.mjs assembles docs/manual/sections/*.md + soon/*.md + r23-*.md between the @gen markers;
//     a feature branch's r23-<feature>.md replaces its "Coming soon" placeholder; --check is up to date.
//  4. the manual covers every feature shipped in R22/R23 and lists the in-flight ones as Coming soon.
// Pure Node, no deps, no network.
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };
const B = await import(new URL('scripts/build-manual.mjs', root));
const MAN = read('docs/manual/USER-MANUAL.html'), MJS = read('public/manual.js');
// strip HTML comments until none are left (a single pass can leave a re-formed "<!--"; CodeQL js/incomplete-multi-character-sanitization)
const stripComments = (s) => { let prev; do { prev = s; s = s.replace(/<!--[\s\S]*?-->/g, ''); } while (s !== prev); return s.replace(/<!--/g, ''); };
const MARKUP = stripComments(MAN);

await t('1 config.js: HELM_FEATURES.manual is true (declared once) - every signed-in role gets the manual', () => {
  const CFG = read('public/config.js');
  const ctx = { window: {}, location: { hostname: 'helm.events' } };
  vm.runInNewContext(CFG, ctx);
  assert.equal(ctx.window.HELM_FEATURES.manual, true);
  assert.equal((CFG.match(/manual: true \}/g) || []).length, 1);
  for (const r of ['admin', 'manager', 'sales', 'coordinator', 'crew']) assert.equal(ctx.window.helmManualFor(r), true, r);
});

await t('2 manual.js: per-role filter runs after sanitising, before showing; fails open; no innerHTML', () => {
  assert.ok(MJS.indexOf('sanitize(doc);') < MJS.indexOf('await filterForRole(host)'));
  assert.ok(MJS.indexOf('await filterForRole(host)') < MJS.indexOf('host.hidden = false'));
  assert.match(MJS, /try \{ await filterForRole\(host\); \} catch \(e\) \{\}/);
  assert.match(MJS, /if \(!role \|\| role === "admin"\) return 0;/);
  assert.match(MJS, /if \(a === "admin"\) return false;/);
  assert.match(MJS, /BPStore\.auth\.canView\(a\)/);
  assert.doesNotMatch(MJS, /innerHTML/);
  assert.match(read('public/manual.css'), /#mDoc \[hidden\]\{display:none!important\}/);
});

// a tiny DOM good enough for filterForRole (nav links, toc items, flat chapters and generated <section class="mch">)
function el(tag, attrs = {}, kids = []) {
  const node = { tagName: tag.toUpperCase(), attrs: { ...attrs }, children: [], parentNode: null, hidden: false,
    classList: { contains: (c) => String(node.attrs.class || '').split(/\s+/).includes(c) },
    getAttribute: (k) => (k in node.attrs ? node.attrs[k] : null), get id() { return node.attrs.id || ''; }, set id(v) { node.attrs.id = v; },
    get nextElementSibling() { const p = node.parentNode; if (!p) return null; const i = p.children.indexOf(node); return p.children[i + 1] || null; },
    closest(sel) { let x = node; while (x) { if ((sel === 'nav' && x.tagName === 'NAV') || (sel === '.toc' && x.classList.contains('toc'))) return x; x = x.parentNode; } return null; },
    querySelectorAll(sel) { const out = []; const walk = (x) => { for (const c of x.children) { if (match(c, sel)) out.push(c); walk(c); } }; walk(node); return out; },
    querySelector(sel) { return node.querySelectorAll(sel)[0] || null; },
    insertBefore(a, ref) { a.parentNode = node; const i = ref ? node.children.indexOf(ref) : node.children.length; node.children.splice(i < 0 ? node.children.length : i, 0, a); } };
  for (const k of kids) { k.parentNode = node; node.children.push(k); }
  return node;
}
function match(x, sel) {
  if (sel === 'h2[data-areas]') return x.tagName === 'H2' && 'data-areas' in x.attrs;
  if (sel === 'nav .grp') return x.classList.contains('grp') && !!x.closest('nav');
  if (sel === '.ver') return x.classList.contains('ver');
  const m = /^a\[href="(#[\w-]+)"\]$/.exec(sel); if (m) return x.tagName === 'A' && x.attrs.href === m[1];
  return false;
}
await t('2b filterForRole (vm): sales sees quotes chapters, not Control Center / admin-only; sidebar + contents follow', async () => {
  const mk = (role, viewable) => {
    const nav = el('nav', {}, [el('div', { class: 'grp' }), el('a', { href: '#intro' }), el('div', { class: 'grp' }), el('a', { href: '#control' }), el('a', { href: '#signup-flow' }),
      el('div', { class: 'grp' }), el('a', { href: '#quotes-list' })]);
    const toc = el('div', { class: 'toc' }, [el('ol', {}, [el('li', {}, [el('a', { href: '#control' })]), el('li', {}, [el('a', { href: '#quotes-list' })])])]);
    const ctl = el('h2', { id: 'control', 'data-areas': 'controls' }), ctlP = el('p'), ctlT = el('div', { class: 'tbl' });
    const sec = el('section', { class: 'mch' }, [el('h2', { id: 'signup-flow', 'data-areas': 'admin' }), el('p')]);
    const ql = el('section', { class: 'mch' }, [el('h2', { id: 'quotes-list', 'data-areas': 'quotes' }), el('p')]);
    const faq = el('h2', { id: 'faq' });
    const host = el('div', {}, [nav, el('span', { class: 'ver' }), toc, el('h2', { id: 'intro' }), el('p'), ctl, ctlP, ctlT, sec, ql, faq, el('p')]);
    const ctx = { BPStore: { auth: { role: async () => role, canView: async (a) => viewable.includes(a), admin: { roleLabel: (r) => r.toUpperCase() } } },
      document: { createElement: (tg) => el(tg) }, Object };
    const src = MJS.slice(MJS.indexOf('  function chapterRun('), MJS.indexOf('  // r20 coord (e): the user manual is hidden for now'));
    vm.runInNewContext(src + '\nglobalThis.f = filterForRole;', ctx);
    return { ctx, host, nav, toc, ctl, ctlP, ctlT, sec, ql, faq };
  };
  let d = mk('sales', ['quotes', 'leads']);
  assert.equal(await d.ctx.f(d.host), 2);
  assert.ok(d.ctl.hidden && d.ctlP.hidden && d.ctlT.hidden, 'flat chapter run hidden up to the next chapter');
  assert.ok(d.sec.hidden, 'admin-only generated chapter hidden');
  assert.ok(!d.ql.hidden && !d.faq.hidden, 'quotes chapter + FAQ stay');
  assert.ok(d.nav.children[3].hidden && d.nav.children[4].hidden && !d.nav.children[6].hidden, 'sidebar links follow');
  assert.ok(d.nav.children[2].hidden && !d.nav.children[0].hidden, 'empty sidebar group heading hidden');
  assert.ok(d.toc.children[0].children[0].hidden && !d.toc.children[0].children[1].hidden, 'contents items follow');
  assert.ok(d.host.querySelectorAll('h2[data-areas]').length === 3 && d.host.children.some((c) => c.attrs.id === 'mRoleNote'), 'role note added');
  d = mk('admin', []); assert.equal(await d.ctx.f(d.host), 0); assert.ok(!d.ctl.hidden && !d.sec.hidden);
  d = mk(null, []); assert.equal(await d.ctx.f(d.host), 0, 'role unknown -> nothing hidden');
  d = mk('crew', []); await d.ctx.f(d.host); assert.ok(d.ctl.hidden && d.ql.hidden && !d.faq.hidden);
});

await t('3 build-manual: USER-MANUAL.html is up to date (--check) and has every marker once', () => {
  execFileSync(process.execPath, [new URL('scripts/build-manual.mjs', root).pathname, '--check'], { stdio: 'pipe' });
  for (const k of ['nav-new', 'nav-soon', 'toc', 'body-new', 'body-soon']) {
    assert.equal((MAN.match(new RegExp(`<!-- @gen:${k} -->`, 'g')) || []).length, 1, k);
    assert.equal((MAN.match(new RegExp(`<!-- /@gen:${k} -->`, 'g')) || []).length, 1, k);
  }
});

await t('3b md(): safe subset - escapes HTML, steps lists, nested bullets, tables, notes, safe links only', () => {
  const h = B.md('## Hi <x>\n1. one\n2. two\n   - sub\n- a\n\n| A | B |\n| --- | --- |\n| 1 | **2** |\n\n> [!SOON] later\n\n[ok](#x) [js](javascript:alert(1)) [web](https://helm.events/a) <script>');
  assert.match(h, /<h3>Hi &lt;x&gt;<\/h3>/);
  assert.match(h, /<ol class="steps"><li>one<\/li><li>two<ul><li>sub<\/li><\/ul><\/li><\/ol>\n<ul><li>a<\/li><\/ul>/);
  assert.match(h, /<table><tr><th>A<\/th><th>B<\/th><\/tr><tr><td>1<\/td><td><b>2<\/b><\/td><\/tr><\/table>/);
  assert.match(h, /<div class="note soonbox">later<\/div>/);
  assert.match(h, /<a class="inl" href="#x">ok<\/a>/);
  assert.doesNotMatch(h, /javascript:|<script/);
  assert.match(h, /href="https:\/\/helm\.events\/a" target="_blank" rel="noopener noreferrer"/);
  assert.equal(B.inline('a - b -> c **x - y**'), 'a — b → c <b>x - y</b>');
});

await t('3c a feature branch drop-in (r23-<feature>.md, no front matter) replaces its placeholder; unknown ones are added', () => {
  const dir = mkdtempSync(join(tmpdir(), 'man-'));
  try {
    mkdirSync(join(dir, 'sections')); mkdirSync(join(dir, 'soon'));
    writeFileSync(join(dir, 'sections', '10-a.md'), '---\nid: a\norder: 10\n---\n# Live A\ntext');
    writeFileSync(join(dir, 'soon', '10-v.md'), '---\nid: quote-validity\ntitle: Valid until\norder: 5\nareas: quotes\nreplaced-by: r23-quote-validity.md\n---\nsoon');
    writeFileSync(join(dir, 'soon', '20-w.md'), '---\nid: crew-shifts\ntitle: Crew\norder: 6\nreplaced-by: r23-crew.md, r23-state-machine.md\n---\nsoon');
    writeFileSync(join(dir, 'soon', '30-x.md'), '---\nid: stages\ntitle: Stages\norder: 7\nreplaced-by: r23-state-machine.md\n---\nsoon');
    let c = B.collect({ dir });
    assert.deepEqual(c.live.map((s) => s.id), ['a']); assert.deepEqual(c.soon.map((s) => s.id), ['quote-validity', 'crew-shifts', 'stages']);
    writeFileSync(join(dir, 'r23-quote-validity.md'), '# Quote validity ("Valid until")\n\nEvery new quote...');
    writeFileSync(join(dir, 'r23-state-machine.md'), '# States\nx');
    writeFileSync(join(dir, 'r23-brand-new.md'), '# Brand new\nx');
    c = B.collect({ dir });
    const v = c.live.find((s) => s.src === 'r23-quote-validity.md');
    assert.equal(v.id, 'quote-validity'); assert.deepEqual(v.areas, ['quotes']); assert.equal(v.title, 'Quote validity ("Valid until")');
    assert.equal(c.live.find((s) => s.src === 'r23-state-machine.md').id, 'crew-shifts', 'a drop-in replaces ONE placeholder only');
    assert.deepEqual(c.soon.map((s) => s.id), ['stages']);
    assert.equal(c.live.find((s) => s.src === 'r23-brand-new.md').id, 'brand-new');
    const only = B.collect({ dir, only: new Set(['r23-quote-validity.md']) });
    assert.deepEqual(only.skipped.sort(), ['r23-brand-new.md', 'r23-state-machine.md'], '--check reports new drop-ins instead of failing');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await t('4 manual covers what shipped (R22/R23) and marks in-flight features Coming soon', () => {
  const LIVE = { 'signup-flow': ['Pay now', 'Try free for 8 days', 'Contact sales', 'Payment pending', 'UTR', 'plus GST', '₹4,999'],
    'two-step': ['Scan this QR code', 'Verify &amp; turn on', 'not shown during the free trial', 'security@helm.events', 'Helm support (HQ)'],
    'quotes-list': ['Cancelled', 'Filter by event date', 'Next 30 days', 'Smart search', '+ Save view', 'Share with studio'],
    'share-approval': ['Share with client &amp; approval', 'Send for approval →', 'Ask the client to approve', 'Record advance payment', 'Event-day command'],
    'invitation-studio': ['Helm music library (free to use)', 'Festive Dhol', 'Full background', 'Behind names', '7 days after the event'],
    'closing-event': ['Closure summary', 'Before you close', 'Request to close anyway…', 'Approve &amp; close', 'Withdraw my request'],
    'profit-wages': ['staff &amp; crew wages', 'Replaced by crew wages', 'Recorded numbers (legacy)'],
    'team-members': ['Role updated.', 'Incomplete profiles', 'Pending invites', 'seats used'],
    'on-your-phone': ['Alerts', 'Create', 'Thu, 29 Oct 2026'] };
  for (const [id, words] of Object.entries(LIVE)) {
    const at = MARKUP.indexOf(`<h2 id="${id}"`); assert.ok(at > 0, id);
    const sec = MARKUP.slice(at, MARKUP.indexOf('</section>', at));
    assert.doesNotMatch(sec.slice(0, 300), /Coming soon/, id + ' is live');
    for (const w of words) assert.ok(sec.includes(w), `${id} mentions ${w}`);
  }
  // r23 staging: a chapter is live once its branch's docs/manual/r23-*.md is in; the rest stay "Coming soon"
  const R23_LIVE = { 'link-views': 'r23-link-views.md', 'quote-validity': 'r23-quote-validity.md', 'quote-stages': 'r23-state-machine.md',
    'payment-schedules': 'r23-payment-schedules.md', 'crew-shifts': 'r23-crew.md', 'notification-inbox': 'r23-inbox.md' };
  for (const [id, src] of Object.entries(R23_LIVE)) {
    const at = MARKUP.indexOf(`<h2 id="${id}"`); assert.ok(at > 0, id);
    assert.doesNotMatch(MARKUP.slice(at, at + 400), /Coming soon/, id + ' is live');
    assert.ok(MAN.includes(`data-src="${src}"`), id + ' built from ' + src);
  }
  for (const id of ['vendor-requests', 'studio-link', 'cancelled-links']) {
    const at = MARKUP.indexOf(`<h2 id="${id}"`); assert.ok(at > 0, id);
    assert.match(MARKUP.slice(at, at + 400), /<span class="soon">Coming soon<\/span><\/h2>\n<div class="note soonbox">/, id);
  }
  // per-role tags on the core chapters + generated ones; admin-only where it should be
  for (const [id, a] of [['control', 'controls'], ['billing', 'admin'], ['quote', 'quotes'], ['budget', 'finance'], ['signup-flow', 'admin'], ['team-members', 'admin']])
    assert.match(MARKUP, new RegExp(`<h2 id="${id}" data-areas="${a}"`), id);
  for (const id of ['intro', 'around', 'dashboard', 'faq', 'two-step', 'on-your-phone']) assert.match(MARKUP, new RegExp(`<h2 id="${id}">`), id + ' is for everyone');
  assert.doesNotMatch(MARKUP, /<script|\son\w+=|javascript:/i);
  for (const m of MARKUP.matchAll(/href="#([\w-]+)"/g)) assert.ok(MARKUP.includes(`id="${m[1]}"`), 'dangling #' + m[1]);
});
console.log(`\nr23-manual: ${n} passed`);
