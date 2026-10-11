// Design Studio (design.html) = the floor-plan sign-off track, not a template store. The page says so,
// links to where templates really live (Layout templates / builder "My templates" / Invitation Studio)
// and never opens the builder's built-in default layout by mistake.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const h = read('public/design.html'), st = read('public/studio-templates.js'), ctl = read('public/control.html');
const t = (n, f) => { f(); console.log('  ✓ ' + n); };
t('one-line purpose at the top + where templates live', () => {
  assert.match(h, /<p class="purpose" id="dsPurpose"><b>What this is for:<\/b> the Design Studio is the sign-off track/);
  assert.match(h, /It doesn't store templates\./);
  assert.match(h, /href="control\.html#ltemplates">Layout templates<\/a>/);
  assert.match(h, /href="builder\.html\?new=1&amp;tplEdit=new">start a new template<\/a>/);
  assert.match(h, /Invitation Studio/);
});
t('builder links open a blank floor (?new=1), never the built-in default layout', () => {
  for (const m of h.matchAll(/href="builder\.html([^"]*)"/g)) assert.ok(/new=1|\?quote=/.test(m[1]), m[0]);
  assert.match(h, /builder\.html\?quote=\$\{esc\(encodeURIComponent\(quoteId\)\)\}/);
  assert.match(read('public/builder.js'), /store\.items = \(isNew\|\|quoteId\) \? \[\] : TEMPLATES\.political\(\)/);
});
t('empty state explains the queue and offers a real next step', () => {
  assert.match(h, /No events are in design review yet\./); assert.match(h, /Pick an event from Quotes/);
});
t('single design view links to the event\'s invitation website', () => {
  assert.match(h, /invite-studio\.html\?quote=\$\{esc\(encodeURIComponent\(quoteId\)\)\}/);
});
t('the real template store (0096) still has create / edit / duplicate / archive + deep links', () => {
  assert.match(st, /newHref: "builder\.html\?new=1&tplEdit=new"/);
  assert.match(st, /editHref: function \(r\) \{ return "builder\.html\?new=1&tplEdit=" \+ encodeURIComponent\(r\.id\)/);
  assert.match(st, /G\.location\.hash === "#ltemplates"/); assert.match(ctl, /id="tab-ltemplates"/);
  const api = read('public/store-api.js');
  for (const r of ['studio_template_save', 'studio_template_set_archived', 'studio_template_duplicate']) assert.ok(api.includes(r), r);
});
console.log('design-studio: ok');
