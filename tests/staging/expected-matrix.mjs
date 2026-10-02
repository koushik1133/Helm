// ============================================================================
// tests/staging/expected-matrix.mjs — MACHINE-READABLE authorization matrix.
// Consumed by tests/staging/authz-matrix.mjs (imported, never re-parsed from MD).
// The human-readable companion is tests/staging/EXPECTED-RPC-MATRIX.md; keep the
// two in sync. Every expectation below is DERIVED from the canonical hardened
// schema + migrations, NOT from the client ROLE_CAPS (which is advisory only):
//
// VERIFIED against staging (xizehqgeyjcfpzrdymly) default role_access on 2026-10-02:
//   can_edit()   = user_role in (admin, planner, sales, operations, manager)
//   can_create() = user_role in (admin, planner, sales, manager)
//   is_admin()   = user_role = 'admin'
//   has_area(area,'edit') : admin bypass = true; else role_access(role,area).can_edit
//       for the caller's org. Default matrix (tested-role edit grants), VERIFIED:
//         quotes.edit   = {sales, manager}
//         leads.edit    = {sales, manager}
//         discovery.edit= {sales, manager}
//         plan.edit     = {operations, coordinator}
//         proposal.edit = {sales, manager, coordinator, designer}
//         finance.edit  = {sales, operations}        (+admin/planner, untested cols)
//         settlement.edit = {sales, operations}
//
//   NOTE on columns: 'planner' is NOT a tested column (the matrix tests the 9
//   columns in COLUMNS). The ALLOW/DENY values below are for THOSE columns only.
//   'anon' is unauthenticated (anon key bearer) and additionally lacks EXECUTE on
//   every non-public RPC (migration 0005), so anon is DENY everywhere here.
//   'client' is the real area-less external role (least-privilege authenticated).
// ============================================================================

// The 9 columns under test. 'client' is labelled "client (no-area)" in docs.
export const COLUMNS = [
  'anon',
  'client',       // client (no-area): authenticated, no staff has_area, no can_edit
  'sales',
  'manager',
  'coordinator',
  'operations',
  'designer',
  'quality',
  'admin',
];

// Column -> the DB profiles.role the seeder must assign (via lib SEED/seedEmail).
// anon has no user. client..admin map to the identically-named DB role.
export const COLUMN_DB_ROLE = {
  anon:        null,
  client:      'client',
  sales:       'sales',
  manager:     'manager',
  coordinator: 'coordinator',
  operations:  'operations',
  designer:    'designer',
  quality:     'quality',
  admin:       'admin',
};

const A = 'ALLOW';
const D = 'DENY';

// Build a row where only the named columns are ALLOW; all others DENY.
function row(...allowCols) {
  const r = {};
  for (const c of COLUMNS) r[c] = allowCols.includes(c) ? A : D;
  return r;
}

// Each entry describes one mutating RPC and the authorization VERDICT expected
// per column. `arg` names the fixture the suite must bind (see authz-matrix.mjs):
//   'quote'  -> a REAL quote in the caller's own org (so assert_quote_org passes
//               for authorized roles and the only denial is the authz guard)
//   'none'   -> no fixture (guard fires before any body/org lookup; a random id
//               or self-generated id is fine — an authorized role reaches the body)
export const RPCS = [
  {
    name: 'create_quote',
    guard: "has_area('quotes','edit') AND can_create()",
    arg: 'none',
    // can_create()={admin,planner,sales,manager}; quotes.edit default={sales,manager}.
    expected: row('sales', 'manager', 'admin'),
  },
  {
    name: 'convert_lead_to_quote',
    guard: "has_area('quotes'|'leads','edit') AND can_create()",
    arg: 'none',
    expected: row('sales', 'manager', 'admin'),
  },
  {
    name: 'save_quotation_version',
    guard: "can_edit() AND has_area('quotes','edit')",
    arg: 'quote',
    // can_edit()={admin,planner,sales,operations,manager}; quotes.edit={sales,manager}.
    expected: row('sales', 'manager', 'admin'),
  },
  {
    name: 'set_discovery',
    guard: "can_edit() AND has_area('quotes'|'discovery','edit')",
    arg: 'quote',
    // discovery.edit default={sales,manager}; both also have can_edit.
    expected: row('sales', 'manager', 'admin'),
  },
  {
    name: 'set_event_plan',
    guard: "can_edit() AND has_area('quotes'|'plan','edit')",
    arg: 'quote',
    // sales/manager reach it via quotes.edit; operations via plan.edit (all have
    // can_edit). coordinator has plan.edit but FAILS can_edit -> DENY.
    expected: row('sales', 'manager', 'operations', 'admin'),
  },
  {
    name: 'set_proposal',
    guard: "can_edit() AND has_area('quotes'|'proposal','edit')",
    arg: 'quote',
    // sales/manager have quotes+proposal.edit AND can_edit. designer/coordinator
    // have proposal.edit but FAIL can_edit -> DENY (divergence captured).
    expected: row('sales', 'manager', 'admin'),
  },
  {
    name: 'generate_approval_token',
    guard: "can_edit() AND has_area('quotes','edit')",
    arg: 'quote',
    expected: row('sales', 'manager', 'admin'),
  },
  {
    name: 'record_payment',
    guard: "can_edit() AND has_area('finance','edit')",
    arg: 'quote',
    // finance.edit default={admin,planner,sales,operations}; sales+operations also
    // have can_edit -> ALLOW. manager has can_edit but NOT finance.edit -> DENY.
    expected: row('sales', 'operations', 'admin'),
  },
  {
    name: 'mark_paid',
    guard: "user_role() in (admin, manager)",
    arg: 'quote',
    expected: row('manager', 'admin'),
  },
  {
    name: 'admin_create_user',
    guard: 'is_admin()',
    arg: 'none',
    expected: row('admin'),
  },
  {
    name: 'verify_task',
    guard: "user_role() in (admin, manager, planner, quality)",
    arg: 'none',
    expected: row('manager', 'quality', 'admin'),
  },
];

export default { COLUMNS, COLUMN_DB_ROLE, RPCS };
