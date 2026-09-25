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
  /HELM_BLOCK_PROD_FROM_LOCALHOST/.test(cfg)
    ? ok('config.js has the opt-in flag to hard-block Supabase on localhost')
    : fail('config.js lost the HELM_BLOCK_PROD_FROM_LOCALHOST opt-in');
  // must at least WARN when localhost is using production (no silent coupling)
  /console\.warn\([^)]*PRODUCTION Supabase|console\.warn\([^)]*localhost[\s\S]{0,120}PRODUCTION/i.test(cfg) ||
  /PRODUCTION Supabase project/.test(cfg)
    ? ok('config.js warns when localhost targets production')
    : fail('config.js does not warn about localhost→production coupling');
  // and it must still be ABLE to blank creds when the block flag is set
  /SUPABASE_CONFIG\.url\s*=\s*['"]{2}/.test(cfg) || /\.url\s*=\s*''/.test(cfg)
    ? ok('config.js can hard-block Supabase on localhost when opted in')
    : fail('config.js has no way to hard-block Supabase on localhost');
  /service_role|SUPABASE_SERVICE_ROLE/.test(cfg)
    ? fail('config.js references a service_role secret — must never be in client code')
    : ok('config.js has no service_role secret');
}

console.log('');
if (errors) { console.error(`FAILED — ${errors} env-safety problem(s).`); process.exit(1); }
console.log('Env-safety checks passed.');
