// Dashboard first-run tour: ~22 short steps in on-screen reading order, each anchored to a real data-tour element
// emitted by the shell (shell-b*.js / mobile-nav.js / dashboard.html).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const r = (p) => readFileSync(new URL('../public/' + p, import.meta.url), 'utf8');
const D = r('dashboard.html');
const SRC = ['shell-b.js', 'shell-b-dash.js', 'shell-b-privacy.js', 'mobile-nav.js', 'dashboard.html'].map(r).join('\n');
const block = D.slice(D.indexOf('const TOUR=['), D.indexOf('];', D.indexOf('const TOUR=[')));
const steps = block.split('\n').filter((l) => /^\s*\{.*title:/.test(l));
assert.ok(steps.length >= 18 && steps.length <= 24, 'tour has 18-24 steps, got ' + steps.length);
assert.match(steps[0], /Welcome/); assert.match(steps[0], /TOUR_TRIAL\(\) \? TOUR_WELCOME\.trial : TOUR_WELCOME\.paid/);
// welcome wording: the trial variant mentions the 8-day trial + "Demo ·" sample data; the paid
// ("Create studio") variant must not mention a trial or sample data
const W = D.slice(D.indexOf('const TOUR_WELCOME={'), D.indexOf('};', D.indexOf('const TOUR_WELCOME={')));
const trialW = /trial:"([^"]+)"/.exec(W)[1], paidW = /paid:"([^"]+)"/.exec(W)[1];
assert.match(trialW, /8-day trial/); assert.match(trialW, /Demo ·/);
assert.match(paidW, /quick look around your studio/);
assert.doesNotMatch(paidW, /trial|sample data|Demo ·/i);
assert.match(steps[steps.length - 1], /Take a guided tour/);
const anchors = [...block.matchAll(/\[data-tour="([\w-]+)"\]/g)].map((m) => m[1]);
for (const a of new Set(anchors)) {
  const tagged = SRC.includes('"data-tour", "' + a + '"') || SRC.includes('data-tour="' + a + '"') || SRC.includes('"data-tour": "' + a + '"')
    || (a.startsWith('m-') && SRC.includes('"data-tour", "m-" + id'));
  assert.ok(tagged, 'anchor data-tour="' + a + '" is emitted somewhere');
}
for (const k of ['pin', 'nav-manage', 'nav-admin', 'theme', 'account', 'search', 'privacy', 'chat', 'bell', 'new', 'today', 'hero', 'customize', 'kpis', 'setup']) assert.ok(anchors.includes(k), k);
// sidebar items are anchored by their data-nav key (shell-b.js item())
const navKeys = [...block.matchAll(/\[data-nav="([\w-]+)"\]/g)].map((m) => m[1]);
assert.deepEqual(navKeys, ['dashboard', 'quotes', 'leads', 'calendar', 'chat']);
assert.match(r('shell-b.js'), /a\.setAttribute\("data-nav", key\)/);
console.log('dashboard-tour-steps: ok (' + steps.length + ' steps)');
