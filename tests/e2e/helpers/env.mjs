// Central env accessor for E2E. All secrets/creds come from the environment — never committed.
// Required (set at run time, e.g. an untracked .env.e2e sourced by the runner):
//   HELM_E2E_STAGING_URL         staging Supabase URL (public)
//   HELM_E2E_STAGING_ANON        staging anon key (public-by-design, RLS-protected)
//   HELM_E2E_SERVICE_ROLE        staging service_role (NODE-ONLY fixture bootstrap; never sent to the browser)
//   HELM_E2E_PASSWORD            shared synthetic password for all role users
//   HELM_E2E_<ROLE>_EMAIL        per-role synthetic email (ADMIN, MANAGER, PLANNER, SALES, COORDINATOR,
//                                SUPERVISOR, QUALITY, OPERATIONS, CREW, WORKER, CLIENT)
export const STAGING_URL = process.env.HELM_E2E_STAGING_URL || '';
export const STAGING_ANON = process.env.HELM_E2E_STAGING_ANON || '';
export const SERVICE_ROLE = process.env.HELM_E2E_SERVICE_ROLE || '';   // node-only
export const PASSWORD = process.env.HELM_E2E_PASSWORD || '';

export const ROLES = ['admin','manager','planner','sales','coordinator','supervisor','quality','operations','crew','worker','client'];

export function emailFor(role) {
  const k = 'HELM_E2E_' + role.toUpperCase() + '_EMAIL';
  return process.env[k] || `${role}.a@synthetic.helm`;
}

export function requireStagingEnv() {
  const missing = [];
  if (!STAGING_URL) missing.push('HELM_E2E_STAGING_URL');
  if (!STAGING_ANON) missing.push('HELM_E2E_STAGING_ANON');
  if (!PASSWORD) missing.push('HELM_E2E_PASSWORD');
  if (missing.length) throw new Error('Missing E2E env: ' + missing.join(', '));
}
