// robots.txt policy (security audit Phase 1/2, info-gathering hardening).
// The wildcard group must be an ALLOWLIST ("Disallow: /" + marketing Allows) so the
// public file never enumerates app route names, while every app page, token link,
// /docs and /api stays disallowed and every marketing page stays crawlable.
// Matching follows RFC 9309 / Google: longest matching rule wins, Allow wins ties,
// "*" = any run of chars, trailing "$" = end anchor.
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('..', import.meta.url);
const txt = readFileSync(new URL('public/robots.txt', root), 'utf8');

function groups(src) {
  const out = []; let cur = null, lastWasUA = false;
  for (const raw of src.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') {
      if (!lastWasUA) { cur = { agents: [], rules: [] }; out.push(cur); }
      cur.agents.push(v.toLowerCase()); lastWasUA = true;
    } else {
      lastWasUA = false;
      if (cur && (k === 'allow' || k === 'disallow')) cur.rules.push({ allow: k === 'allow', path: v });
    }
  }
  return out;
}
const toRe = (p) => new RegExp('^' + p.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$|\$$/, '$'));
function allowed(rules, url) {
  let best = null;
  for (const r of rules) {
    if (!r.path || !toRe(r.path).test(url)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

const star = groups(txt).find((g) => g.agents.includes('*'));
const MARKETING = ['index', 'about', 'services', 'privacy', 'terms', 'login'];
const appPages = readdirSync(new URL('public/', root))
  .filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5))
  .filter((p) => !MARKETING.includes(p));

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('wildcard group exists and ends in a blanket "Disallow: /"', () => {
  assert.ok(star, 'no "User-agent: *" group');
  assert.ok(star.rules.some((r) => !r.allow && r.path === '/'), 'wildcard group must contain "Disallow: /"');
});

t('no app route is named anywhere in robots.txt (no enumeration)', () => {
  const paths = groups(txt).flatMap((g) => g.rules.map((r) => r.path));
  for (const p of appPages) {
    assert.ok(!paths.some((x) => x === '/' + p || x.startsWith('/' + p + '.') || x.startsWith('/' + p + '/')), `robots.txt names app route /${p}`);
  }
  for (const secret of ['/approve', '/portal', '/proposal-view', '/sim-pay', '/work', '/invite', '/i/', '/docs', '/api'])
    assert.ok(!paths.includes(secret), `robots.txt names ${secret}`);
});

t('every app page (bare + .html) is disallowed for "*"', () => {
  assert.ok(appPages.length > 20, 'expected the app page list');
  for (const p of appPages) for (const u of ['/' + p, '/' + p + '.html', '/' + p + '?t=abc'])
    assert.equal(allowed(star.rules, u), false, `${u} must be disallowed`);
});

t('token links, docs, api, unknown paths are disallowed', () => {
  for (const u of ['/i/some-slug', '/approve?t=x', '/proposal-view?t=x', '/docs/x.md', '/api/layouts', '/.env', '/anything-new'])
    assert.equal(allowed(star.rules, u), false, u);
});

t('marketing pages + their assets stay crawlable', () => {
  for (const u of ['/', '/index', '/index.html', '/about', '/services', '/privacy', '/terms', '/login', '/about.html',
    '/landing.css?v=2', '/theme.css?v=73', '/telemetry.js?v=2', '/og.png', '/favicon.ico', '/favicon-48.png',
    '/apple-touch-icon.png', '/llms.txt', '/sitemap.xml', '/.well-known/security.txt'])
    assert.equal(allowed(star.rules, u), true, `${u} must stay crawlable`);
});

t('AI crawler groups stay marketing-only', () => {
  for (const g of groups(txt).filter((x) => !x.agents.includes('*'))) {
    assert.equal(allowed(g.rules, '/dashboard'), false, `${g.agents} can crawl /dashboard`);
    assert.equal(allowed(g.rules, '/login'), false, `${g.agents} can crawl /login`);
    assert.equal(allowed(g.rules, '/about'), true, `${g.agents} blocked from /about`);
  }
});

t('sitemap only lists marketing URLs', () => {
  const sm = readFileSync(new URL('public/sitemap.xml', root), 'utf8');
  const locs = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname);
  assert.ok(locs.length > 0);
  for (const p of locs) assert.equal(allowed(star.rules, p), true, `sitemap URL ${p} is disallowed`);
  for (const p of locs) assert.ok(!appPages.some((a) => p === '/' + a || p === '/' + a + '.html'), `sitemap lists app page ${p}`);
});

console.log(`\nrobots-policy: ${n} passed`);
