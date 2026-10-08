// Header parity: vercel.json (production) ≡ server.js (local dev) ≡ public/_headers
// (Netlify/Cloudflare) for HSTS, COOP, CORP, X-Frame-Options, CSP, X-Robots-Tag and
// the cache policy of versioned assets.
//
// Documented per-host differences (NOT compared):
//   • server.js drops `upgrade-insecure-requests` on localhost (dev is plain http) —
//     this test asks server.js for a production host, so UIR must match there.
//   • Vercel header rules see only the PATH, so every .js/.css is immutable there;
//     server.js also sees the query and only treats `?v=`-versioned assets as
//     immutable. Only the versioned case is compared.
//   • _headers uses Cloudflare "! Header" detach semantics for per-page overrides.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
const require = createRequire(import.meta.url);
const server = require(join(ROOT, 'server.js'));

const MARKETING = ['index', 'about', 'services', 'privacy', 'terms', 'refund-policy'];
const PAGES = readdirSync(PUB).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -5));

/* ---- vercel.json: last matching rule wins per key (Vercel semantics) ---- */
const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
// host = null → a non-production host (branch preview); a prod host also applies
// the host-conditioned rules (prod-only CSP overrides, legacy alias noindex).
function vercelHeaders(p, host = null) {
  const out = {};
  for (const r of vercel.headers) {
    if (r.has && !(host && r.has.every((c) => c.type === 'host' && c.value === host))) continue;
    // Sources use only regex-compatible path-to-regexp syntax (groups, \\.),
    // verified against path-to-regexp@6 when written.
    if (new RegExp('^' + r.source + '$').test(p)) for (const h of r.headers) out[h.key.toLowerCase()] = h.value;
  }
  return out;
}

/* ---- _headers: Cloudflare Pages semantics ---- */
const blocks = [];
for (const line of readFileSync(join(PUB, '_headers'), 'utf8').split('\n')) {
  if (!line.trim() || line.trim().startsWith('#')) continue;
  if (!/^\s/.test(line)) { blocks.push({ pat: line.trim(), ops: [] }); continue; }
  const t = line.trim();
  if (t.startsWith('!')) blocks.at(-1).ops.push(['del', t.slice(1).trim().toLowerCase()]);
  else { const i = t.indexOf(':'); blocks.at(-1).ops.push(['set', t.slice(0, i).trim().toLowerCase(), t.slice(i + 1).trim()]); }
}
function netlifyHeaders(p) {
  const out = {};
  for (const b of blocks) {
    const re = new RegExp('^' + b.pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
      .replace(/:[a-z]+/g, '[^/]+') + '$');   // Cloudflare placeholders (:name) = one path segment
    if (!re.test(p)) continue;
    for (const [op, k, v] of b.ops) {
      if (op === 'del') delete out[k];
      else { assert.ok(!(k in out), `_headers: ${k} set twice for ${p} without "! ${k}" detach (hosts would combine them)`); out[k] = v; }
    }
  }
  return out;
}

/* ---- server.js ---- */
const PROD_REQ = { headers: { host: 'www.helm.events' } };
function serverHeaders(p, query = '') {
  let file;
  const branded = /^\/[a-z0-9-]{3,40}\/(invite|quote|proposal|portal|work)\/[^/]+$/.exec(p);
  if (p === '/') file = 'index.html';
  else if (p === '/i' || p.startsWith('/i/')) file = 'invite.html';
  else if (branded) file = { invite: 'invite', quote: 'approve', proposal: 'proposal-view', portal: 'portal', work: 'work' }[branded[1]] + '.html';
  else if (/\.[a-z0-9]+$/i.test(p)) file = p.slice(1);
  else file = p.slice(1) + '.html';
  const h = server.securityHeadersFor(PROD_REQ, join(PUB, file));
  const out = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  out['cache-control'] = server.cacheControlFor(join(PUB, file), query);
  return out;
}

const cspMap = (v) => Object.fromEntries((v || '').split(';').map((d) => d.trim()).filter(Boolean)
  .map((d) => { const [k, ...rest] = d.split(/\s+/); return [k, rest.sort().join(' ')]; }));

let n = 0;
const t = (name, fn) => { fn(); n++; };

const SECURITY_KEYS = ['strict-transport-security', 'cross-origin-opener-policy', 'cross-origin-resource-policy',
  'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy',
  'access-control-allow-origin'];

// every page (clean + .html where applicable) + token/docs routes
const paths = ['/', '/i', '/i/some-slug', '/docs/USER-MANUAL', '/docs/USER-MANUAL.html'];
for (const p of PAGES) paths.push('/' + p, '/' + p + '.html');
const BRANDED = ['invite', 'quote', 'proposal', 'portal', 'work'].map((k) => `/aurora-events/${k}/tok-123`);
paths.push(...BRANDED);

for (const p of paths) {
  const v = vercelHeaders(p), nf = netlifyHeaders(p);
  const s = serverHeaders(p.replace(/\.html$/, ''));
  t(`${p}: security headers match`, () => {
    for (const k of SECURITY_KEYS) {
      assert.ok(v[k], `vercel.json missing ${k} for ${p}`);
      assert.equal(s[k], v[k], `server.js ${k} differs from vercel.json for ${p}`);
      assert.equal(nf[k], v[k], `_headers ${k} differs from vercel.json for ${p}`);
    }
  });
  t(`${p}: CSP directives match`, () => {
    // server.js is asked as www.helm.events and _headers is prod-only → compare with
    // the PROD-host view of vercel.json (host-conditioned CSP overrides applied).
    const vp = vercelHeaders(p, 'www.helm.events');
    assert.deepEqual(cspMap(s['content-security-policy']), cspMap(vp['content-security-policy']), `server.js CSP ≠ vercel.json for ${p}`);
    assert.deepEqual(cspMap(nf['content-security-policy']), cspMap(vp['content-security-policy']), `_headers CSP ≠ vercel.json for ${p}`);
  });
  t(`${p}: X-Robots-Tag matches`, () => {
    assert.equal(s['x-robots-tag'], v['x-robots-tag'], `server.js X-Robots-Tag ≠ vercel.json for ${p}`);
    assert.equal(nf['x-robots-tag'], v['x-robots-tag'], `_headers X-Robots-Tag ≠ vercel.json for ${p}`);
  });
  t(`${p}: HTML Cache-Control matches`, () => {
    if (p.startsWith('/docs/')) return;   // docs: server.js serves them as files (no clean-URL mapping)
    assert.equal(s['cache-control'], v['cache-control'], `server.js Cache-Control ≠ vercel.json for ${p}`);
    assert.equal(nf['cache-control'], v['cache-control'], `_headers Cache-Control ≠ vercel.json for ${p}`);
  });
}

t('client-link (token) pages: Referrer-Policy no-referrer + Cache-Control no-store, private on every host', () => {
  const tokenPaths = ['/i', '/i/some-slug', ...BRANDED];
  for (const pg of ['approve', 'portal', 'booklet', 'proposal-view', 'work', 'invite']) tokenPaths.push('/' + pg, '/' + pg + '.html');
  for (const p of tokenPaths) {
    for (const [host, h] of [['vercel.json', vercelHeaders(p)], ['_headers', netlifyHeaders(p)], ['server.js', serverHeaders(p.replace(/\.html$/, ''))]]) {
      assert.equal(h['referrer-policy'], 'no-referrer', `${host}: ${p} Referrer-Policy`);
      assert.equal(h['cache-control'], 'no-store, private', `${host}: ${p} Cache-Control`);
    }
  }
  // other pages keep the site-wide policy
  for (const p of ['/dashboard', '/', '/proposal', '/invite-studio']) assert.equal(vercelHeaders(p)['referrer-policy'], 'strict-origin-when-cross-origin', p);
});

t('noindex covers every non-marketing page; marketing pages stay indexable', () => {
  for (const p of PAGES) {
    for (const u of ['/' + p, '/' + p + '.html']) {
      const tag = vercelHeaders(u)['x-robots-tag'];
      if (MARKETING.includes(p)) assert.equal(tag, undefined, `${u} is marketing and must stay indexable`);
      else assert.match(tag || '', /noindex/, `${u} must be noindex (add it to the vercel.json / _headers / server.js lists)`);
    }
  }
  for (const u of ['/i/x', '/docs/anything', '/.well-known/security.txt']) assert.match(vercelHeaders(u)['x-robots-tag'] || '', /noindex/, u);
  assert.equal(vercelHeaders('/')['x-robots-tag'], undefined, '/ must stay indexable');
});

t('base CSP: no CDN hosts (builder-only); pinned Sentry bundle dir + ingest kept; img/media locked', () => {
  const c = cspMap(vercelHeaders('/dashboard')['content-security-policy']);
  assert.ok(!/jsdelivr/.test(c['script-src'] + c['connect-src']), 'jsdelivr back in base CSP (supabase-js is self-hosted in /vendor/)');
  assert.ok(!/cdnjs/.test(c['script-src']), 'cdnjs back in base CSP (three.js is builder-only — scripts/csp-hashes.cjs)');
  assert.match(c['script-src'], /(^| )https:\/\/browser\.sentry-cdn\.com\/8\.35\.0\/( |$)/);
  assert.match(c['connect-src'], /\*\.ingest\.sentry\.io/);
  assert.ok(!/(^| )https:( |$)/.test(c['img-src']) && !/(^| )https:( |$)/.test(c['media-src']), 'base img/media-src must not allow any https: host');
  // Hash-based CSP: inline scripts are allowed only by their sha256 hash.
  assert.ok(!/'unsafe-inline'/.test(c['script-src']), "script-src must not allow 'unsafe-inline'");
  assert.match(c['script-src'], /'sha256-[A-Za-z0-9+/=]{44}'/, 'script-src must carry the inline-script hashes (node scripts/gen-csp.mjs)');
});

t('cache policy: versioned assets / vendor immutable, config.js short, marketing HTML no-cache, app/auth pages no-store', () => {
  const cases = [['/store-api.js', '?v=1'], ['/theme.css', '?v=1'], ['/vendor/x-1.0.0.min.js', ''], ['/config.js', '?v=1'], ['/dashboard', ''], ['/', ''],
    ['/login', ''], ['/reset-password', ''], ['/approve', ''], ['/about', '']];
  for (const [p, q] of cases) {
    const v = vercelHeaders(p)['cache-control'];
    assert.equal(serverHeaders(p, q)['cache-control'], v, `server.js Cache-Control ≠ vercel.json for ${p}${q}`);
    assert.equal(netlifyHeaders(p)['cache-control'], v, `_headers Cache-Control ≠ vercel.json for ${p}`);
  }
  assert.match(vercelHeaders('/vendor/a.js')['cache-control'], /immutable/);
  assert.equal(vercelHeaders('/config.js')['cache-control'], 'public, max-age=300, stale-while-revalidate=3600');
  // auth hardening: signed-in app pages and the login / reset pages must never be stored
  for (const p of PAGES.filter((x) => !MARKETING.includes(x))) {
    for (const u of ['/' + p, '/' + p + '.html']) {
      assert.match(vercelHeaders(u)['cache-control'] || '', /^no-store(, private)?$/, `${u} must be Cache-Control: no-store (vercel.json)`);
      assert.match(netlifyHeaders(u)['cache-control'] || '', /^no-store(, private)?$/, `${u} must be Cache-Control: no-store (_headers)`);
    }
    assert.match(serverHeaders('/' + p)['cache-control'] || '', /^no-store(, private)?$/, `/${p} must be no-store (server.js)`);
  }
  for (const p of MARKETING) assert.equal(vercelHeaders('/' + (p === 'index' ? '' : p))['cache-control'], 'no-cache', `${p} keeps no-cache`);
});

t('CAPTCHA CSP allowance (Turnstile) only on the login / reset pages', () => {
  for (const p of PAGES) {
    const c = cspMap(vercelHeaders('/' + p)['content-security-policy']);
    const auth = p === 'login' || p === 'reset-password';
    assert.equal(/challenges\.cloudflare\.com/.test(c['script-src']), auth, `/${p} script-src Turnstile allowance`);
    assert.equal(/challenges\.cloudflare\.com/.test(c['frame-src']), auth, `/${p} frame-src Turnstile allowance`);
    assert.ok(!/challenges\.cloudflare\.com/.test(c['connect-src'] || ''), `/${p} connect-src must not gain Turnstile`);
  }
});

t('CSP: vercel.json/_headers allow ONLY the prod Supabase project (previews cannot reach staging by design); localhost also allows staging (no *.supabase.co)', () => {
  const PRODP = 'nqltzgiwznphugcfhmbm.supabase.co', STGP = 'xizehqgeyjcfpzrdymly.supabase.co';
  for (const [file, src] of [['vercel.json', readFileSync(join(ROOT, 'vercel.json'), 'utf8')], ['_headers', readFileSync(join(PUB, '_headers'), 'utf8')], ['server.js', readFileSync(join(ROOT, 'server.js'), 'utf8')]])
    assert.ok(!/\*\.supabase\.co/.test(src), file + ' still allows any *.supabase.co project');
  assert.ok(!readFileSync(join(PUB, '_headers'), 'utf8').includes(STGP), '_headers (served from public/) must not name the staging project');
  const hostsIn = (v) => (v || '').split(/\s+/).filter((x) => /supabase\.co/.test(x));
  const want = (projs) => [...projs.map((x) => 'https://' + x), ...projs.map((x) => 'wss://' + x)].sort();
  const LOCAL_REQ = { headers: { host: 'localhost:3000' } };
  for (const p of PAGES) {
    const cases = [['_headers', netlifyHeaders('/' + p), [PRODP]], ['server.js@prod', serverHeaders('/' + p), [PRODP]],
      ['vercel.json@preview', vercelHeaders('/' + p), [PRODP]],
      ['server.js@localhost', { 'content-security-policy': server.securityHeadersFor(LOCAL_REQ, join(PUB, p + '.html'))['Content-Security-Policy'] }, [PRODP, STGP]]];
    for (const host of ['www.helm.events', 'helm.events', 'helm-v01.vercel.app', 'helm-alpha-nine.vercel.app'])
      cases.push(['vercel.json@' + host, vercelHeaders('/' + p, host), [PRODP]]);
    for (const [who, h, projs] of cases) {
      const c = cspMap(h['content-security-policy']);
      assert.deepEqual(hostsIn(c['connect-src']).sort(), want(projs), `${who} /${p} connect-src supabase hosts`);
      for (const d of ['img-src', 'media-src']) {
        for (const x of hostsIn(c[d])) assert.ok(projs.some((pr) => x === 'https://' + pr), `${who} /${p} ${d} has unexpected ${x}`);
      }
      if (projs.length === 1) assert.ok(!(h['content-security-policy'] || '').includes(STGP), `${who} /${p} CSP names staging`);
    }
  }
});

t('config.staging.js is 404-redirected on every production host', () => {
  for (const host of ['www.helm.events', 'helm.events', 'helm-v01.vercel.app', 'helm-alpha-nine.vercel.app']) {
    const r = vercel.redirects.find((x) => new RegExp('^' + x.source + '$').test('/config.staging.js') &&
      x.has && x.has.some((c) => c.type === 'host' && c.value === host));
    assert.ok(r && r.destination === '/404' && r.permanent === false, host + ' must 404 /config.staging.js');
  }
});

t('security.txt: e-mail contact + Expires (RFC 9116), no internal notes, no unverified GitHub channel', () => {
  const txt = readFileSync(join(PUB, '.well-known', 'security.txt'), 'utf8');
  const fields = txt.split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(fields.filter((l) => l.startsWith('Contact:')), ['Contact: mailto:security@helm.events']);
  const exp = (fields.find((l) => l.startsWith('Expires:')) || '').slice(8).trim();
  assert.ok(exp && !isNaN(Date.parse(exp)) && Date.parse(exp) > Date.now(), 'Expires present and in the future');
  assert.ok(Date.parse(exp) - Date.now() < 366 * 864e5 * 1.1, 'Expires no more than ~1 year ahead (RFC 9116 advice)');
  assert.ok(fields.includes('Canonical: https://www.helm.events/.well-known/security.txt'));
  assert.ok(!/OWNER ACTION|TODO|works today|provisioned|MONITORED/i.test(txt), 'internal owner notes must not ship');
  assert.ok(!/github\.com/i.test(txt), 'no GitHub advisory channel until private reporting is verified');
  for (const l of fields) assert.match(l, /^(Contact|Expires|Encryption|Acknowledgments|Preferred-Languages|Canonical|Policy|Hiring|CSAF):\s\S/, 'unknown field: ' + l);
});

t('microphone: only /chat and the crew work link may use it (voice notes), self only; camera stays off everywhere', () => {
  const MIC = (p) => p === '/chat' || p === '/chat.html' || p === '/work' || p === '/work.html' || /^\/[a-z0-9-]+\/work\/[^/]+$/.test(p);
  for (const p of paths) {
    const want = MIC(p) ? /microphone=\(self\)/ : /microphone=\(\)/;
    for (const [host, h] of [['vercel.json', vercelHeaders(p)], ['_headers', netlifyHeaders(p)], ['server.js', serverHeaders(p.replace(/\.html$/, ''))]]) {
      const pp = h['permissions-policy'];
      assert.match(pp, /camera=\(\)/, host + ': camera must stay off on ' + p);
      assert.match(pp, /geolocation=\(\)/); assert.match(pp, /payment=\(\)/);
      assert.match(pp, want, host + ': ' + (MIC(p) ? 'needs' : 'must not have') + ' the microphone: ' + p);
    }
  }
  // the routes really are covered (branded crew link included), and nothing else is
  for (const p of ['/work', '/work.html', '/aurora-events/work/tok-123', '/chat', '/chat.html'])
    assert.match(vercelHeaders(p)['permissions-policy'], /microphone=\(self\)/, p);
  for (const p of ['/aurora-events/portal/tok-123', '/aurora-events/quote/tok-123', '/workers', '/dashboard'])
    assert.match(vercelHeaders(p)['permissions-policy'], /microphone=\(\)/, p);
  // the pages that record really ask for the microphone (so the rule is needed)
  assert.match(readFileSync(join(PUB, 'chat.html'), 'utf8'), /getUserMedia\(\{audio:true\}\)/);
  assert.match(readFileSync(join(PUB, 'work.html'), 'utf8'), /getUserMedia\(\{audio:true\}\)/);
});

console.log(`headers-parity: ${n} assertion group(s) passed.`);

/* ---- no wildcard ACAO anywhere; legacy *.vercel.app aliases are noindex ---- */
{
  for (const r of vercel.headers) for (const h of r.headers) {
    if (h.key.toLowerCase() === 'access-control-allow-origin') assert.notEqual(h.value.trim(), '*', 'vercel.json must not send wildcard ACAO');
  }
  assert.equal(vercelHeaders('/store-api.js')['access-control-allow-origin'], 'https://www.helm.events');
  for (const host of ['helm-v01.vercel.app', 'helm-alpha-nine.vercel.app']) {
    const r = vercel.headers.find((x) => x.has && x.has.some((c) => c.type === 'host' && c.value === host));
    assert.ok(r && r.source === '/(.*)' && /noindex/.test(r.headers.find((h) => h.key === 'X-Robots-Tag').value), host + ' must be noindex');
  }
  console.log('ok — no wildcard ACAO; legacy aliases noindex');
}
