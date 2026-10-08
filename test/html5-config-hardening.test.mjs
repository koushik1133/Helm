#!/usr/bin/env node
/* ============================================================================
 * html5-config-hardening.test.mjs — Security audit Phase 9 (HTML5 / client-side)
 * plus configuration / transport / information-gathering leftovers.
 *
 *   CSP-01   no whole-CDN script-src host; CDN paths builder-only; no unsafe-eval
 *   REF-01   client-link (token) pages: no-referrer (meta + header), no-store
 *   TEL-01   telemetry redaction scrubs link tokens in paths, queries, breadcrumbs
 *   FILE-01  internal files never deployed; public/ file-type allowlist (CI guard)
 *   HSTS-01  HSTS on every response incl. the project-served apex redirect
 *   STOR-01  web storage values are validated before use (config.js, builder theme)
 *   MSG-01   postMessage: listeners check origin, senders target an explicit origin
 *   CORS-01  no permissive CORS header on any static/HTML route
 *   MEDIA-01 invite music https-only, no third-party demo host; proposal images https-only
 *   CSV-01   CSV formula-injection guard (incl. leading whitespace / full-width forms)
 * ========================================================================== */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUB = join(ROOT, 'public');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const require = createRequire(import.meta.url);
const { SCRIPT_SRC_BASE, SCRIPT_SRC_BUILDER, scriptHosts, scriptSrcProblem } = require('../scripts/csp-hashes.cjs');
const server = require('../server.js');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

const vercel = JSON.parse(read('vercel.json'));
const headersFile = read('public/_headers');

// path-to-regexp (v6) subset used by vercel.json: ":name*", ":name", "(regex)", "\\."
function vercelRe(src) {
  const re = src
    .replace(/\/:[a-z]+\*/gi, '(?:/(.*))?')
    .replace(/:[a-z]+\(([^)]*)\)/gi, '($1)')
    .replace(/:[a-z]+/gi, '([^/]+)');
  return new RegExp('^' + re + '$');
}
function vercelHeaders(p) {
  const o = {};
  for (const r of vercel.headers) if (vercelRe(r.source).test(p)) for (const h of r.headers) o[h.key.toLowerCase()] = h.value;
  return o;
}
// every CSP in all three places: [where, route, value]
function allPolicies() {
  const out = [];
  for (const r of vercel.headers) for (const h of r.headers) if (h.key.toLowerCase() === 'content-security-policy') out.push(['vercel.json', r.source, h.value]);
  let route = '';
  for (const line of headersFile.split('\n')) {
    if (line.trim() && !line.trim().startsWith('#') && !/^\s/.test(line)) route = line.trim();
    const m = /^\s+Content-Security-Policy:\s*(.*)$/.exec(line);
    if (m) out.push(['_headers', route, m[1]]);
  }
  for (const [k, v] of Object.entries(server.CSP)) out.push(['server.js', k === 'builder' ? '/builder' : k === 'auth' ? '/login' : '/' + k, v]);
  return out;
}
// CSP3 source-expression match for host+path sources (no wildcards needed here).
function sourceAllows(src, url) {
  if (!/^https:\/\//.test(src)) return false;
  const s = new URL(src), u = new URL(url);
  if (s.host !== u.host || u.protocol !== 'https:') return false;
  if (s.pathname === '/' && !src.endsWith('/') ) return true;            // bare host
  if (src.replace(/^https:\/\/[^/]+/, '') === '') return true;            // bare host, no slash
  return s.pathname.endsWith('/') ? u.pathname.startsWith(s.pathname) : u.pathname === s.pathname;
}
const scriptAllowed = (csp, url) => (scriptHosts(csp) || []).some((s) => sourceAllows(s, url));

/* ------------------------------------------------------------------ CSP-01 */
t('CSP-01: every policy (vercel.json, _headers, server.js) uses only the shared script-src allowlist', () => {
  const pol = allPolicies();
  assert.ok(pol.length >= 30, 'expected all policies to be found, got ' + pol.length);
  for (const [where, route, csp] of pol) assert.equal(scriptSrcProblem(csp, route), '', `${where} ${route}`);
});

t('CSP-01: no whole-CDN host source anywhere; no unsafe-eval / unsafe-inline in script-src', () => {
  for (const [where, route, csp] of allPolicies()) {
    for (const h of scriptHosts(csp)) {
      assert.ok(!/^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|browser\.sentry-cdn\.com)\/?$/.test(h), `${where} ${route}: bare CDN host ${h}`);
      assert.ok(!/^'unsafe-(eval|inline)'$|^'wasm-unsafe-eval'$|^\*$|^https:$/.test(h), `${where} ${route}: ${h}`);
    }
  }
});

t('CSP-01: CDN script paths only on the builder; the builder loads exactly what it needs', () => {
  const b3d = read('public/builder-3d.js');
  const urls = [...b3d.matchAll(/'(https:\/\/[^']+\.js)'/g)].map((m) => m[1]);
  assert.ok(urls.length >= 5, 'builder-3d.js CDN URLs not found');
  for (const u of urls) assert.match(b3d, new RegExp(u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "',?\\s*'sha384-"), `SRI missing for ${u}`);
  const builder = vercelHeaders('/builder')['content-security-policy'];
  const dash = vercelHeaders('/dashboard')['content-security-policy'];
  for (const u of urls) {
    assert.ok(scriptAllowed(builder, u), `builder CSP must allow ${u}`);
    assert.ok(!scriptAllowed(dash, u), `non-builder CSP must not allow ${u}`);
  }
  // gadget libraries on the same CDNs stay blocked even on the builder
  for (const g of ['https://cdnjs.cloudflare.com/ajax/libs/angular.js/1.0.8/angular.min.js',
    'https://cdn.jsdelivr.net/npm/angular@1.0.8/angular.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/three.js/r127/three.min.js']) assert.ok(!scriptAllowed(builder, g), g);
  // Sentry bundle (dormant) allowed by the pinned directory only
  const sentry = /sc\.src = '([^']+)'/.exec(read('public/telemetry.js'))[1];
  assert.ok(scriptAllowed(dash, sentry), 'pinned Sentry bundle must stay loadable when a DSN is set');
  assert.ok(!scriptAllowed(dash, 'https://browser.sentry-cdn.com/7.0.0/bundle.min.js'));
  assert.deepEqual(SCRIPT_SRC_BUILDER.slice(0, SCRIPT_SRC_BASE.length), SCRIPT_SRC_BASE);
});

t('CSP-01: gen-csp rejects a whole-CDN host on a non-builder route', () => {
  assert.notEqual(scriptSrcProblem("script-src 'self' https://cdnjs.cloudflare.com", '/(.*)'), '');
  assert.notEqual(scriptSrcProblem("script-src 'self' https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/", '/dashboard'), '');
  assert.equal(scriptSrcProblem("script-src 'self' https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/", '/builder'), '');
  assert.notEqual(scriptSrcProblem("script-src 'self' 'unsafe-eval'", '/builder'), '');
  // Turnstile CAPTCHA is permitted on sign-in / reset pages only
  assert.equal(scriptSrcProblem("script-src 'self' https://challenges.cloudflare.com", '/login'), '');
  assert.notEqual(scriptSrcProblem("script-src 'self' https://challenges.cloudflare.com", '/dashboard'), '');
});

/* ------------------------------------------------------------------ REF-01 */
const TOKEN_PAGES = ['approve', 'portal', 'proposal-view', 'work', 'invite'];
t('REF-01: every client-link page carries <meta name="referrer" content="no-referrer">', () => {
  for (const p of TOKEN_PAGES) assert.match(read(`public/${p}.html`), /<meta name="referrer" content="no-referrer">/, p);
  assert.deepEqual([...server.TOKEN_PAGES].sort(), [...TOKEN_PAGES].sort());
});
t('REF-01: token routes send Referrer-Policy no-referrer + Cache-Control no-store, private (vercel.json)', () => {
  const routes = ['/i', '/i/our-wedding', ...TOKEN_PAGES.map((p) => '/' + p), ...TOKEN_PAGES.map((p) => `/${p}.html`),
    ...['invite', 'quote', 'proposal', 'portal', 'work'].map((k) => `/aurora-events/${k}/0b8c2f1e-1111-4222-8333-944445555666`)];
  for (const r of routes) {
    const h = vercelHeaders(r);
    assert.equal(h['referrer-policy'], 'no-referrer', r);
    assert.equal(h['cache-control'], 'no-store, private', r);
  }
  // static assets keep long-lived caching; app HTML is not marked immutable
  assert.match(vercelHeaders('/store-api.js')['cache-control'], /immutable/);
  assert.match(vercelHeaders('/vendor/supabase-js-2.117.2.min.js')['cache-control'], /immutable/);
  assert.equal(vercelHeaders('/config.js')['cache-control'], 'public, max-age=300, stale-while-revalidate=3600');
  assert.ok(!/immutable/.test(vercelHeaders('/dashboard')['cache-control'] || ''));
});

/* ------------------------------------------------------------------ TEL-01 */
function loadTelemetry(cfg) {
  const captured = {};
  const doc = { head: { appendChild: (s) => { captured.script = s; } }, createElement: () => ({}) };
  const w = { HELM_TELEMETRY: cfg, addEventListener() {}, document: doc };
  const ctx = { window: w, document: doc, location: { pathname: '/aurora-events/quote/0b8c2f1e-1111-4222-8333-944445555666', reload() {} }, navigator: {}, console };
  vm.createContext(ctx);
  vm.runInContext(read('public/telemetry.js'), ctx);
  return { T: w.HelmTelemetry, w, captured };
}
const UUID = '0b8c2f1e-1111-4222-8333-944445555666';
t('TEL-01: redact() scrubs client-link tokens in URL paths and query strings', () => {
  const { T } = loadTelemetry({});
  const cases = [
    [`https://www.helm.events/aurora-events/quote/${UUID}`, /\/aurora-events\/quote\/\[REDACTED\]$/],
    ['/aurora-events/work/crew-tok_ABC123?x=1', /^\/aurora-events\/work\/\[REDACTED\]\?x=1$/],
    ['/my-studio/portal/abc', /portal\/\[REDACTED\]/], ['/s1/proposal/abc', /proposal\/\[REDACTED\]/], ['/s1/invite/our-day', /invite\/\[REDACTED\]/],
    ['https://www.helm.events/i/priya-and-arjun', /\/i\/\[REDACTED\]$/],
    ['/approve?token=secret123&x=2', /token=\[REDACTED\]&x=2/],
    ['/work?t=secret123', /t=\[REDACTED\]/],
    ['/login#access_token=abc.def&refresh_token=zzz', /access_token=\[REDACTED\]&refresh_token=\[REDACTED\]/],
    [`load failed for ${UUID}`, /\[UUID_REDACTED\]/],
  ];
  for (const [inp, want] of cases) {
    const out = T.redact(inp);
    assert.match(out, want, inp + ' -> ' + out);
    assert.ok(!/secret123|0b8c2f1e|priya|crew-tok|our-day/.test(out), 'token survived: ' + out);
  }
  // ordinary paths are left alone
  assert.equal(T.redact('/dashboard?tab=events'), '/dashboard?tab=events');
  assert.equal(T.redact('https://www.helm.events/store-api.js:12:5'), 'https://www.helm.events/store-api.js:12:5');
});
t('TEL-01: Sentry beforeSend + beforeBreadcrumb scrub request URL, Referer, transaction and breadcrumbs', () => {
  const { w, captured } = loadTelemetry({ dsn: 'https://k@o1.ingest.sentry.io/1' });
  assert.ok(captured.script && captured.script.onload, 'Sentry loader must be armed when a DSN is set');
  let opts = null;
  w.Sentry = { init: (o) => { opts = o; } };
  captured.script.onload();
  assert.ok(opts && typeof opts.beforeSend === 'function' && typeof opts.beforeBreadcrumb === 'function');
  assert.equal(opts.sendDefaultPii, false);
  const ev = opts.beforeSend({
    message: `boom at /s1/quote/${UUID}`,
    transaction: '/s1/work/tok999',
    request: { url: `https://www.helm.events/approve?token=${UUID}`, query_string: `token=${UUID}`, headers: { Referer: `https://www.helm.events/s1/portal/${UUID}`, 'User-Agent': 'x' } },
    exception: { values: [{ value: 'fetch /i/our-wedding failed' }] },
    breadcrumbs: [{ category: 'navigation', data: { from: '/i/our-wedding', to: `/s1/proposal/${UUID}` } },
      { category: 'fetch', data: { url: `https://x.supabase.co/rest/v1/rpc/get?token=${UUID}`, method: 'POST' } }],
  });
  const s = JSON.stringify(ev);
  assert.ok(!/0b8c2f1e|tok999|our-wedding/.test(s), 'token survived beforeSend: ' + s);
  assert.equal(ev.request.headers.Referer, '[REDACTED]');
  const crumb = opts.beforeBreadcrumb({ category: 'navigation', message: `to /s1/invite/abc`, data: { from: '/dashboard', to: '/i/slug-x' } });
  assert.ok(!/slug-x|\/invite\/abc/.test(JSON.stringify(crumb)));
  assert.equal(crumb.data.from, '/dashboard');
  // the Sentry values envelope form ({ values: [...] }) is handled too
  const ev2 = opts.beforeSend({ breadcrumbs: { values: [{ data: { url: '/i/secret-slug' } }] } });
  assert.ok(!/secret-slug/.test(JSON.stringify(ev2)));
});

/* ------------------------------------------------------------------ FILE-01 */
const ALLOWED_EXT = new Set(['.html', '.js', '.css', '.png', '.webp', '.ico', '.svg', '.woff2', '.txt', '.xml', '.jpg', '.jpeg', '.gif']);
const ALLOWED_EXTRA = new Set(['_headers', 'vendor/README.md', '.well-known/security.txt']);   // must be .vercelignored if not servable
const FORBIDDEN = /(\.(md|map|sql|bak|env|log|orig|swp|zip|tgz|gz|pem|key|sqlite|db)$)|(^|\/)\.env|(^|\/)\.DS_Store$|~$/i;
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else out.push(relative(PUB, p).split('\\').join('/'));
  }
  return out;
}
let tracked = null;
try { tracked = execFileSync('git', ['ls-files', 'public'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => f.slice('public/'.length)); } catch { /* not a git checkout */ }
t('FILE-01: public/ holds only deployable file types (CI guard: no .md/.map/.sql/.bak/.env/.log/.DS_Store)', () => {
  const files = new Set([...walk(PUB), ...(tracked || [])]);
  const bad = [];
  for (const f of files) {
    if (ALLOWED_EXTRA.has(f)) continue;
    if (basename(f) === '.DS_Store') { if (tracked && tracked.includes(f)) bad.push(f + ' (tracked)'); continue; }   // local OS junk: gitignored + vercelignored
    if (FORBIDDEN.test(f) || !ALLOWED_EXT.has(extname(f).toLowerCase())) bad.push(f);
  }
  assert.deepEqual(bad, [], 'unexpected files in public/ (move them out, or allowlist + .vercelignore them): ' + bad.join(', '));
});
t('FILE-01: internal files are excluded from the Vercel upload and 404/redirected if requested', () => {
  const ign = read('.vercelignore').split('\n').map((l) => l.trim());
  for (const f of ['public/_headers', 'public/vendor/README.md', '**/.DS_Store']) assert.ok(ign.includes(f), '.vercelignore must list ' + f);
  for (const f of ALLOWED_EXTRA) {
    if (/\.(html|js|css|txt|xml)$/.test(f)) continue;     // servable by design (security.txt)
    assert.ok(ign.includes('public/' + f), f + ' is allowlisted but not .vercelignored');
  }
  const redirectFor = (p) => (vercel.redirects || []).find((r) => !r.has && vercelRe(r.source).test(p));
  for (const p of ['/_headers', '/vendor/README.md', '/docs/notes.md', '/app.js.map', '/dump.sql', '/x.bak', '/debug.log', '/.DS_Store', '/vendor/.DS_Store']) {
    const r = redirectFor(p);
    assert.ok(r, 'no vercel.json redirect for ' + p);
    assert.equal(r.destination, '/404', p);
  }
  for (const p of ['/', '/dashboard', '/store-api.js', '/robots.txt', '/i/x', '/aurora/quote/abc', '/.well-known/security.txt', '/manual'])
    assert.ok(!redirectFor(p), p + ' must not be redirected');
  // the manual moved behind sign-in: the old public URLs go to the gated /manual page
  for (const p of ['/docs/USER-MANUAL', '/docs/USER-MANUAL.html', '/docs/screenshots/index.webp'])
    assert.equal((redirectFor(p) || {}).destination, '/manual', p + ' must redirect to /manual');
  // local dev mirrors it
  for (const p of ['/_headers', '/vendor/README.md', '/x.map', '/a/.DS_Store']) assert.ok(server.isInternalFile(p), p);
  for (const p of ['/dashboard.html', '/store-api.js', '/robots.txt', '/vendor/supabase-js-2.117.2.min.js']) assert.ok(!server.isInternalFile(p), p);
  assert.ok(read('.gitignore').split('\n').includes('.DS_Store'));
});

/* ------------------------------------------------------------------ HSTS-01 */
t('HSTS-01: full HSTS (2y; includeSubDomains; preload) on every vercel.json-served response', () => {
  const HSTS = 'max-age=63072000; includeSubDomains; preload';
  assert.equal(vercel.headers[0].source, '/(.*)');
  assert.equal(vercel.headers[0].headers.find((h) => h.key === 'Strict-Transport-Security').value, HSTS);
  for (const r of vercel.headers.slice(1)) assert.ok(!r.headers.some((h) => h.key.toLowerCase() === 'strict-transport-security'), r.source + ' overrides HSTS');
  for (const p of ['/', '/_headers', '/i/x', '/aurora/work/t', '/store-api.js']) assert.equal(vercelHeaders(p)['strict-transport-security'], HSTS, p);
  assert.match(headersFile, /^\s+Strict-Transport-Security: max-age=63072000; includeSubDomains; preload$/m);
  assert.equal(server.SECURITY_HEADERS['Strict-Transport-Security'], HSTS);
});
t('HSTS-01: apex helm.events → www redirect is project-served (permanent, host-matched) so it carries HSTS', () => {
  const r = (vercel.redirects || []).find((x) => x.has && x.has.some((h) => h.type === 'host' && h.value === 'helm.events'));
  assert.ok(r, 'missing host-matched apex redirect');
  assert.equal(r.source, '/:path*'); assert.equal(r.destination, 'https://www.helm.events/:path*'); assert.equal(r.permanent, true);
  assert.equal(vercel.redirects.indexOf(r), 0, 'apex redirect must come first');
  assert.ok(vercelRe(r.source).test('/') && vercelRe(r.source).test('/aurora/quote/x'));
});

/* ------------------------------------------------------------------ STOR-01 */
function evalConfig(hostname, ls = {}, win = {}, src = read('public/config.js')) {
  const store = { ...ls };
  const w = { location: { hostname }, localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
    console: { info() {}, warn() {}, error() {}, log() {} }, ...win };
  w.window = w;
  const ctx = { window: w, location: w.location, localStorage: w.localStorage, console: w.console };
  vm.createContext(ctx); vm.runInContext(src, ctx);
  return w.SUPABASE_CONFIG;
}
const PROD_REF = 'nqltzgiwznphugcfhmbm';
t('STOR-01: production hosts can never select staging or a storage/window override', () => {
  const evil = JSON.stringify({ url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'x' });
  for (const h of ['www.helm.events', 'helm.events', 'helm-v01.vercel.app', 'helm-alpha-nine.vercel.app']) {
    const c = evalConfig(h, { 'helm.staging': evil, 'helm.allowProdFromLocalhost': '1' },
      { HELM_STAGING_SUPABASE: { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'y' } });
    assert.ok(c.url.includes(PROD_REF) && !c.__staging, h + ' -> ' + c.url);
  }
});
t('STOR-01: the localStorage staging override is honoured only for a real https Supabase project URL', () => {
  const blank = read('public/config.js').replace(/window\.SUPABASE_STAGING = \{[\s\S]*?\};/, 'window.SUPABASE_STAGING = { url: "", anonKey: "", hosts: [] };');
  for (const url of ['javascript:alert(1)//.supabase.co', 'https://evil.example.com', 'http://abcdefghijklmnopqrst.supabase.co',
    'https://abcdefghijklmnopqrst.supabase.co.evil.com', 'https://abcdefghijklmnopqrst.supabase.co/x', 'data:text/html,x']) {
    const c = evalConfig('localhost', { 'helm.staging': JSON.stringify({ url, anonKey: 'k' }) }, {}, blank);
    assert.equal(c.url, '', 'must fail closed for ' + url);
  }
  const ok = evalConfig('localhost', { 'helm.staging': JSON.stringify({ url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'k' }) }, {}, blank);
  assert.equal(ok.url, 'https://abcdefghijklmnopqrst.supabase.co');
  assert.ok(!evalConfig('localhost', { 'helm.staging': '{not json' }, {}, blank).url);
});
t('STOR-01: theme values read from storage are allowlisted before reaching the DOM', () => {
  assert.match(read('public/builder.html'), /setAttribute\('data-theme', t === 'dark' \? 'dark' : 'light'\)/);
  assert.match(read('public/store-api.js'), /if \(t === "dark" \|\| t === "light"\) document\.documentElement\.setAttribute\("data-theme", t\)/);
});

/* ------------------------------------------------------------------ MSG-01 */
function pageSources() {
  return readdirSync(PUB).filter((f) => /\.(html|js)$/.test(f)).map((f) => [f, readFileSync(join(PUB, f), 'utf8')]);
}
t('MSG-01: every window "message" listener checks event.origin first', () => {
  let n = 0;
  for (const [f, s] of pageSources()) {
    for (const m of s.matchAll(/(\w+)\.addEventListener\(\s*["']message["']\s*,\s*(?:async\s*)?\(?(\w+)\)?\s*=>\s*\{([^\n]*)/g)) {
      if (/BC$|Channel/i.test(m[1])) continue;        // BroadcastChannel is same-origin by spec
      n++;
      assert.match(m[3], new RegExp(`^\\s*if\\s*\\(\\s*${m[2]}\\.origin\\s*!==\\s*location\\.origin\\s*\\)\\s*return;`), `${f}: message listener must reject foreign origins first`);
    }
    const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`])\/\/[^\n]*/g, '$1');
    assert.ok(!/\bonmessage\s*=/.test(code), `${f}: use addEventListener with an origin check, not onmessage=`);
  }
  assert.ok(n >= 1, 'expected the invite preview listener');
});
t('MSG-01: every postMessage to a window targets an explicit origin (never "*")', () => {
  let n = 0;
  for (const [f, s] of pageSources()) {
    for (const m of s.matchAll(/([\w.]+)\.postMessage\(/g)) {
      if (/BC$|Channel/i.test(m[1])) continue;
      n++;
      let i = m.index + m[0].length, depth = 1;
      while (depth && i < s.length) { const c = s[i++]; if ('([{'.includes(c)) depth++; else if (')]}'.includes(c)) depth--; }
      const args = s.slice(m.index + m[0].length, i - 1);
      assert.match(args, /,\s*location\.origin\s*$/, `${f}: postMessage must target location.origin: ${args.slice(-60)}`);
    }
  }
  assert.ok(n >= 1, 'expected the invite-studio preview sender');
});

/* ------------------------------------------------------------------ CORS-01 */
t('CORS-01: static/HTML routes send no wildcard ACAO — only the pinned canonical origin, no other Access-Control-* (vercel.json, _headers, server.js)', () => {
  // Vercel's CDN adds ACAO:* to static files by default; we override it with the canonical origin.
  const ok = (k, v) => !/^access-control-/i.test(k) || (/^access-control-allow-origin$/i.test(k) && v === 'https://www.helm.events');
  for (const r of vercel.headers) for (const h of r.headers) assert.ok(ok(h.key, h.value), r.source + ' ' + h.key);
  for (const m of headersFile.matchAll(/^\s+(Access-Control-[\w-]+):\s*(.*)$/gim)) assert.ok(ok(m[1], m[2].trim()), '_headers ' + m[1]);
  for (const p of ['dashboard', 'approve', 'invite', 'index']) {
    const h = server.securityHeadersFor({ headers: { host: 'www.helm.events' } }, join(PUB, p + '.html'));
    for (const k of Object.keys(h)) assert.ok(ok(k, h[k]), p + ' ' + k);
  }
});

/* ------------------------------------------------------------------ MEDIA-01 */
t('MEDIA-01: invite music is https-only and no third-party demo host is bundled', () => {
  const inv = read('public/invite.html'), studio = read('public/invite-studio.html');
  const m = /const safeMusic=(u=>[^;]+);/.exec(inv);
  assert.ok(m, 'safeMusic guard must exist');
  const safeMusic = vm.runInNewContext(m[1]);
  assert.equal(safeMusic('https://cdn.example.com/song.mp3'), 'https://cdn.example.com/song.mp3');
  for (const bad of ['http://x/a.mp3', 'javascript:alert(1)', 'data:audio/mp3;base64,AA', '/local.mp3', '//x/a.mp3', 'https://x/a b"', null, 42, ['https://x']])
    assert.equal(safeMusic(bad), '', String(bad));
  assert.ok(!/\$\("#audio"\)\.src\s*=\s*d\.music/.test(inv), 'raw d.music must not reach the <audio> src');
  assert.match(inv, /\$\("#audio"\)\.src=music;/);
  for (const s of [inv, studio]) assert.ok(!/soundhelix/i.test(s), 'third-party demo music host still referenced');
  assert.match(studio, /if\(!u \|\| u\.protocol!=="https:"\)/, 'studio preview keeps its https check');
});
t('MEDIA-01: proposal.html loads only https:// inspiration images', () => {
  const p = read('public/proposal.html');
  const m = /const safeImg=(u=>[^;]+);/.exec(p);
  assert.ok(m, 'safeImg guard must exist');
  const safeImg = vm.runInNewContext(m[1]);
  assert.ok(safeImg('https://img.example.com/a.jpg'));
  for (const bad of ['http://x/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AA', '//x/a.jpg', ' https://x/a"onerror=1', null]) assert.ok(!safeImg(bad), String(bad));
  const g = /function renderGallery\(\)\{([\s\S]*?)\n/.exec(p)[1];
  assert.match(g, /\$\{safeImg\(u\)\?`<img class="thumb" src="\$\{esc\(u\.trim\(\)\)\}"/, 'gallery <img> must be gated by safeImg');
  assert.match(p, /if\(!r\.ok\|\|!safeImg\(r\.value\)\)/, 'adding an image must require https');
});

/* ------------------------------------------------------------------ CSV-01 */
t('CSV-01: CSV export neutralises formula cells, incl. leading whitespace and full-width forms', () => {
  const src = read('public/reports.html');
  const m = /function toCSV\(rows\)\{[\s\S]*?\n    return [^\n]*\}/.exec(src);
  assert.ok(m, 'toCSV must exist');
  const toCSV = vm.runInNewContext('(' + m[0] + ')');
  const cellOf = (v) => toCSV([{ a: v }]).split('\n')[1];
  for (const v of ['=HYPERLINK("http://x","y")', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1', ' =1+1', '  @x', '\u00a0=1', '\u3000=1', '\uff1d1+1', '\uff0b1', '\uff0d1', '\uff20x', '\n=1'])
    assert.match(cellOf(v), /^"?'/, `not neutralised: ${JSON.stringify(v)} -> ${cellOf(v)}`);
  // numbers and ordinary text are untouched
  assert.equal(cellOf(-5), '-5');
  assert.equal(cellOf('Hello, world'), '"Hello, world"');
  assert.equal(cellOf('a "quote"'), '"a ""quote"""');
  assert.equal(cellOf('Plain'), 'Plain');
});

/* ------------------------------------------------------------------ STYLE-01 / SIM-01 / CORS-02 */
t("STYLE-01: no 'unsafe-inline' in style-src / style-src-elem anywhere; only style-src-attr keeps it", () => {
  const pols = [];
  for (const r of vercel.headers) for (const h of r.headers) if (/^content-security-policy$/i.test(h.key)) pols.push(['vercel ' + r.source, h.value]);
  for (const m of headersFile.matchAll(/^\s+Content-Security-Policy:\s*(.*)$/gm)) pols.push(['_headers', m[1]]);
  for (const p of ['dashboard', 'login', 'invite', 'builder', 'index'])
    pols.push(['server ' + p, server.securityHeadersFor({ headers: { host: 'www.helm.events' } }, join(PUB, p + '.html'))['Content-Security-Policy']]);
  assert.ok(pols.length > 10);
  for (const [where, csp] of pols) {
    const d = Object.fromEntries(csp.split(';').map((x) => x.trim().split(/\s+/)).map((p) => [p[0], p.slice(1)]));
    for (const k of ['style-src', 'style-src-elem']) {
      assert.ok(d[k], where + ' missing ' + k);
      assert.ok(!d[k].includes("'unsafe-inline'"), where + ' ' + k + " has 'unsafe-inline'");
      assert.ok(d[k].some((x) => /^'sha256-/.test(x)), where + ' ' + k + ' has no <style> hashes');
    }
    assert.deepEqual(d['style-src-attr'], ["'unsafe-inline'"], where);
  }
});
t('STYLE-01: runtime CSS uses constructable sheets, not new inline <style> elements', () => {
  for (const f of ['manual.js', 'tour.js', 'hq-invoice.js', 'store-api.js']) {
    const src = read('public/' + f);
    assert.match(src, /function __helmAdoptCss\(doc, css\)/, f);
    assert.equal((src.match(/createElement\(["']style["']\)/g) || []).length, 1, f + ': only the fallback may create <style>');
  }
});
t('SIM-01: /sim-pay is redirected to /404 on every production host (staging + local keep it)', () => {
  for (const host of ['helm.events', 'www.helm.events', 'helm-v01.vercel.app', 'helm-alpha-nine.vercel.app']) {
    for (const p of ['/sim-pay', '/sim-pay.html']) {
      const r = vercel.redirects.find((x) => x.has && x.has.some((h) => h.type === 'host' && h.value === host) && vercelRe(x.source).test(p) && x.destination === '/404');
      assert.ok(r, host + p);
    }
  }
  assert.ok(!vercel.redirects.some((x) => !x.has && vercelRe(x.source).test('/sim-pay')), 'staging must keep /sim-pay');
  assert.equal(vercel.redirects[0].has[0].value, 'helm.events', 'apex redirect still first');
});
t('CORS-02 / HSTS-01: server.js local API sends no Access-Control-* and carries HSTS', () => {
  const src = read('server.js');
  // Only the pinned static-asset ACAO (canonical origin) may appear — never '*', never credentials.
  const acao = [...src.matchAll(/'Access-Control-Allow-Origin':\s*'([^']*)'/g)].map((m) => m[1]);
  assert.deepEqual(acao, ['https://www.helm.events']);
  assert.ok(!/Access-Control-Allow-(Credentials|Headers|Methods)/.test(src));
  assert.ok((src.match(/includeSubDomains; preload/g) || []).length >= 4);
});

console.log(`\nhtml5-config-hardening: ${passed} test(s) passed.`);
