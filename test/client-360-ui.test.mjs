// One page per client (0062) — front end.
//  * pure helpers in public/client.js: safe links (own pages only; ?hs= gets the client
//    name), normalize() (known kinds only, bad rows dropped, hostile links nulled),
//    filterItems(), money / initials
//  * page wiring: client.html loads client.js + client.css, no inline script/style/style=,
//    client.js never uses innerHTML / insertAdjacentHTML / document.write
//  * store-api: BPStore.clientTimeline → client_timeline RPC, null for non-uuid / pre-0062
//  * links: leads board "Client →", event hub "Client page →", studio search "Client pages"
//  * migration 0062 in MANIFEST, APPLY-0062.sql pure ASCII with verify rows
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const SRC = read('public/client.js');
const ctx = { console, URLSearchParams };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx); vm.runInContext(SRC, ctx);
const api = ctx.HelmClient360;
const J = (x) => JSON.parse(JSON.stringify(x));

t('safeLink: own pages only', () => {
  assert.equal(api.safeLink('event.html?id=abc-1', 'X'), 'event.html?id=abc-1');
  assert.equal(api.safeLink('https://evil.test/x.html', 'X'), null);
  assert.equal(api.safeLink('javascript:alert(1)', 'X'), null);
  assert.equal(api.safeLink('//evil.test/a.html', 'X'), null);
  assert.equal(api.safeLink('event.html?id="><img>', 'X'), null);
  assert.equal(api.safeLink('', 'X'), null);
});
t('safeLink: list pages get the encoded client name', () => {
  assert.equal(api.safeLink('leads.html?hs=', 'Asha & Rao'), 'leads.html?hs=Asha%20%26%20Rao');
});
t('normalize: header, known kinds, bad rows dropped', () => {
  const m = api.normalize({ client: { name: 'Asha', phone: '+91 1', email: null, status: 'confirmed' },
    totals: { quoted: 10, paid: 4, due: 6 }, sections: ['leads', 'events', 'bogus'], counts: { events: 1 },
    items: [
      { kind: 'events', at: '2026-10-01T00:00:00Z', id: 'e1', title: 'Event created', subtitle: 'A-1', link: 'event.html?id=e1' },
      { kind: 'nope', id: 'x', title: 'x', link: 'a.html' },
      { kind: 'leads', id: 'l1', link: 'leads.html?hs=' },
      { kind: 'payments', id: 'p1', title: 'Paid', link: 'https://evil.test' },
    ] });
  assert.equal(m.client.name, 'Asha'); assert.equal(m.client.email, ''); assert.equal(m.client.status, 'confirmed');
  assert.deepEqual(J(m.sections), ['leads', 'events']);
  assert.equal(m.items.length, 2);
  assert.equal(m.items[0].href, 'event.html?id=e1');
  assert.equal(m.items[1].href, null, 'hostile link dropped, row kept as text');
  assert.equal(J(api.normalize(null)).items.length, 0);
});
t('filterItems: all vs one kind', () => {
  const items = [{ kind: 'leads' }, { kind: 'events' }, { kind: 'events' }];
  assert.equal(api.filterItems(items, 'all').length, 3);
  assert.equal(api.filterItems(items, 'events').length, 2);
  assert.equal(api.filterItems(items, 'tasks').length, 0);
});
t('money / initials', () => {
  assert.match(api.money(150000), /^₹1,50,000$/);
  assert.equal(api.money('x'), '—');
  assert.equal(api.initials('Asha Rao'), 'AR'); assert.equal(api.initials(''), '?');
});
t('client.js: DOM-safe (no html sinks)', () => {
  assert.doesNotMatch(SRC, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\./);
});
t('client.html: external script/style only, no inline style attrs', () => {
  const H = read('public/client.html');
  assert.match(H, /<script src="client\.js\?v=\d+"><\/script>/);
  assert.match(H, /<link rel="stylesheet" href="client\.css\?v=\d+">/);
  assert.doesNotMatch(H, /\sstyle="/);
  assert.doesNotMatch(H.replace(/<script src=[^>]*><\/script>/g, ''), /<script/);
  assert.match(H, /<main id="main">/); assert.match(H, /role="group" aria-label="Filter the timeline"/);
  const css = read('public/client.css');
  assert.match(css, /@media\(max-width:480px\)/); assert.match(css, /html\[data-theme="dark"\]/);
});
t('store-api: clientTimeline → client_timeline RPC', () => {
  const S = read('public/store-api.js');
  assert.match(S, /clientTimeline: \(id\) =>/);
  assert.match(S, /rpc\("client_timeline", \{ p_ref: ref, p_limit: 300 \}\)/);
  assert.match(S, /if \(!supa \|\| !\/\^\[0-9a-f\]\{8\}/);
});
t('links into the client page', () => {
  const L = read('public/leads.html'), E = read('public/event.html'), SS = read('public/studio-search.js');
  assert.match(L, /data-act="client"/); assert.match(L, /location\.href="client\.html\?id="\+encodeURIComponent\(id\)/);
  assert.match(E, /id="clientLink"/); assert.match(E, /"client\.html\?id="\+encodeURIComponent\(ev\.id\|\|id\)/);
  assert.match(SS, /type: "clients", label: "Client pages"/);
});
t('studio search: Client pages group from leads/events (uuid ids only, max 3)', () => {
  const ctx2 = { console }; ctx2.window = ctx2; ctx2.globalThis = ctx2; ctx2.navigator = { platform: 'x' };
  vm.createContext(ctx2); vm.runInContext(read('public/studio-search.js'), ctx2);
  const ss = ctx2.HelmStudioSearch;
  const U = (i) => '00000000-0000-4000-8000-00000000000' + i;
  const g = ss.normalize({ leads: [{ id: U(1), title: 'Asha', link: 'leads.html?hs=' }, { id: 'nouuid', title: 'B', link: 'leads.html?hs=' }],
    events: [U(2), U(3), U(4)].map((id) => ({ id, title: 'E' + id.slice(-1), link: 'event.html?id=' + id })) });
  const c = g.find((x) => x.type === 'clients');
  assert.ok(c); assert.equal(c.items.length, 3);
  assert.equal(c.items[0].href, 'client.html?id=' + U(2), 'events first (display order)');
  assert.ok(c.items.every((i) => /^client\.html\?id=[0-9a-f-]{36}$/.test(i.href)));
  assert.equal(ss.normalize({ staff: [{ id: U(5), title: 'S', link: 'staff.html?hs=' }] }).some((x) => x.type === 'clients'), false);
});
t('migration 0062 registered + APPLY file ASCII with verify rows', () => {
  assert.match(read('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0062_client_timeline\.sql/);
  const A = read('supabase/APPLY-0062.sql');
  assert.ok(/^[\x00-\x7F]*$/.test(A), 'APPLY-0062.sql must be pure ASCII');
  assert.match(A, /select item, ok from \(values/);
  assert.match(A, /security definer set search_path = ''/);
  assert.doesNotMatch(A, /create table|drop table|delete from|truncate/i);
});
console.log(`client-360-ui: ${n} checks passed.`);
