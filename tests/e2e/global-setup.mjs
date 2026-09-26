// Global setup: generate a Playwright storageState per role via the reliable API token endpoint,
// so data-focused tests reuse a session instead of doing a slow UI login each time (free-tier
// latency otherwise cascades into flakes). Explicit UI-login coverage stays in the smoke/roles specs.
// State files live under tests/e2e/.auth/ (gitignored) and contain a synthetic session token only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGING_URL, STAGING_ANON, PASSWORD, ROLES, emailFor } from './helpers/env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = join(HERE, '.auth');
const PROJECT_REF = 'xizehqgeyjcfpzrdymly';
const ORIGIN = process.env.HELM_E2E_BASE_URL || `http://127.0.0.1:${process.env.HELM_E2E_PORT || '4173'}`;

export default async function globalSetup() {
  if (!STAGING_URL || !STAGING_ANON || !PASSWORD) {
    console.warn('[global-setup] missing HELM_E2E_* env — skipping state generation');
    return;
  }
  mkdirSync(AUTH_DIR, { recursive: true });
  for (const role of ROLES) {
    const r = await fetch(STAGING_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST', headers: { apikey: STAGING_ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: emailFor(role), password: PASSWORD }),
    });
    const session = await r.json();
    if (!session.access_token) { console.warn(`[global-setup] no token for ${role}: ${r.status}`); continue; }
    // supabase-js v2 persists the session object at key sb-<ref>-auth-token
    const storageState = {
      cookies: [],
      origins: [{ origin: ORIGIN, localStorage: [
        { name: `sb-${PROJECT_REF}-auth-token`, value: JSON.stringify(session) },
      ] }],
    };
    writeFileSync(join(AUTH_DIR, `${role}.json`), JSON.stringify(storageState));
  }
  console.log('[global-setup] wrote storageState for roles:', ROLES.join(', '));
}
