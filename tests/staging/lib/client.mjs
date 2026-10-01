// ============================================================================
// tests/staging/lib/client.mjs — shared runtime helpers for the Helm STAGING
// security harness. Node ESM, global fetch, zero dependencies.
// ----------------------------------------------------------------------------
// SAFETY RAILS (non-negotiable):
//   * STAGING ONLY. Every executable suite MUST call assertStagingRef() before
//     any write. The configured SUPABASE_STAGING_URL must contain the staging
//     project ref; if it matches the PROD ref, or does not match staging, we
//     ABORT immediately.
//   * Secrets are read from the environment at runtime ONLY. They are NEVER
//     printed, logged, or written to any file. Do not pass them on argv.
//   * This file performs NO network I/O on import. It only defines helpers.
// ----------------------------------------------------------------------------
// Required env (see assertEnv / SEED below):
//   SUPABASE_STAGING_URL            e.g. https://xizehqgeyjcfpzrdymly.supabase.co
//   SUPABASE_STAGING_ANON_KEY       anon/publishable key (GoTrue + PostgREST)
//   SUPABASE_STAGING_SERVICE_ROLE_KEY  service_role key (fixture discovery only)
//   SEED_TEST_PASSWORD              shared password for the seeded HARDEN_TEST_ users
// ============================================================================

export const STAGING_REF = 'xizehqgeyjcfpzrdymly';
export const PROD_REF    = 'nqltzgiwznphugcfhmbm';

// ---- a thrown BlockedError means "could not run" → BLOCKED, never PASS -------
export class BlockedError extends Error {
  constructor(msg) { super(msg); this.name = 'BlockedError'; this.blocked = true; }
}

// ---- env plumbing -----------------------------------------------------------
export function env() {
  return {
    url:       process.env.SUPABASE_STAGING_URL || '',
    anonKey:   process.env.SUPABASE_STAGING_ANON_KEY || '',
    serviceKey:process.env.SUPABASE_STAGING_SERVICE_ROLE_KEY || '',
    password:  process.env.SEED_TEST_PASSWORD || '',
  };
}

// Hard-assert we are pointed at STAGING, never prod. Call before ANY write.
export function assertStagingRef() {
  const { url } = env();
  if (!url) throw new BlockedError('SUPABASE_STAGING_URL is not set — refusing to run.');
  if (url.includes(PROD_REF)) {
    throw new BlockedError(`REFUSING: SUPABASE_STAGING_URL points at PRODUCTION (${PROD_REF}). This harness must never touch production.`);
  }
  if (!url.includes(STAGING_REF)) {
    throw new BlockedError(`REFUSING: SUPABASE_STAGING_URL does not contain the sanctioned staging ref (${STAGING_REF}). Got an unrecognized host — aborting.`);
  }
  return true;
}

// Assert the env needed to run at all; missing → BLOCKED (not a failed test).
export function assertEnv({ needService = false } = {}) {
  assertStagingRef();
  const e = env();
  const missing = [];
  if (!e.anonKey)  missing.push('SUPABASE_STAGING_ANON_KEY');
  if (!e.password) missing.push('SEED_TEST_PASSWORD');
  if (needService && !e.serviceKey) missing.push('SUPABASE_STAGING_SERVICE_ROLE_KEY');
  if (missing.length) {
    throw new BlockedError(`missing required env: ${missing.join(', ')} — cannot run (fail-closed).`);
  }
  return e;
}

// ----------------------------------------------------------------------------
// Seed conventions — the contract with scripts/staging/seed-test-data.mjs.
// The seed script must create one authenticated user per role below in EACH of
// two orgs (A and B), all sharing SEED_TEST_PASSWORD, with the profile.role set
// as mapped, and the org's default role_access matrix (phase29 + 0008) applied.
// The harness learns each user's org_id at runtime via current_org_id(), so the
// exact org UUIDs need not be hardcoded here.
// ----------------------------------------------------------------------------
export const SEED = {
  emailPrefix: 'harden_test_',
  emailDomain: 'helm-staging.test',
  // matrix column  ->  profiles.role the seed must assign (DB-valid role names).
  // 'viewer' is a no-capability authenticated user → DB role 'client' (which has
  // no edit grants in the default matrix). 'anon' is unauthenticated (no user).
  roleToDbRole: {
    viewer:      'client',
    sales:       'sales',
    manager:     'manager',
    coordinator: 'coordinator',
    operations:  'operations',
    designer:    'designer',
    quality:     'quality',
    admin:       'admin',
  },
};

// email for a given matrix role + org suffix ('a' | 'b').
// MUST match scripts/staging/seed-test-data.mjs line ~238: `${prefix}${tag}_${role}`
// (org tag first, then role) — e.g. harden_test_a_admin@helm-staging.test.
export function seedEmail(role, org = 'a') {
  return `${SEED.emailPrefix}${org}_${role}@${SEED.emailDomain}`;
}

// ---- GoTrue password grant --------------------------------------------------
// Returns the access_token (JWT) for the seeded user, or throws BlockedError if
// the seed user cannot authenticate (so a missing seed BLOCKS, never PASSes).
export async function signInAs(email, password) {
  const e = env();
  const res = await fetch(`${e.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'apikey': e.anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  let body = null;
  try { body = await res.json(); } catch { /* ignore */ }
  if (!res.ok || !body || !body.access_token) {
    throw new BlockedError(`sign-in failed for ${email} (HTTP ${res.status}) — seed user missing or SEED_TEST_PASSWORD wrong. Cannot run (fail-closed).`);
  }
  return body.access_token;
}

// Sign in by matrix role + org; convenience wrapper.
export async function signInRole(role, org = 'a') {
  const e = env();
  return signInAs(seedEmail(role, org), e.password);
}

// ---- low-level REST / RPC ---------------------------------------------------
// Every call returns a normalized shape: { ok, status, data, error }.
// `error` is the PostgREST/GoTrue error object (has .code, .message, .hint).

function headersFor(jwt, extra = {}) {
  const e = env();
  const bearer = jwt || e.anonKey; // anon path uses the anon key as the bearer
  return {
    'apikey': e.anonKey,
    'Authorization': `Bearer ${bearer}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function parse(res) {
  const status = res.status;
  let data = null, error = null;
  const text = await res.text();
  let json = null;
  if (text) { try { json = JSON.parse(text); } catch { json = text; } }
  if (status >= 200 && status < 300) {
    data = json;
  } else {
    error = (json && typeof json === 'object') ? json : { message: String(json || `HTTP ${status}`) };
  }
  return { ok: status >= 200 && status < 300, status, data, error };
}

export async function rpc(name, args = {}, jwt = null) {
  const e = env();
  const res = await fetch(`${e.url}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: headersFor(jwt), body: JSON.stringify(args ?? {}),
  });
  return parse(res);
}

// Use the service_role key (fixture discovery / cross-tenant target lookup only).
export async function rpcService(name, args = {}) {
  const e = env();
  const res = await fetch(`${e.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { 'apikey': e.serviceKey, 'Authorization': `Bearer ${e.serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
  });
  return parse(res);
}

function buildUrl(table, query) {
  const e = env();
  const qs = query ? ('?' + query.replace(/^\?/, '')) : '';
  return `${e.url}/rest/v1/${table}${qs}`;
}

export async function restSelect(table, query = '', jwt = null) {
  const res = await fetch(buildUrl(table, query), { method: 'GET', headers: headersFor(jwt) });
  return parse(res);
}

export async function restInsert(table, row, jwt = null, { returning = 'representation' } = {}) {
  const res = await fetch(buildUrl(table, ''), {
    method: 'POST',
    headers: headersFor(jwt, { 'Prefer': `return=${returning}` }),
    body: JSON.stringify(row),
  });
  return parse(res);
}

export async function restUpdate(table, query, patch, jwt = null, { returning = 'representation' } = {}) {
  const res = await fetch(buildUrl(table, query), {
    method: 'PATCH',
    headers: headersFor(jwt, { 'Prefer': `return=${returning}` }),
    body: JSON.stringify(patch),
  });
  return parse(res);
}

export async function restDelete(table, query, jwt = null) {
  const res = await fetch(buildUrl(table, query), { method: 'DELETE', headers: headersFor(jwt) });
  return parse(res);
}

// Service-role variants for fixture discovery (bypass RLS to pick attack targets).
export async function serviceSelect(table, query = '') {
  const e = env();
  const res = await fetch(buildUrl(table, query), {
    method: 'GET',
    headers: { 'apikey': e.serviceKey, 'Authorization': `Bearer ${e.serviceKey}` },
  });
  return parse(res);
}

// An "anon client" is simply calls with jwt=null (anon key as bearer).
export const anonClient = {
  rpc:    (name, args = {}) => rpc(name, args, null),
  select: (table, query = '') => restSelect(table, query, null),
  insert: (table, row) => restInsert(table, row, null),
  update: (table, query, patch) => restUpdate(table, query, patch, null),
  delete: (table, query) => restDelete(table, query, null),
};

// ---- verdict classification -------------------------------------------------
// A result is DENIED (authorization blocked) when PostgREST/Postgres reports an
// authz failure: HTTP 401/403, Postgres errcode 42501, or a privilege/not-found
// at the function level (anon cannot even see an authenticated-only function).
// A result is ALLOWED when it succeeds OR fails with a NON-authz error (the
// guard passed and we reached the function body) — mirroring the SQL harness.
const AUTHZ_CODES = new Set(['42501', '401', '403']);
const AUTHZ_MSG = /not authorized|not permitted|not allowed|permission denied|must be signed in|not authorized to|only a /i;
// PostgREST returns PGRST202 (no function in schema cache for this role) / 404 when
// a role lacks EXECUTE — that is an authorization denial for our purposes.
const AUTHZ_PGRST = /PGRST(202|301|302)/;

export function classify(result) {
  if (result.ok) return 'ALLOW';
  const err = result.error || {};
  const code = String(err.code || '');
  const msg = String(err.message || '');
  if (result.status === 401 || result.status === 403) return 'DENY';
  if (AUTHZ_CODES.has(code)) return 'DENY';
  if (AUTHZ_PGRST.test(code)) return 'DENY';
  if (AUTHZ_MSG.test(msg)) return 'DENY';
  // Any other error (invalid link, no such event, unique_violation, 22003, 23514,
  // not found, etc.) means the guard was passed — treat as ALLOW (reached body).
  return 'ALLOW';
}

export function isDenied(result) { return classify(result) === 'DENY'; }
export function isAllowed(result) { return classify(result) === 'ALLOW'; }

// ---- tiny PASS/FAIL reporting ----------------------------------------------
export function makeReporter(suiteName) {
  const rows = [];
  let pass = 0, fail = 0;
  return {
    line(name, ok, detail = '') {
      if (ok) pass++; else fail++;
      rows.push({ name, ok, detail });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
    },
    note(msg) { console.log(`      ${msg}`); },
    summary() {
      const ok = fail === 0;
      console.log(`\n${suiteName}: ${ok ? 'ALL PASS' : fail + ' FAILED'} (${pass} pass / ${fail} fail)`);
      return { suite: suiteName, pass, fail, ok, rows };
    },
    get fail() { return fail; },
  };
}

// Random suffix for idempotency keys / unique values in tests.
export function rand(n = 8) {
  return Math.random().toString(36).slice(2, 2 + n) + Date.now().toString(36).slice(-4);
}
