// ============================================================================
// server/jobs/cleanup-invites.js
// Background cron runner: soft-expire stale PENDING invitations.
// ---------------------------------------------------------------------------
// This runs server-side only (cron / secure task), never in the browser. It uses
// the Supabase service_role key, which BYPASSES RLS — so every write here is
// explicitly scoped by org_id to make cross-tenant corruption impossible.
//
// GUARDRAILS BAKED IN:
//   • service_role is read from the ENVIRONMENT only — never hardcoded, never
//     committed, never shipped to any client.
//   • Non-destructive: it UPDATEs status 'pending' -> 'expired'. It NEVER deletes.
//   • purgeExpiredTenantInvitations(targetOrgId) REFUSES to run without an org id,
//     and every update carries .eq('org_id', targetOrgId) as a hard tenant scope.
//   • Idempotent: re-running only touches rows still pending + past expiry.
//
// Requires: npm i @supabase/supabase-js   (the only dependency; the web app stays
// zero-dependency). Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Run all tenants:  node server/jobs/cleanup-invites.js
// Run one tenant:   node server/jobs/cleanup-invites.js <org_id>
// ============================================================================
'use strict';

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error(
    'cleanup-invites: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment ' +
    '(never hardcode the service_role key).'
  );
}

// service_role client — RLS is bypassed, so WE enforce tenant scope on every call.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * Soft-expire pending invitations past their expiry for ONE organization.
 * @param {string} targetOrgId - required; the function refuses an unscoped run.
 * @returns {Promise<{orgId:string, expired:number}>}
 */
async function purgeExpiredTenantInvitations(targetOrgId) {
  if (!targetOrgId || typeof targetOrgId !== 'string') {
    throw new Error('purgeExpiredTenantInvitations: targetOrgId is required — refusing an unscoped update.');
  }
  const { data, error } = await admin
    .from('invitations')
    .update({ status: 'expired' })          // soft state change — never a delete
    .eq('org_id', targetOrgId)              // HARD tenant scope (service_role bypasses RLS)
    .eq('status', 'pending')               // only touch still-pending invites
    .lt('expires_at', new Date().toISOString())
    .select('id');                          // returns only ids (no PII in logs)
  if (error) throw error;
  return { orgId: targetOrgId, expired: (data || []).length };
}

/**
 * Iterate every tenant and expire per-org. Each write stays org-scoped — there is
 * never a single global/unscoped update.
 * @returns {Promise<Array<{orgId:string, expired?:number, error?:string}>>}
 */
async function purgeAllTenants() {
  const { data: orgs, error } = await admin.from('organizations').select('id');
  if (error) throw error;
  const results = [];
  for (const o of orgs || []) {
    try {
      results.push(await purgeExpiredTenantInvitations(o.id));
    } catch (e) {
      results.push({ orgId: o.id, error: e.message });
    }
  }
  return results;
}

// CLI entry point
if (require.main === module) {
  const orgArg = process.argv[2];
  (orgArg ? purgeExpiredTenantInvitations(orgArg) : purgeAllTenants())
    .then((r) => {
      console.log('[cleanup-invites]', JSON.stringify(r)); // ids + counts only, no PII
      process.exit(0);
    })
    .catch((e) => {
      console.error('[cleanup-invites] failed:', e.message);
      process.exit(1);
    });
}

module.exports = { purgeExpiredTenantInvitations, purgeAllTenants };
