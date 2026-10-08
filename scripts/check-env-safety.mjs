#!/usr/bin/env node
/* ============================================================================
 * check-env-safety.mjs — guards environment separation (finding ENV / DEPLOY-02).
 *
 * Wave 3 found that pages served from localhost connected directly to the
 * PRODUCTION Supabase project. Wave 4 added a fail-closed localhost guard in
 * public/config.js that blanks the Supabase credentials on localhost unless the
 * operator explicitly opts in. This guard makes sure that protection cannot be
 * silently removed and that no service_role secret is committed.
 *
 * READ-ONLY. Fails (exit 1) when config.js loses the localhost guard.
 * ========================================================================== */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let errors = 0;
const fail = (m) => { console.error('  ✗ ' + m); errors++; };
const ok = (m) => console.log('  ✓ ' + m);

console.log('Env-safety: local development must not silently target production:');
const cfgPath = join(ROOT, 'public', 'config.js');
if (!existsSync(cfgPath)) { fail('public/config.js missing'); }
else {
  const cfg = readFileSync(cfgPath, 'utf8');
  /localhost/.test(cfg) && /127\./.test(cfg)
    ? ok('config.js inspects the hostname for localhost/loopback')
    : fail('config.js no longer checks for localhost/loopback — env separation guard missing');
  // Fail-closed by default: production access from localhost must require an
  // EXPLICIT opt-in flag; the default path blanks the credentials.
  /HELM_ALLOW_PROD_FROM_LOCALHOST/.test(cfg)
    ? ok('config.js requires an explicit opt-in (HELM_ALLOW_PROD_FROM_LOCALHOST) to use prod on localhost')
    : fail('config.js lost the HELM_ALLOW_PROD_FROM_LOCALHOST explicit opt-in');
  // Fail-closed message must be an ERROR (not just a warn) when localhost blocks prod.
  /console\.error\([^)]*localhost|console\.error\([\s\S]{0,200}fail-closed/i.test(cfg) ||
  /DISABLED on localhost/i.test(cfg)
    ? ok('config.js errors (fail-closed) when localhost would target production')
    : fail('config.js does not fail closed on localhost→production coupling');
  // and the DEFAULT path must blank creds (not gated behind a block opt-in)
  /SUPABASE_CONFIG\.url\s*=\s*['"]{2}/.test(cfg) || /\.url\s*=\s*''/.test(cfg)
    ? ok('config.js blanks Supabase credentials on localhost by default')
    : fail('config.js has no way to blank Supabase on localhost');
  // Optional staging hook should exist so local dev can target an isolated project.
  /HELM_STAGING_SUPABASE/.test(cfg)
    ? ok('config.js supports an isolated staging project hook (HELM_STAGING_SUPABASE)')
    : fail('config.js lost the HELM_STAGING_SUPABASE staging hook');
  /service_role|SUPABASE_SERVICE_ROLE/.test(cfg)
    ? fail('config.js references a service_role secret — must never be in client code')
    : ok('config.js has no service_role secret');
}

console.log('Env-safety: production hosts never receive the staging project:');
{
  const cfg = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';
  const stgPath = join(ROOT, 'public', 'config.staging.js');
  const stg = existsSync(stgPath) ? readFileSync(stgPath, 'utf8') : '';
  const prodRef = (/url:\s*"https:\/\/([a-z0-9]{20})\.supabase\.co"/.exec(cfg) || [])[1];
  const refs = [...new Set([...cfg.matchAll(/([a-z0-9]{20})\.supabase\.co/g)].map((m) => m[1]))];
  refs.length === 1 && refs[0] === prodRef
    ? ok('config.js names only the production Supabase project')
    : fail('config.js names a non-production Supabase project (' + refs.join(', ') + ') — staging belongs in config.staging.js');
  /window\.SUPABASE_STAGING\s*=/.test(cfg)
    ? fail('config.js defines window.SUPABASE_STAGING — move it to public/config.staging.js')
    : ok('config.js does not define the staging block');
  /window\.SUPABASE_STAGING\s*=/.test(stg) && /__helmRouteEnv/.test(stg)
    ? ok('config.staging.js defines SUPABASE_STAGING and hands back to the router')
    : fail('public/config.staging.js missing or does not call window.__helmRouteEnv');
  /service_role|SUPABASE_SERVICE_ROLE/.test(stg)
    ? fail('config.staging.js references a service_role secret') : ok('config.staging.js has no service_role secret');
  const stgRef = (/https:\/\/([a-z0-9]{20})\.supabase\.co/.exec(stg) || [])[1];
  if (stgRef) {
    const hdr = readFileSync(join(ROOT, 'public', '_headers'), 'utf8');
    hdr.includes(stgRef) ? fail('public/_headers (served on prod) names the staging project') : ok('public/_headers is prod-only');
    const vercel = JSON.parse(readFileSync(join(ROOT, 'vercel.json'), 'utf8'));
    for (const host of ['www.helm.events', 'helm.events', 'helm-v01.vercel.app', 'helm-alpha-nine.vercel.app']) {
      const blocked = (vercel.redirects || []).some((r) => r.destination === '/404' && /config\\?\.staging\\?\.js/.test(r.source) &&
        (r.has || []).some((c) => c.type === 'host' && c.value === host));
      blocked ? ok(host + ': /config.staging.js → 404') : fail(host + ': /config.staging.js is not blocked in vercel.json');
      const leaks = (vercel.headers || []).filter((r) => (r.has || []).some((c) => c.type === 'host' && c.value === host) &&
        r.headers.some((h) => h.key.toLowerCase() === 'content-security-policy' && h.value.includes(stgRef)));
      const bases = (vercel.headers || []).filter((r) => !r.has && r.headers.some((h) => h.key.toLowerCase() === 'content-security-policy'));
      const overrides = (vercel.headers || []).filter((r) => (r.has || []).some((c) => c.type === 'host' && c.value === host) &&
        r.headers.some((h) => h.key.toLowerCase() === 'content-security-policy'));
      !leaks.length && overrides.length === bases.length
        ? ok(host + ': prod-only CSP override for every CSP rule (' + overrides.length + ')')
        : fail(host + ': CSP overrides missing/leaky — run node scripts/gen-csp.mjs');
    }
  }
}

console.log('');
if (errors) { console.error(`FAILED — ${errors} env-safety problem(s).`); process.exit(1); }
console.log('Env-safety checks passed.');
