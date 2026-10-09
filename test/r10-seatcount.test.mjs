// R10: the status bar / multi-select / countSeats / flow note all count EVERY seat (incl. sofas &
// lounges), matching the generator's exact count (live bug: 105-seat Reception showed "101 seats").
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const HS = require('../public/event-sizing.js');
const js = readFileSync(new URL('../public/builder.js', import.meta.url), 'utf8');
const flow = readFileSync(new URL('../public/flow.html', import.meta.url), 'utf8');
assert.match(js, /let chairs=sumSeats\(store\.items\), tables=0;/, 'status bar uses sumSeats');
assert.match(js, /let chairs=sumSeats\(items\), tables=0;/, 'multi-select uses sumSeats');
assert.match(js, /return \{chairs:sumSeats\(items\), tables\};/, 'countSeats uses sumSeats');
assert.match(js, /Seats in layout: <b>\$\{esc\(sumSeats\(store\.items\)\)\}<\/b>/);
assert.match(flow, /oi\.chairs\+\(HelmSizing\.extraFloorSeats\?HelmSizing\.extraFloorSeats\(layoutItems\):0\)/);
assert.equal(HS.extraFloorSeats([{ type: 'lounge' }, { type: 'sofa' }, { type: 'table', properties: { seats: 8 } }, { type: 'lounge', properties: { seats: 6 } }]), 7);
assert.equal(HS.extraFloorSeats([]), 0);
// builder's FLOOR_SEATS and event-sizing's must agree
const m = js.match(/const FLOOR_SEATS = (\{[^}]+\})/); const b = Function('return ' + m[1])();
const e = Function('return ' + readFileSync(new URL('../public/event-sizing.js', import.meta.url), 'utf8').match(/var FLOOR_SEATS = (\{[^}]+\})/)[1])();
assert.deepEqual(b, e, 'FLOOR_SEATS maps agree');
console.log('r10-seatcount: ok');
// even spread of banquet table seats
{ const src = readFileSync(new URL('../public/builder.js', import.meta.url), 'utf8');
  assert.match(src, /const even=n===need && n>0, base=even\?Math\.floor\(N\/n\):0, extra=even\?N%n:0;/);
  const spread = (N, n) => Array.from({ length: n }, (_, i) => Math.floor(N / n) + (i < N % n ? 1 : 0));
  for (const N of [105, 300, 700, 9, 17]) { const n = Math.ceil(N / 8), s = spread(N, n);
    assert.equal(s.reduce((a, b) => a + b, 0), N); assert.ok(Math.max(...s) <= 8 && Math.min(...s) >= Math.max(1, Math.floor(N / n))); }
  console.log('r10-seatcount: even spread ok'); }
