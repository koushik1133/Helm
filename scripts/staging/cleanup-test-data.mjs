#!/usr/bin/env node
// ============================================================================
// cleanup-test-data.mjs — DELETE synthetic staging test data for Helm.
//
// Deletes ONLY objects whose name/email/display/org/code begins with
// HARDEN_TEST_ (profiles + quotes via PostgREST, then GoTrue users). Also
// deletes any users recorded in .seed-manifest.json (after re-asserting their
// email prefix).
//
// SAFETY INVARIANTS (do not weaken):
//   * STAGING ONLY. Refuses unless SUPABASE_STAGING_URL contains the staging
//     project ref (xizehqgeyjcfpzrdymly). Hard-refuses the prod ref.
//   * HARD-ASSERTS the HARDEN_TEST_ prefix on EVERY delete target. If any
//     non-prefixed target is encountered, the WHOLE run aborts before deleting.
//   * Secrets come from env only. Never printed, never hardcoded.
//
// Required env:
//   SUPABASE_STAGING_URL               (default https://xizehqgeyjcfpzrdymly.supabase.co)
//   SUPABASE_STAGING_SERVICE_ROLE_KEY  (service_role key; never logged)
// ============================================================================

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STAGING_REF = 'xizehqgeyjcfpzrdymly';
const PROD_REF = 'nqltzgiwznphugcfhmbm';
const PREFIX = 'HARDEN_TEST_';
const MANIFEST_PATH = join(__dirname, '.seed-manifest.json');

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}
function fail(msg) {
  console.error(`[cleanup] ABORT: ${msg}`);
  process.exit(1);
}

const SUPABASE_URL = env('SUPABASE_STAGING_URL', `https://${STAGING_REF}.supabase.co`);
const SERVICE_KEY = env('SUPABASE_STAGING_SERVICE_ROLE_KEY');

function assertStaging() {
  if (SUPABASE_URL.includes(PROD_REF)) fail(`SUPABASE_STAGING_URL points at the PROD ref (${PROD_REF}). Refusing.`);
  if (!SUPABASE_URL.includes(STAGING_REF)) fail(`SUPABASE_STAGING_URL must contain the staging ref (${STAGING_REF}). Got: ${SUPABASE_URL}`);
  if (!SERVICE_KEY) fail('SUPABASE_STAGING_SERVICE_ROLE_KEY is not set.');
}

// Hard prefix assertion. Aborts the WHOLE run if any target is not prefixed.
function assertPrefixed(kind, value) {
  const s = String(value ?? '');
  if (!s.startsWith(PREFIX)) {
    fail(`refused to delete non-${PREFIX} ${kind}: ${JSON.stringify(value)}. Aborting entire run; nothing further deleted.`);
  }
}

const authHeaders = () => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
});

async function gotrue(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    ...init, headers: { ...authHeaders(), ...(init.headers || {}) },
  });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`GoTrue ${init.method || 'GET'} ${path} -> ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init, headers: { ...authHeaders(), Prefer: init.prefer || 'return=representation', ...(init.headers || {}) },
  });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`PostgREST ${init.method || 'GET'} ${path} -> ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

async function loadManifest() {
  try {
    const raw = await readFile(MANIFEST_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    console.warn(`[cleanup] no manifest at ${MANIFEST_PATH}; will discover targets by prefix.`);
    return null;
  }
}

async function main() {
  assertStaging();
  console.log(`[cleanup] target: ${SUPABASE_URL} (staging ref ${STAGING_REF})`);
  const manifest = await loadManifest();

  // 1) Discover targets (prefix-filtered server-side) and double-assert locally.
  const orgs = await rest(`/organizations?select=id,name,slug&name=like.${PREFIX}*`);
  orgs.forEach((o) => { assertPrefixed('organization.name', o.name); });
  const orgIds = orgs.map((o) => o.id);

  const quotes = await rest(`/quotes?select=id,code,org_id&code=like.${PREFIX}*`);
  quotes.forEach((q) => { assertPrefixed('quote.code', q.code); });

  const profiles = await rest(`/profiles?select=id,email,full_name&email=like.${PREFIX.toLowerCase()}*`);
  profiles.forEach((p) => { assertPrefixed('profile.full_name', p.full_name); });

  // GoTrue users: from manifest (re-assert) plus discovery by metadata prefix via email.
  const userIds = new Map(); // id -> email
  if (manifest?.users) {
    for (const u of manifest.users) {
      // Seed emails are lowercase-prefixed (e.g. harden_test_a_admin@...).
      if (!u.email.toLowerCase().startsWith(PREFIX.toLowerCase())) {
        fail(`refused to delete non-${PREFIX} user from manifest: ${u.email}`);
      }
      userIds.set(u.id, u.email);
    }
  }
  // Also sweep live GoTrue for any lingering prefixed users.
  const body = await gotrue(`/users?per_page=200`);
  const liveUsers = Array.isArray(body) ? body : (body?.users || []);
  for (const u of liveUsers) {
    const email = (u.email || '');
    if (email.toLowerCase().startsWith(PREFIX.toLowerCase())) {
      userIds.set(u.id, email);
    }
  }
  for (const email of userIds.values()) {
    if (!email.toLowerCase().startsWith(PREFIX.toLowerCase())) {
      fail(`refused to delete non-${PREFIX} user: ${email}`);
    }
  }

  console.log(`[cleanup] targets -> orgs=${orgs.length} quotes=${quotes.length} profiles=${profiles.length} users=${userIds.size}`);

  // 2) Delete in FK-safe order: quotes, profiles, then GoTrue users, then orgs.
  for (const q of quotes) {
    assertPrefixed('quote.code', q.code);
    await rest(`/quotes?id=eq.${q.id}`, { method: 'DELETE', prefer: 'return=minimal' });
    console.log(`[cleanup] deleted quote ${q.code}`);
  }
  for (const p of profiles) {
    assertPrefixed('profile.full_name', p.full_name);
    await rest(`/profiles?id=eq.${p.id}`, { method: 'DELETE', prefer: 'return=minimal' });
    console.log(`[cleanup] deleted profile ${p.full_name}`);
  }
  for (const [id, email] of userIds) {
    if (!email.toLowerCase().startsWith(PREFIX.toLowerCase())) fail(`refused: ${email}`);
    await gotrue(`/users/${id}`, { method: 'DELETE' });
    console.log(`[cleanup] deleted user ${email}`);
  }
  for (const o of orgs) {
    assertPrefixed('organization.name', o.name);
    await rest(`/organizations?id=eq.${o.id}`, { method: 'DELETE', prefer: 'return=minimal' });
    console.log(`[cleanup] deleted org ${o.name}`);
  }

  console.log(`[cleanup] done.`);
}

if (decodeURIComponent(import.meta.url) === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[cleanup] FAILED: ${err.message}`);
    process.exit(1);
  });
}

export { PREFIX, STAGING_REF, PROD_REF };
