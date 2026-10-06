#!/usr/bin/env node
// db-log-noise.test.mjs — root causes found in the production Postgres log (6 Oct 2026):
//  "permission denied for table layouts" (42501): layout calls sent with no live session
//  (anon has no grant on layouts) — store-api must not send them; it routes to re-login.
//  "invalid input syntax for type uuid" (22P02): quotes.get called with a truncated id —
//  validate before sending.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const api = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };
t('every layouts call checks for a signed-in user before any request', () => {
  const sb = api.match(/const sb = \{([\s\S]*?)\n  \};/)[1];
  for (const f of ['list()', 'get(id)', 'create(name, data)', 'update(id, patch)', 'remove(id)'])
    assert.match(sb, new RegExp('async ' + f.replace(/[()]/g, '\\$&') + ' \\{ needUser\\(\\);'), f + ' must call needUser() first');
  assert.match(api, /function needUser\(\) \{\s*if \(currentUser\) return;[\s\S]*?onAuthFailure\(\)/, 'needUser routes to the session-expiry flow');
});
t('quotes.get refuses a malformed id without calling the database', () => {
  const m = api.match(/async get\(id\) \{\s*\/\/ a truncated[^\n]*\n\s*if \(!(\/\^\[0-9a-f\][^ ]*\/i)\.test/);
  assert.ok(m, 'uuid guard must come first');
  const re = eval(m[1]);
  assert.equal(re.test('a147002e'), false); assert.equal(re.test('5bc9971b-1d85-461b-876d-fac7bc2e5f23'), true);
});
console.log(`\ndb-log-noise: ${n} passed`);
