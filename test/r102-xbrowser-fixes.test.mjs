// R102: cross-browser run fixes - bell keeps last good feed + backs off on bell_feed 500s; aborted fetches during
// page unload (Safari "access control checks") never surface as unhandled rejections; quotes rows carry real links.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const S = read('public/store-api.js'), Q = read('public/quotes.html');
let n = 0; const t = async (name, fn) => { await fn(); n++; };

await t('bell: failures return the last good feed, back off and retry once', () => {
  assert.match(S, /const safeFeed = async \(\) => \{/);
  assert.match(S, /goodFeed = f; feedFails = 0; feedBackoffUntil = 0; return f;/);
  assert.match(S, /feedBackoffUntil = Date\.now\(\) \+ Math\.min\(480000, 30000 \* Math\.pow\(2, feedFails\)\)/);
  assert.match(S, /if \(feedFails === 1 && !feedRetryT\) feedRetryT = setTimeout/);
  assert.match(S, /return goodFeed;\n/);
  // both feed readers go through it; nothing calls this.feed(20) raw any more
  assert.equal((S.match(/await safeFeed\(\)/g) || []).length, 2);
  assert.ok(!/try \{ f = await this\.feed\(20\); \} catch \{\}/.test(S));
  // the poll and the tab-visible catch-up respect the backoff; teardown clears the retry
  assert.match(S, /setInterval\(\(\) => \{ if \(kicked && !document\.hidden && !isOpen && Date\.now\(\) >= feedBackoffUntil/);
  assert.match(S, /const onVis = \(\) => \{ if \(kicked && !document\.hidden && !isOpen && Date\.now\(\) >= feedBackoffUntil/);
  assert.match(S, /clearInterval\(timer\); clearTimeout\(feedRetryT\);/);
  const back = (k) => Math.min(480000, 30000 * Math.pow(2, k));
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(back), [60000, 120000, 240000, 480000, 480000, 480000]);
});

// behavioural: run the real wrapper code with a fake window
const a = S.indexOf('  let pageLeaving = false;'), b = S.indexOf('  function authAwareFetchInner');
assert.ok(a > 0 && b > a);
function load(inner) {
  const L = {}; const global = { addEventListener: (ev, fn) => { L[ev] = fn; } };
  const f = new Function('global', 'authAwareFetchInner', 'setTimeout', S.slice(a, b) + '\nreturn authAwareFetch;');
  return { fetch: f(global, inner, () => 0), L };
}
const fail = (name) => () => Promise.reject(Object.assign(new TypeError('Fetch API cannot load x due to access control checks.'), name ? { name } : {}));
const settles = (p) => Promise.race([p.then(() => 'ok', () => 'rejected'), new Promise((r) => setTimeout(() => r('pending'), 30))]);

await t('active page: real errors still reject', async () => {
  const { fetch } = load(fail());
  assert.equal(await settles(fetch('u')), 'rejected');
});
await t('after pagehide: aborted fetches stay pending (no unhandled rejection)', async () => {
  const { fetch, L } = load(fail());
  L.pagehide(); assert.equal(await settles(fetch('u')), 'pending');
  const { fetch: f2, L: L2 } = load(fail('AbortError')); L2.beforeunload(); assert.equal(await settles(f2('u')), 'pending');
});
await t('after pagehide: non-network errors still reject; bfcache restore is active again', async () => {
  const { fetch, L } = load(() => Promise.reject(new Error('boom')));
  L.pagehide(); assert.equal(await settles(fetch('u')), 'rejected');
  const r = load(fail()); r.L.pagehide(); r.L.pageshow(); assert.equal(await settles(r.fetch('u')), 'rejected');
});
await t('supabase client uses the wrapper', () => { assert.match(S, /global: \{ fetch: authAwareFetch \}/); });

await t('quotes rows: code + name are real links to the event page (pretty URL)', () => {
  assert.match(Q, /function qHref\(x\)\{ const h="event\.html\?id="\+encodeURIComponent\(x\.id\); try\{ return \(window\.HelmUrl&&HelmUrl\.upgrade\)\?HelmUrl\.upgrade\(h\):h;/);
  assert.match(Q, /<td class="code"><a class="qcode" href="\$\{esc\(qHref\(x\)\)\}"/);
  assert.match(Q, /<a class="qname" href="\$\{esc\(qHref\(x\)\)\}"/);
  // no nested interactive content inside the links
  const row = Q.slice(Q.indexOf('<td class="code"><a class="qcode"'), Q.indexOf('<td>${esc(client)'));
  for (const m of row.matchAll(/<a [^>]*>(.*?)<\/a>/g)) assert.ok(!/<(a|button|select|input)\b/.test(m[1]), m[1]);
});
console.log(`r102-xbrowser-fixes: ${n} checks passed`);
