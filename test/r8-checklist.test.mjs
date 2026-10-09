// R8: checklist "Send your first quote" creates a quote (not a detour to Home), and the
// dashboard tour never auto-runs again once this device has auto-run it.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const r = (p) => readFileSync(new URL('../public/' + p, import.meta.url), 'utf8');
const q = r('quotes.html'), d = r('dashboard.html'), gs = r('getting-started.js');
assert.ok(gs.includes('href: "quotes.html?new=1"'), 'checklist quote step opens the create flow');
assert.ok(!/href="dashboard\.html"[^>]*>✨ (New|Create your first) quote/.test(q), 'quotes create buttons no longer link to Home');
assert.ok((q.match(/data-newquote/g) || []).length >= 3, 'both create buttons wired');
assert.ok(q.includes('BPStore.quotes.startBlank(code)') && q.includes('"flow.html?quote="'), 'creates and opens the flow');
assert.ok(q.includes('get("new")==="1"'), '?new=1 auto-creates');
assert.ok(q.includes('action: "create the quote"'), 'create errors surface a toast');
assert.ok(d.includes('bp_tour_autorun') && /seen \|\| localSeen/.test(d), 'tour auto-run guarded per device');
assert.ok(d.includes('getting-started.js?v=3'), 'cache-bust');
// behavioural: simulate the dashboard gate
function gate(ls, seen, forced, eligible) {
  let localSeen = !!ls.bp_seen_tour || !!ls.bp_tour_autorun;
  if (seen || localSeen || (!forced && !eligible)) return false;
  ls.bp_tour_autorun = '1'; return true;
}
const ls = {};
assert.equal(gate(ls, false, true, true), true, 'first visit after sign-up runs tour');
assert.equal(gate(ls, false, false, true), false, 'later visit (account flag write failed) does not re-run');
assert.ok(gs.includes('href: "quotes.html?new=1&open=builder"'), 'floor plan step opens builder on a quote');
assert.ok(q.includes('"&from=flow"') && q.includes('x.status==="quote"'), 'builder: reuse latest open quote, else create');
assert.ok(/done = await A\.markTourSeen\(\)[\s\S]{0,80}await A\.markTourSeen\(\)/.test(d), 'markTourSeen awaited with one retry');
assert.ok(!/tries\+\+ < 12/.test(d), 'no fixed 5s user poll');
console.log('r8-checklist: ok');
