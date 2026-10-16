// Dashboard first-run tour: ~12 friendly steps, each anchored to a real data-tour element
// emitted by the shell (shell-b*.js / mobile-nav.js / dashboard.html).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const r = (p) => readFileSync(new URL('../public/' + p, import.meta.url), 'utf8');
const D = r('dashboard.html');
const SRC = ['shell-b.js', 'shell-b-dash.js', 'shell-b-privacy.js', 'mobile-nav.js', 'dashboard.html'].map(r).join('\n');
const block = D.slice(D.indexOf('const TOUR=['), D.indexOf('];', D.indexOf('const TOUR=[')));
const steps = block.split('\n').filter((l) => /^\s*\{.*title:/.test(l));
assert.ok(steps.length >= 10 && steps.length <= 13, 'tour has 10-13 steps, got ' + steps.length);
assert.match(steps[0], /Welcome/); assert.match(steps[0], /8-day trial/); assert.match(steps[0], /Demo ·/);
assert.match(steps[steps.length - 1], /Take a guided tour/);
const anchors = [...block.matchAll(/\[data-tour="([\w-]+)"\]/g)].map((m) => m[1]);
for (const a of new Set(anchors)) {
  const tagged = SRC.includes('"data-tour", "' + a + '"') || SRC.includes('data-tour="' + a + '"') || SRC.includes('"data-tour": "' + a + '"')
    || (a.startsWith('m-') && SRC.includes('"data-tour", "m-" + id'));
  assert.ok(tagged, 'anchor data-tour="' + a + '" is emitted somewhere');
}
for (const k of ['nav', 'pin', 'search', 'new', 'bell', 'chat', 'privacy', 'today', 'setup', 'theme', 'account']) assert.ok(anchors.includes(k), k);
console.log('dashboard-tour-steps: ok (' + steps.length + ' steps)');
