// Tour auto-starts only once per ACCOUNT (server-side flag), right after a new
// studio sign-up / an invited member's first login — never on normal sign-ins
// or on a new device. Static checks on dashboard.html + store-api.js.
import { test as t } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const D = readFileSync(join(ROOT, 'public', 'dashboard.html'), 'utf8');
const S = readFileSync(join(ROOT, 'public', 'store-api.js'), 'utf8');
const L = readFileSync(join(ROOT, 'public', 'login.html'), 'utf8');

t('store-api keeps the tour flag on the account (user_metadata), not only localStorage', () => {
  assert.match(S, /tourSeen:\s*\(\)\s*=>/);
  assert.match(S, /markTourSeen:\s*async/);
  assert.match(S, /updateUser\(\{\s*data:\s*\{\s*helm_tour_seen:\s*true\s*\}\s*\}\)/);
  assert.match(S, /tourEligible:/);
});

t('dashboard no longer auto-starts just because this browser lacks bp_seen_tour', () => {
  assert.doesNotMatch(D, /if\(forced \|\| !localStorage\.getItem\("bp_seen_tour"\)\)/);
  assert.match(D, /if\(seen \|\| \(!forced && !eligible\)\) return;/);
  assert.match(D, /A\.markTourSeen\(\)/);
  // marked seen BEFORE starting (leaving mid-tour must not re-trigger it)
  assert.ok(D.indexOf('A.markTourSeen()') < D.indexOf('startTour();\n    })();'));
});

t('manual Tour button still wired; signup still forces it', () => {
  assert.match(D, /\$\("#helpBtn"\)\.addEventListener\("click", startTour\)/);
  assert.ok((L.match(/bp_force_tour","1"/g) || []).length >= 2);
});

// behavioural: simulate the decision for each scenario
function decide({ seen, forced, eligible }) { return !(seen || (!forced && !eligible)); }
t('decision table', () => {
  assert.equal(decide({ seen: false, forced: true, eligible: true }), true);   // brand-new signup
  assert.equal(decide({ seen: false, forced: false, eligible: true }), true);  // invited member first login
  assert.equal(decide({ seen: true, forced: false, eligible: true }), false);  // later sign-in / new device
  assert.equal(decide({ seen: true, forced: true, eligible: true }), false);
  assert.equal(decide({ seen: false, forced: false, eligible: false }), false); // legacy account, new browser
});
t('auth boots async: "auth off" is retried before falling back to the per-device demo check', () => {
  const d = readFileSync(new URL('../public/dashboard.html', import.meta.url), 'utf8');
  assert.match(d, /if\(!authOn\)\{ if\(tries\+\+ < 15\)\{ setTimeout\(go, 400\); return; \}/);
});
