// Nav trail (breadcrumbs + Recent records): pure helpers, per-user+org storage, sign-out
// clearing, studio-search empty-state hook, loader wiring, no unsafe sinks.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/nav-trail.js');
const STORE = read('public/store-api.js');
const SS = read('public/studio-search.js');

function mkLS(throwing) {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => { if (throwing) throw new Error('x'); return m.has(k) ? m.get(k) : null; },
    setItem: (k, v) => { if (throwing) throw new Error('x'); m.set(k, String(v)); },
    removeItem: (k) => m.delete(k), _m: m };
}
function load(ls, uid = 'u1') {
  const g = { localStorage: ls, location: { pathname: '/event.html', search: '?id=1' }, history: {},
    BPStore: { auth: { user: () => (uid ? { id: uid } : null) } } };
  g.globalThis = g;
  vm.runInNewContext(SRC, g);
  return g;
}

// safeHref: own pages only
{
  const T = load(mkLS()).HelmTrail;
  assert.equal(T.safeHref('event.html?id=1'), 'event.html?id=1');
  assert.equal(T.safeHref('/leads.html?hs=a'), 'leads.html?hs=a');
  for (const bad of ['https://evil.com/x.html', '//evil.com/a.html', 'javascript:alert(1)', 'a.html\\x', '']) assert.equal(T.safeHref(bad), '');
  // trail model
  assert.deepEqual([...T.trail('event', { title: 'EVT-0912 Sharma Wedding' }).map((x) => x.label)], ['Quotes', 'EVT-0912 Sharma Wedding']);
  const b = T.trail('builder', { title: 'EVT-0912 Sharma Wedding', recordHref: 'event.html?id=9' });
  assert.deepEqual([...b.map((x) => x.label)], ['Quotes', 'EVT-0912 Sharma Wedding', 'Floor plan']);
  assert.equal(b[0].href, 'quotes.html'); assert.equal(b[1].href, 'event.html?id=9'); assert.equal(b[2].href, '');
  assert.equal(T.trail('quotes', null)[0].href, '');
  assert.equal(T.timeAgo(Date.now() - 5000), 'just now');
  assert.equal(T.timeAgo(Date.now() - 3 * 3600e3), '3h ago');
}

// storage: per user, max 10, dedupe, bad rows dropped, throwing storage is fine
{
  const ls = mkLS();
  const g = load(ls);
  const T = g.HelmTrail;
  assert.ok(T._key().startsWith('helm_trail_u1_'));
  const k = T._key();
  const rows = Array.from({ length: 12 }, (_, i) => ({ title: 'R' + i, kind: 'event', href: 'event.html?id=' + i, at: 1 }));
  rows.push({ title: 'x', href: 'https://evil.com/a.html' }, null, { title: 5, href: 'a.html' });
  ls.setItem(k, JSON.stringify(rows));
  const r = T.recent();
  assert.equal(r.length, 10); assert.ok(r.every((x) => !x.href.includes('evil')));
  ls.setItem('helm_trail_other_org', '[]'); ls.setItem('keep_me', '1');
  T.clearAll();
  assert.equal(ls.getItem(k), null); assert.equal(ls.getItem('helm_trail_other_org'), null); assert.equal(ls.getItem('keep_me'), '1');
  assert.equal(load(mkLS(true)).HelmTrail.recent().length, 0);
  assert.equal(load(mkLS(), null).HelmTrail.recent().length, 0);
}

// setCurrent before boot is queued, not written under a half-known key
{
  const ls = mkLS(); const g = load(ls);
  g.HelmTrail.setCurrent({ title: 'A', kind: 'event', href: 'event.html?id=1' });
  assert.equal(ls._m.size, 0); assert.equal(g.__helmTrailQ.length, 1);
}

// wiring
assert.match(STORE, /nav-trail\.js\?v=" \+ NAV_TRAIL_VERSION/);
assert.match(STORE, /async signOut\(\)[^\n]*navTrailClear\(\)/);
assert.match(STORE, /global\.HelmTrail = \{ setCurrent/);
assert.match(SS, /function recentRecords\(\)/);
assert.match(SS, /label: "Recently opened"/);
assert.match(read('public/event.html'), /HelmTrail\.setCurrent\(\{title:/);
assert.match(read('public/leads.html'), /HelmTrail\.setCurrent\(\{title:l\.name/);
assert.match(read('public/builder.js'), /HelmTrail\.setCurrent\(\{title:/);
for (const bad of [/innerHTML/, /insertAdjacentHTML/, /\.style\./, /style=/, /document\.write/]) assert.ok(!bad.test(SRC), 'nav-trail.js must not use ' + bad);
assert.match(SRC, /__helmAdoptCss/);
assert.match(SRC, /@media \(max-width:640px\)/);

// studio-search hook returns records from HelmTrail and drops foreign links
{
  const g = { localStorage: mkLS(), location: { pathname: '/x.html', search: '' }, navigator: {} };
  g.globalThis = g;
  g.HelmTrail = { recent: () => [{ title: 'EVT-1 A', kind: 'event', href: 'event.html?id=1', at: Date.now() }, { title: 'bad', href: 'https://e.com/a.html' }],
    ICONS: { event: '📅' }, KIND_LABEL: { event: 'Event' }, timeAgo: () => 'just now' };
  vm.runInNewContext(SS, g);
  const recs = g.HelmStudioSearch.recentRecords();
  assert.equal(recs.length, 1); assert.equal(recs[0].href, 'event.html?id=1'); assert.equal(recs[0].sub, 'Event · just now');
  g.HelmTrail = { recent() { throw new Error('x'); } };
  assert.equal(g.HelmStudioSearch.recentRecords().length, 0);
}
console.log('nav-trail-ui: ok');
