// hq-private.test.mjs — Helm HQ (0029) stays private and hardened at the edge.
//  * /hq and /hq.html are noindex + no-store in vercel.json, _headers and server.js
//  * hq.html has no inline <script> (CSP stays hash-only) and loads hq.js
//  * no other page, the sitemap or robots.txt links to /hq
//  * hq.js never uses innerHTML; the DB migration + suite are wired in
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('ok - ' + name); } catch (e) { fail++; console.log('not ok - ' + name + ': ' + e.message); } };
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };

t('vercel.json: /hq and /hq.html are noindex + no-store', () => {
  const v = JSON.parse(rd('vercel.json'));
  for (const path of ['/hq', '/hq.html']) {
    const hit = v.headers.filter((h) => new RegExp('^' + h.source.replace(/:(\w+)\*/g, '.*') + '$').test(path));
    const all = hit.flatMap((h) => h.headers);
    assert(all.some((h) => h.key === 'X-Robots-Tag' && /noindex/.test(h.value)), path + ' not noindex');
    assert(all.some((h) => h.key === 'Cache-Control' && /no-store/.test(h.value)), path + ' not no-store');
    assert(all.some((h) => h.key === 'Content-Security-Policy'), path + ' has no CSP');
  }
});
t('_headers: /hq and /hq.html are noindex + no-store', () => {
  const h = rd('public/_headers');
  for (const p of ['/hq', '/hq.html']) assert(new RegExp('^' + p.replace('.', '\\.') + '\\n  X-Robots-Tag: noindex[^\\n]*\\n  ! Cache-Control\\n  Cache-Control: no-store', 'm').test(h), p);
});
t('server.js: hq.html gets noindex + no-store', () => {
  const s = createRequire(import.meta.url)(join(ROOT, 'server.js'));
  const h = s.securityHeadersFor({ url: '/hq', headers: {} }, join(ROOT, 'public', 'hq.html'));
  assert(/noindex/.test(h['X-Robots-Tag'] || ''), 'no noindex');
  assert(s.cacheControlFor(join(ROOT, 'public', 'hq.html'), '') === 'no-store', 'not no-store');
});
t('hq.html: no inline script, loads hq.js, robots meta noindex', () => {
  const h = rd('public/hq.html');
  assert(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(h), 'inline script present');
  assert(/<script src="hq\.js/.test(h), 'hq.js not loaded');
  assert(/name="robots" content="noindex/.test(h), 'robots meta missing');
});
const OPERATOR_TO_HQ = /async function operatorToHq\(\) \{\n\s*if \(!\(await isPlatformAdmin\(\)\)\) return false;\n\s*try \{ location\.replace\("\/hq"\); \} catch \(e\) \{\}\n\s*return true;\n\s*\}/;
t('nothing links to /hq (pages, sitemap, robots, llms.txt)', () => {
  const files = readdirSync(join(ROOT, 'public')).filter((f) => /\.(html|js|txt|xml)$/.test(f) && !/^hq\.(html|js)$/.test(f));
  // One sanctioned exception (owner request, auth-gate fix): store-api.js operatorToHq()
  // sends an account with NO studio to HQ, and only after is_platform_admin() said true.
  // It is stripped before the scan and pinned by the next test.
  const src = (f) => { const s = rd('public/' + f); return f === 'store-api.js' ? s.replace(OPERATOR_TO_HQ, '') : s; };
  const bad = files.filter((f) => /(href|src|location[^;]{0,40})\s*=?\s*["'`]\/?hq(\.html)?["'?#`]/.test(src(f)) || /\/hq(\.html)?\b/.test(f.endsWith('.xml') || f.endsWith('.txt') ? rd('public/' + f) : ''));
  assert(!bad.length, 'linked from: ' + bad.join(', '));
});
t('the only HQ redirect is store-api operatorToHq(), gated on is_platform_admin() (never an href)', () => {
  const s = rd('public/store-api.js');
  assert(OPERATOR_TO_HQ.test(s), 'operatorToHq() shape changed');
  const all = s.match(/["'`]\/hq(\.html)?["'?#`]/g) || [];
  assert(all.length === 1, 'exactly one HQ path literal in store-api.js (found ' + all.length + ')');
  // HQ is only considered for an account with NO studio (routeNoStudio follows a confirmed null org)
  assert(/if \(!oid\) \{ await routeNoStudio\(\); return HANG\(\); \}/.test(s), 'gate asks only when no studio');
});
t('hq.js: no innerHTML / insertAdjacentHTML / eval', () => {
  const j = rd('public/hq.js');
  assert(!/innerHTML|outerHTML|insertAdjacentHTML|\beval\(|new Function/.test(j), 'unsafe sink');
});
t('DB: 0029 is in the MANIFEST and the platform-admin suite is wired into run-all', () => {
  assert(/forward\s+supabase\/migrations\/0029_platform_admin\.sql/.test(rd('supabase/migrations/MANIFEST')), 'manifest');
  assert(/tests\/db\/platform-admin\.sql/.test(rd('scripts/db-test/run-all.sh')), 'run-all');
});
console.log(`\nhq-private: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
