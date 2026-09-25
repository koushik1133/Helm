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

console.log('');
if (errors) { console.error(`FAILED — ${errors} env-safety problem(s).`); process.exit(1); }
console.log('Env-safety checks passed.');
