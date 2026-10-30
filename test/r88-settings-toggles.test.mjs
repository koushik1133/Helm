// r88: Settings toggles use one shared switch that outranks the 16px card-checkbox rule; inbox card is a tidy form.
import { test } from 'node:test'; import assert from 'node:assert/strict'; import { readFileSync } from 'node:fs';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
test('shared switch outranks control-split 16px checkbox rule and is accessible', () => {
  const c = r('public/automations.css');
  assert.match(r('public/control-split.css'), /#app\.cs-on \.cs-main \.card input\[type=checkbox\]\{width:16px/);
  assert.match(c, /#app\.cs-on \.cs-main \.card input\[type=checkbox\]\[role=switch\]\{[^}]*width:44px[^}]*height:24px/);
  assert.match(c, /\[role=switch\]::before[^{]*\{[^}]*top:-10px;bottom:-10px/, '44px hit area');
  assert.match(c, /\[role=switch\]:checked[^{]*\{background:var\(--accent/);
  assert.match(c, /\[role=switch\]:focus-visible/); assert.match(c, /prefers-reduced-motion:reduce\)\{#app \.card input\[type=checkbox\]\[role=switch\]/);
  assert.match(r('public/automations.js'), /cls: "au-sw", role: "switch"/);
});
test('inbox card: label above each control, same text and ids', () => {
  const j = r('public/inbox-settings.js'), c = r('public/automations.css');
  for (const t of ['Default for the team', 'Daily digest at (studio time)', 'Only items unread for at least']) assert.ok(j.includes('cls: "ibs-lbl", text: "' + t + '"'), t);
  for (const id of ['ibs_def', 'ibs_hour', 'ibs_age', 'ibs_bell', 'ibs_save']) assert.ok(j.includes(id), id);
  assert.match(c, /#inboxCard \.ibs-grid\{display:grid;grid-template-columns:repeat\(3/); assert.match(c, /max-width:720px\)\{#inboxCard \.ibs-grid\{grid-template-columns:1fr/);
  assert.match(r('public/control.html'), /automations\.css\?v=4/); assert.match(r('public/control.html'), /inbox-settings\.js\?v=4/);
});
