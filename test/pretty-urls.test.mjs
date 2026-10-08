// 0067 pretty studio URLs: helm.events/<studio>/<section>[/<ref>[/<sub>]].
// HelmUrl (store-api.js) parse/build/upgrade, vercel.json rewrites ≡ server.js routing,
// private headers on the new paths, pages wired, migration shipped.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const require = createRequire(import.meta.url);
const server = require(new URL('server.js', root).pathname);
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

const API = read('public/store-api.js');
const core = API.slice(API.indexOf('var HelmUrl = (function'), API.indexOf('window.HelmUrl = HelmUrl;'));
function helm(pathname, slug) {
  const store = slug ? { bp_studio_slug: slug } : {};
  const ctx = { window: null, location: { pathname, search: '' }, URLSearchParams,
    sessionStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } }, encodeURIComponent, decodeURIComponent };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(core + '\nthis.HelmUrl = HelmUrl;', ctx);
  return ctx.HelmUrl;
}

const MAP = {
  '/sharma-events/dashboard': 'dashboard', '/sharma-events/quotes': 'quotes', '/sharma-events/leads': 'leads',
  '/sharma-events/chat': 'chat', '/sharma-events/settings': 'control', '/sharma-events/events/EVT-0912': 'event',
  '/sharma-events/events/EVT-0912/floor-plan': 'builder', '/sharma-events/events/EVT-0912/tasks': 'ops',
  '/sharma-events/clients/priya-sharma-cafe1234': 'client', '/sharma-events/booklet/a0000000-0000-4000-8000-00000000b0c1': 'booklet',
};
const NOT = ['/sharma-events', '/sharma-events/events', '/sharma-events/clients', '/sharma-events/booklet', '/sharma-events/quotes/x',
  '/sharma-events/events/EVT-1/other', '/sharma-events/clients/x/tasks', '//evil.com/quotes', '/a/quotes', '/Sharma/quotes', '/dashboard', '/hq', '/login'];

t('HelmUrl.parse: every pretty path → its page; malformed / open-redirect shapes → null', () => {
  const H = helm('/');
  for (const [p, page] of Object.entries(MAP)) assert.equal(H.parse(p) && H.parse(p).page, page, p);
  for (const p of NOT) assert.equal(H.parse(p), null, p);
  assert.equal(H.parse('/sharma-events/events/EVT-0912').ref, 'EVT-0912');
  assert.equal(H.parse('/s-1/events/%E0%A4/tasks'), null, 'bad encoding');
});

t('HelmUrl.build: pretty with a studio, legacy without; refs encoded', () => {
  const H = helm('/', 'sharma-events');
  assert.equal(H.build('quotes'), '/sharma-events/quotes');
  assert.equal(H.build('settings'), '/sharma-events/settings');
  assert.equal(H.build('event', { ref: 'EVT-0912' }), '/sharma-events/events/EVT-0912');
  assert.equal(H.build('floor-plan', { ref: 'EVT-0912' }), '/sharma-events/events/EVT-0912/floor-plan');
  assert.equal(H.build('tasks', { ref: 'EVT-0912', query: { task: 't1' } }), '/sharma-events/events/EVT-0912/tasks?task=t1');
  assert.equal(H.build('client', { ref: 'a/b?c' }), '/sharma-events/clients/a%2Fb%3Fc');
  assert.equal(H.build('booklet', { token: 'tok' }), '/sharma-events/booklet/tok');
  assert.equal(H.build('chat', { query: { c: 'x' } }), '/sharma-events/chat?c=x');
  const L = helm('/');
  assert.equal(L.build('event', { ref: 'abc' }), 'event.html?id=abc');
  assert.equal(L.build('floor-plan', { ref: 'abc' }), 'builder.html?quote=abc');
  assert.equal(L.build('settings'), 'control.html');
  assert.equal(helm('/', 'sharma-events').build('quotes', { studio: '//evil' }), '/sharma-events/quotes', 'bad studio ignored');
  for (const p of Object.keys(MAP)) { const r = H.parse(p); assert.equal(H.parse(H.build(r.kind, { ref: r.ref })).page, MAP[p], 'round trip ' + p); }
});

t('HelmUrl.upgrade: legacy app links → pretty; others untouched', () => {
  const H = helm('/', 'sharma-events');
  assert.equal(H.upgrade('event.html?id=u1'), '/sharma-events/events/u1');
  assert.equal(H.upgrade('ops.html?quote=u1&task=t9'), '/sharma-events/events/u1/tasks?task=t9');
  assert.equal(H.upgrade('builder.html?quote=u1'), '/sharma-events/events/u1/floor-plan');
  assert.equal(H.upgrade('client.html?id=u1'), '/sharma-events/clients/u1');
  assert.equal(H.upgrade('quotes.html?focus=EVT-1'), '/sharma-events/quotes?focus=EVT-1');
  assert.equal(H.upgrade('control.html#users'), '/sharma-events/settings#users');
  assert.equal(H.upgrade('chat.html?c=c1&msg=m1'), '/sharma-events/chat?c=c1&msg=m1');
  for (const h of ['settlement.html?quote=u1#payments', 'event.html', 'https://evil.com/event.html?id=1', 'booklet.html?t=x', 'login.html'])
    assert.equal(H.upgrade(h), h, h);
  assert.equal(helm('/').upgrade('event.html?id=u1'), 'event.html?id=u1', 'no studio known → unchanged');
});

t('HelmUrl.here / page: login ?next keeps the pretty path; gate sees the served page', () => {
  const H = helm('/sharma-events/events/EVT-0912/tasks');
  assert.equal(H.page(), 'ops'); assert.equal(H.here(), '/sharma-events/events/EVT-0912/tasks');
  assert.equal(helm('/event').page(), 'event');
});

const v = JSON.parse(read('vercel.json'));
const rx = (src) => new RegExp('^' + src + '$');
t('vercel.json rewrites ≡ server.js prettyPage for every pretty path', () => {
  for (const [p, page] of Object.entries(MAP)) {
    const hit = v.rewrites.filter((r) => rx(r.source).test(p));
    assert.equal(hit.length, 1, p + ': exactly one rewrite'); assert.equal(hit[0].destination, '/' + page, p);
    assert.equal(server.prettyPage(p), page, 'server.js ' + p);
  }
  for (const p of ['/sharma-events', '/sharma-events/events', '/sharma-events/clients', '/sharma-events/quotes/x', '/a/b/c/d/e'])
    { assert.ok(!v.rewrites.some((r) => r.source !== '/i/:slug*' && rx(r.source).test(p)), p); assert.equal(server.prettyPage(p), null, p); }
  assert.ok(Buffer.byteLength(read('vercel.json')) < 200 * 1024, 'vercel.json < 200KB');
});

function vh(p) { const o = {}; for (const r of v.headers) { if (r.has) continue; if (rx(r.source).test(p)) for (const h of r.headers) o[h.key.toLowerCase()] = h.value; } return o; }
t('private headers on pretty paths: noindex + no-store; booklet no-referrer + booklet CSP; floor-plan builder CSP', () => {
  for (const p of Object.keys(MAP)) { const h = vh(p); assert.match(h['x-robots-tag'] || '', /noindex/, p); assert.match(h['cache-control'] || '', /no-store/, p); }
  const b = vh('/sharma-events/booklet/tok'); assert.equal(b['referrer-policy'], 'no-referrer'); assert.equal(b['content-security-policy'], vh('/booklet')['content-security-policy']);
  assert.equal(vh('/sharma-events/events/E-1/floor-plan')['content-security-policy'], vh('/builder')['content-security-policy']);
  assert.equal(vh('/sharma-events/events/E-1')['content-security-policy'], vh('/event')['content-security-policy']);
});

t('pages: <base href="/"> on routed pages; params resolved through HelmUrl; no bare login ?next', () => {
  for (const pg of ['dashboard', 'quotes', 'leads', 'chat', 'control', 'event', 'builder', 'ops', 'client', 'booklet']) {
    const h = read(`public/${pg}.html`);
    assert.match(h, /<meta charset="utf-8">\n<base href="\/">/i, pg + ': base right after charset');
  }
  assert.match(read('public/event.html'), /id=await HelmUrl\.get\("id", id\)/);
  assert.match(read('public/ops.html'), /quoteId=await HelmUrl\.get\("quote", quoteId\)/);
  assert.match(read('public/builder.js'), /await HelmUrl\.get\('quote'/);
  assert.match(read('public/client.js'), /HelmUrl\.get\("id"/);
  assert.match(read('public/booklet.js'), /booklet\.studioOk\(token, pretty\.studio\)/);
  assert.match(API, /rpc\("my_studio_route"/); assert.match(API, /notYourStudio/);
  assert.match(API, /document\.body\.replaceChildren\(main\)/);
  for (const f of ['event', 'ops', 'quotes', 'leads', 'control']) assert.ok(!read(`public/${f}.html`).includes("location.pathname.split('/').pop()+location.search"), f);
  const ns = API.slice(API.indexOf('function notYourStudio'), API.indexOf('async function refToId'));
  assert.ok(!/innerHTML|style=/.test(ns), 'not-your-studio page: textContent only, no inline style');
});

t('migration 0067 shipped: MANIFEST, APPLY ASCII + verify rows, DB suite wired', () => {
  assert.match(read('supabase/migrations/MANIFEST'), /0067_pretty_urls\.sql/);
  const ap = read('supabase/APPLY-0067.sql');
  assert.ok(/^[\x00-\x7F]*$/.test(ap), 'APPLY-0067 ASCII only'); assert.match(ap, /select item, ok from \(values/);
  const m = read('supabase/migrations/0067_pretty_urls.sql');
  assert.ok(!/create table/i.test(m), 'no new table'); assert.match(m, /revoke all on function public\.resolve_event_ref\(text\) from anon/);
  assert.match(read('scripts/db-test/run-all.sh'), /pretty-urls\.sql/);
});

console.log(`\npretty-urls: ${n} passed`);
