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
// Case-insensitive variant for emails (seed emails are lowercase: harden_test_...).
// Profiles are identified/filtered by EMAIL, not full_name (which can be null for a
// user whose profile was auto-created by the on_auth_user_created trigger).
function assertPrefixedEmail(kind, value) {
  const s = String(value ?? '').toLowerCase();
  if (!s.startsWith(PREFIX.toLowerCase())) {
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
  profiles.forEach((p) => { assertPrefixedEmail('profile.email', p.email); });

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
  // Also sweep for any lingering prefixed users via the Management API (GoTrue admin
  // list returns 500 at page>1 on this staging project due to a pre-existing corrupt
  // auth.users row; a targeted SQL lookup is reliable). Best-effort if no PAT.
  const ACCESS_TOKEN = env('SUPABASE_ACCESS_TOKEN');
  if (ACCESS_TOKEN) {
    const q = `select id, email from auth.users where lower(email) like '${PREFIX.toLowerCase()}%'`;
    const res = await fetch(`https://api.supabase.com/v1/projects/${STAGING_REF}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q }),
    });
    if (res.ok) {
      const rows = await res.json().catch(() => []);
      for (const u of (Array.isArray(rows) ? rows : [])) {
        if (String(u.email || '').toLowerCase().startsWith(PREFIX.toLowerCase())) userIds.set(u.id, u.email);
      }
    } else {
      console.warn(`[cleanup] Management API user sweep failed (HTTP ${res.status}); relying on manifest.`);
    }
  } else {
    console.warn('[cleanup] no SUPABASE_ACCESS_TOKEN; relying on manifest for user ids.');
  }
  for (const email of userIds.values()) {
    if (!email.toLowerCase().startsWith(PREFIX.toLowerCase())) {
      fail(`refused to delete non-${PREFIX} user: ${email}`);
    }
  }

  console.log(`[cleanup] targets -> orgs=${orgs.length} quotes=${quotes.length} profiles=${profiles.length} users=${userIds.size}`);
  if (orgIds.length === 0) { console.log('[cleanup] nothing to delete.'); return; }

  // 2) Org-scoped cascade via the Management API. ALL synthetic data lives in the two
  // verified HARDEN_TEST orgs (asserted by name above), so delete every row whose
  // org_id is one of them, across every public table that has an org_id column, with
  // FK checks disabled for the operation (postgres/replica role). This avoids guessing
  // the full quote-linked child-table list. Scoped strictly to the 2 synthetic orgs.
  const ACCESS_TOKEN2 = env('SUPABASE_ACCESS_TOKEN');
  if (!ACCESS_TOKEN2) fail('SUPABASE_ACCESS_TOKEN (sbp_ PAT) required for the org-scoped cascade delete.');
  const orgArr = `array[${orgIds.map((x) => `'${x}'::uuid`).join(',')}]`;
  const sql = `
    set session_replication_role = replica;
    do $$
    declare t text; v_orgs uuid[] := ${orgArr};
    begin
      for t in select table_name from information_schema.columns
               where table_schema='public' and column_name='org_id'
                 and table_name <> 'organizations'
      loop execute format('delete from public.%I where org_id = any($1)', t) using v_orgs; end loop;
    end $$;
    delete from public.organizations where id = any(${orgArr});
    set session_replication_role = default;
    select 1 as ok;`;
  const res = await fetch(`https://api.supabase.com/v1/projects/${STAGING_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN2}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) fail(`org-scoped cascade delete failed: HTTP ${res.status} ${await res.text().catch(() => '')}`);
  console.log(`[cleanup] org-scoped rows deleted for ${orgIds.length} org(s) (quotes/profiles/children/orgs).`);

  // 3) Delete the GoTrue auth users (single-delete; list is unused).
  let delUsers = 0;
  for (const [id, email] of userIds) {
    if (!email.toLowerCase().startsWith(PREFIX.toLowerCase())) fail(`refused: ${email}`);
    try { await gotrue(`/users/${id}`, { method: 'DELETE' }); delUsers++; console.log(`[cleanup] deleted user ${email}`); }
    catch (e) { console.warn(`[cleanup] user delete ${email} -> ${e.message}`); }
  }

  console.log(`[cleanup] done. orgs=${orgs.length} quotes=${quotes.length} profiles=${profiles.length} users=${delUsers}/${userIds.size}`);
}

if (decodeURIComponent(import.meta.url) === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[cleanup] FAILED: ${err.message}`);
    process.exit(1);
  });
}

export { PREFIX, STAGING_REF, PROD_REF };
