#!/usr/bin/env node
// ============================================================================
// seed-test-data.mjs — PREPARE/SEED synthetic staging test data for Helm.
//
// Creates two tenants (HARDEN_TEST_ORG_A / HARDEN_TEST_ORG_B), one user per
// role in each, matching public.profiles rows, and a couple of quotes per org.
// Idempotent: re-running updates in place rather than duplicating.
//
// SAFETY INVARIANTS (do not weaken):
//   * STAGING ONLY. Refuses unless SUPABASE_STAGING_URL contains the staging
//     project ref (xizehqgeyjcfpzrdymly). Hard-refuses the prod ref.
//   * Every created object is prefixed HARDEN_TEST_ so cleanup can assert on it.
//   * Secrets come from env only. Never printed, never hardcoded.
//
// This file performs network writes against the staging project ONLY when run
// explicitly with `node scripts/staging/seed-test-data.mjs`. Importing it does
// nothing (guarded by the import.meta.main check at the bottom).
//
// Required env:
//   SUPABASE_STAGING_URL               (default https://xizehqgeyjcfpzrdymly.supabase.co)
//   SUPABASE_STAGING_SERVICE_ROLE_KEY  (service_role key; never logged)
//   SEED_TEST_PASSWORD                 (strong deterministic password; REQUIRED)
// ============================================================================

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Safety constants -------------------------------------------------------
const STAGING_REF = 'xizehqgeyjcfpzrdymly';
const PROD_REF = 'nqltzgiwznphugcfhmbm';
const PREFIX = 'HARDEN_TEST_';
const EMAIL_DOMAIN = 'helm-staging.test';
const MANIFEST_PATH = join(__dirname, '.seed-manifest.json');

// Roles seeded per org — DB-VALID set used by the staging authz matrix.
// The canonical hardened profiles_role_check (base-v1 widened by migration 0008)
// permits EXACTLY: admin, manager, planner, sales, coordinator, supervisor,
// quality, operations, crew, worker, client, designer.
// 'viewer' is NOT a permitted role — it has been DROPPED. The authz matrix's
// no-capability / least-privilege column uses the real area-less role `client`
// (external portal role, no staff has_area), which is seeded here. 'designer' is
// a valid role (added by 0008) and is kept. This list is the DB-valid set the
// matrix (tests/staging/authz-matrix.mjs) exercises.
const ROLES = [
  'admin',
  'manager',
  'sales',
  'coordinator',
  'operations',
  'designer',
  'quality',
  'client',   // area-less external role → the "client (no-area)" matrix column
];

const ORGS = [
  { tag: 'a', name: `${PREFIX}ORG_A`, slug: `${PREFIX}org_a` },
  { tag: 'b', name: `${PREFIX}ORG_B`, slug: `${PREFIX}org_b` },
];

// --- Env + guard ------------------------------------------------------------
function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

function fail(msg) {
  console.error(`[seed] ABORT: ${msg}`);
  process.exit(1);
}

const SUPABASE_URL = env('SUPABASE_STAGING_URL', `https://${STAGING_REF}.supabase.co`);
const SERVICE_KEY = env('SUPABASE_STAGING_SERVICE_ROLE_KEY');
const SEED_PASSWORD = env('SEED_TEST_PASSWORD');

function assertStaging() {
  if (SUPABASE_URL.includes(PROD_REF)) {
    fail(`SUPABASE_STAGING_URL points at the PROD ref (${PROD_REF}). Refusing.`);
  }
  if (!SUPABASE_URL.includes(STAGING_REF)) {
    fail(`SUPABASE_STAGING_URL must contain the staging ref (${STAGING_REF}). Got: ${SUPABASE_URL}`);
  }
  if (!SERVICE_KEY) fail('SUPABASE_STAGING_SERVICE_ROLE_KEY is not set.');
  if (!SEED_PASSWORD) fail('SEED_TEST_PASSWORD is not set. Refusing to hardcode a password.');
}

// --- Thin REST helpers ------------------------------------------------------
const authHeaders = () => ({
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
});

async function gotrue(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    throw new Error(`GoTrue ${init.method || 'GET'} ${path} -> ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: { ...authHeaders(), Prefer: init.prefer || 'return=representation', ...(init.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    throw new Error(`PostgREST ${init.method || 'GET'} ${path} -> ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}

// --- GoTrue user create/update (idempotent by email) ------------------------
// NOTE: GoTrue's admin "list users" (GET /admin/users) returns HTTP 500
// ("Database error finding users") at page sizes >1 on this staging project,
// due to a PRE-EXISTING corrupt auth.users row (not created by this program and
// outside the HARDEN_TEST_ prefix, so cleanup never touches it). Token-grant
// sign-in and single-user create are unaffected. To stay idempotent we resolve
// an existing user's id via the reliable Management API (SQL), not the list.
const ACCESS_TOKEN = env('SUPABASE_ACCESS_TOKEN');
async function mgmtUserIdByEmail(email) {
  if (!ACCESS_TOKEN) return null;
  const q = `select id from auth.users where lower(email)=lower('${email.replace(/'/g, "''")}') limit 1;`;
  const res = await fetch(`https://api.supabase.com/v1/projects/${STAGING_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q }),
  });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => null);
  return Array.isArray(rows) && rows[0] && rows[0].id ? rows[0].id : null;
}
async function findUserByEmail(email) {
  const id = await mgmtUserIdByEmail(email);
  return id ? { id } : null;
}

// role_access is the per-org RBAC matrix that has_area() reads; without it every
// non-admin role is denied (admin bypasses has_area). Real orgs are provisioned
// with a default matrix via the app; here we clone that default into each
// HARDEN_TEST org (from a real org's rows) so the authz matrix reflects reality.
// Idempotent: clears the HARDEN_TEST org's rows first. Requires the sbp_ PAT.
async function seedRoleAccess(orgId) {
  if (!ACCESS_TOKEN) { console.warn('[seed]   role_access skipped (no SUPABASE_ACCESS_TOKEN)'); return 0; }
  const sql = `
    delete from public.role_access where org_id='${orgId}';
    insert into public.role_access (org_id, role, area, can_view, can_edit)
    select '${orgId}'::uuid, role, area, bool_or(can_view), bool_or(can_edit)
    from public.role_access
    where org_id = (
      select org_id from public.role_access
      where org_id not in (select id from public.organizations where slug ilike 'harden_test%')
      group by org_id order by count(*) desc limit 1
    )
    group by role, area;
    select count(*)::int n from public.role_access where org_id='${orgId}';`;
  const res = await fetch(`https://api.supabase.com/v1/projects/${STAGING_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) { console.warn(`[seed]   role_access clone failed: HTTP ${res.status}`); return 0; }
  const rows = await res.json().catch(() => null);
  return Array.isArray(rows) && rows[0] && rows[0].n ? rows[0].n : 0;
}

async function upsertUser(email, displayName, role, orgName) {
  const existing = await findUserByEmail(email);
  const metadata = {
    display_name: displayName,
    full_name: displayName,
    harden_test: true,
    seed_role: role,
    seed_org: orgName,
  };
  if (existing) {
    const updated = await gotrue(`/users/${existing.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        password: SEED_PASSWORD,
        email_confirm: true,
        user_metadata: metadata,
      }),
    });
    return { id: updated.id, email, created: false };
  }
  const created = await gotrue(`/users`, {
    method: 'POST',
    body: JSON.stringify({
      email,
      password: SEED_PASSWORD,
      email_confirm: true,
      user_metadata: metadata,
    }),
  });
  return { id: created.id, email, created: true };
}

// --- Org upsert (idempotent by slug) ---------------------------------------
async function upsertOrg(org) {
  const rows = await rest(`/organizations?on_conflict=slug`, {
    method: 'POST',
    prefer: 'return=representation,resolution=merge-duplicates',
    body: JSON.stringify([{
      name: org.name,
      slug: org.slug,
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      brand: {},
      plan: 'pro',
    }]),
  });
  return rows[0];
}

// --- Profile upsert (idempotent by id) -------------------------------------
async function upsertProfile({ id, email, role, orgId, displayName }) {
  const rows = await rest(`/profiles?on_conflict=id`, {
    method: 'POST',
    prefer: 'return=representation,resolution=merge-duplicates',
    body: JSON.stringify([{
      id,
      email,
      full_name: displayName,
      role,
      org_id: orgId,
      must_change_password: false,
    }]),
  });
  return rows[0];
}

// --- Quote upsert (idempotent by org_id,code) ------------------------------
async function upsertQuote({ code, title, orgId }) {
  const rows = await rest(`/quotes?on_conflict=org_id,code`, {
    method: 'POST',
    prefer: 'return=representation,resolution=merge-duplicates',
    body: JSON.stringify([{
      code,
      title,
      status: 'quote',
      client: { name: `${PREFIX}client` },
      pricing: { subtotal: 200000, discount: 0, gstPct: 18, total: 236000 },
      current_version: 1,
      approval_status: 'none',
      org_id: orgId,
    }]),
  });
  return rows[0];
}

// --- Main -------------------------------------------------------------------
async function main() {
  assertStaging();
  console.log(`[seed] target: ${SUPABASE_URL} (staging ref ${STAGING_REF})`);

  const manifest = {
    generatedAt: new Date().toISOString(),
    stagingRef: STAGING_REF,
    prefix: PREFIX,
    orgs: [],
    users: [],
    profiles: [],
    quotes: [],
  };

  for (const org of ORGS) {
    const orgRow = await upsertOrg(org);
    manifest.orgs.push({ id: orgRow.id, name: orgRow.name, slug: orgRow.slug });
    console.log(`[seed] org ready: ${orgRow.name} (${orgRow.id})`);
    const raN = await seedRoleAccess(orgRow.id);
    console.log(`[seed]   role_access matrix seeded: ${raN} row(s)`);

    for (const role of ROLES) {
      const email = `${PREFIX.toLowerCase()}${org.tag}_${role}@${EMAIL_DOMAIN}`;
      const displayName = `${PREFIX}${org.tag.toUpperCase()}_${role}`;
      const user = await upsertUser(email, displayName, role, orgRow.name);
      manifest.users.push({ id: user.id, email, role, orgId: orgRow.id, created: user.created });

      const profile = await upsertProfile({
        id: user.id, email, role, orgId: orgRow.id, displayName,
      });
      manifest.profiles.push({ id: profile.id, role: profile.role, orgId: profile.org_id });
      console.log(`[seed]   user+profile: ${email} role=${role} ${user.created ? '(created)' : '(updated)'}`);
    }

    // a couple of quotes per org for tenant/payment tests
    for (const n of [1, 2]) {
      const code = `${PREFIX}${org.tag.toUpperCase()}-Q${String(n).padStart(4, '0')}`;
      const quote = await upsertQuote({ code, title: `${PREFIX}Event ${org.tag.toUpperCase()} ${n}`, orgId: orgRow.id });
      manifest.quotes.push({ id: quote.id, code: quote.code, orgId: quote.org_id });
      console.log(`[seed]   quote: ${code}`);
    }
  }

  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`[seed] manifest written: ${MANIFEST_PATH}`);
  console.log(`[seed] done. orgs=${manifest.orgs.length} users=${manifest.users.length} quotes=${manifest.quotes.length}`);
}

// Only run when executed directly (not on import).
if (decodeURIComponent(import.meta.url) === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[seed] FAILED: ${err.message}`);
    process.exit(1);
  });
}

export { ROLES, ORGS, PREFIX, STAGING_REF, PROD_REF };
