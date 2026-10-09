// vercel.json routing (security audit Phase 2, finding P2-03).
// With "cleanUrls": true Vercel 308-redirects every *.html path to its clean URL, so a
// rewrite whose destination ends in ".html" never resolves — prod served the 404 page
// for every shared invitation link (/i/<slug>). Rewrites must target clean URLs that
// exist as a static page in public/.
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url);
const v = JSON.parse(readFileSync(new URL('vercel.json', root), 'utf8'));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('cleanUrls is on (the reason .html destinations break)', () => assert.equal(v.cleanUrls, true));

t('no rewrite destination ends in .html when cleanUrls is on', () => {
  for (const r of v.rewrites || []) assert.ok(!/\.html$/.test(r.destination), `${r.source} -> ${r.destination} must be a clean URL`);
});

t('every rewrite destination is a real static page', () => {
  for (const r of v.rewrites || []) {
    if (/^https?:/.test(r.destination)) continue;
    assert.ok(existsSync(new URL('public' + r.destination + '.html', root)), `${r.destination}.html missing from public/`);
  }
});

t('/i/<slug> invitation links are served by the invite page', () => {
  const r = (v.rewrites || []).find((x) => x.source === '/i/:slug*');
  assert.ok(r, 'missing /i/:slug* rewrite');
  assert.equal(r.destination, '/invite');
});


// ---- branded client links (0020): /<studio>/<kind>/<ref> ----
const KIND_PAGE = { invite: '/invite', quote: '/approve', proposal: '/proposal-view', portal: '/portal', work: '/work' };
const match = (src, p) => new RegExp('^' + src + '$').test(p);
function vercelHeaders(p) { const o = {}; for (const r of v.headers) if (!r.has && match(r.source, p)) for (const h of r.headers) o[h.key.toLowerCase()] = h.value; return o; }

t('every branded kind rewrites to its client page', () => {
  for (const [kind, dest] of Object.entries(KIND_PAGE)) {
    const hit = (v.rewrites || []).filter((r) => match(r.source, `/aurora-events/${kind}/abc-123`));
    assert.equal(hit.length, 1, `${kind}: exactly one rewrite`); assert.equal(hit[0].destination, dest);
  }
  for (const p of ['/dashboard', '/aurora-events', '/aurora-events/quote', '/a/b/c/d', '/docs/screenshots/x.webp'])
    assert.ok(!(v.rewrites || []).some((r) => r.source !== '/i/:slug*' && match(r.source, p)), `${p} must not be rewritten`);
});

t('branded links carry the SAME security headers as the page they serve', () => {
  const legacy = { invite: '/i/x', quote: '/approve', proposal: '/proposal-view', portal: '/portal', work: '/work' };
  for (const kind of Object.keys(KIND_PAGE)) {
    const a = vercelHeaders(`/aurora-events/${kind}/tok`), b = vercelHeaders(legacy[kind]);
    for (const k of ['content-security-policy', 'x-frame-options', 'x-robots-tag', 'strict-transport-security', 'referrer-policy'])
      assert.equal(a[k], b[k], `${kind}: ${k} differs from ${legacy[kind]}`);
    assert.match(a['x-robots-tag'] || '', /noindex/, `${kind} must be noindex`);
  }
});

t('client pages load assets by ABSOLUTE path (they are served under /<studio>/<kind>/…)', () => {
  for (const page of ['invite', 'approve', 'portal', 'proposal-view', 'work']) {
    const html = readFileSync(new URL(`public/${page}.html`, root), 'utf8');
    const rel = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
      .filter((u) => !/^(\/|https?:|data:|#|mailto:|\$\{)/.test(u));
    assert.deepEqual(rel, [], `${page}.html has relative asset paths`);
  }
});

t('client pages verify the studio before loading data; server.js routes the same kinds', () => {
  const pages = { approve: 'quote', portal: 'portal', 'proposal-view': 'proposal', work: 'work', invite: 'invite' };
  for (const [page, kind] of Object.entries(pages)) {
    const html = readFileSync(new URL(`public/${page}.html`, root), 'utf8');
    assert.match(html, new RegExp(`BPStore\\.links\\.parse\\("${kind}"\\)`), `${page} parses ${kind}`);
    assert.match(html, /BPStore\.links\.(require|verify)\(LINK\)/, `${page} verifies the studio`);
  }
  const srv = readFileSync(new URL('server.js', root), 'utf8');
  assert.match(srv, /invite: 'invite', quote: 'approve', proposal: 'proposal-view', portal: 'portal', work: 'work'/);
});

console.log(`\nvercel-routing: ${n} passed`);
