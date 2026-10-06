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

console.log(`\nvercel-routing: ${n} passed`);
