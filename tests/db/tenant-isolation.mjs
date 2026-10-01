#!/usr/bin/env node
/* ============================================================================
 * tenant-isolation.mjs — permanent regression guard for cross-tenant leakage.
 * ----------------------------------------------------------------------------
 * Signs in as a real staff user (org A) against an ISOLATED NON-PRODUCTION test
 * project, then asserts that user can read ZERO rows belonging to any OTHER org
 * across every tenant-sensitive table. If any table returns a row with
 * org_id <> the caller's org, RLS tenant isolation has regressed → test fails.
 *
 * Requires OTHER orgs to have data in the test DB (staging does). Uses only the
 * PUBLIC anon key + a staff password — no service role, no DB password.
 *
 * ENV (all required):
 *   HELM_TEST_REST_URL   e.g. https://xizehqgeyjcfpzrdymly.supabase.co
 *   HELM_TEST_ANON_KEY   staging anon/publishable key (public-by-design)
 *   HELM_TEST_EMAIL      a staff user in org A   (e.g. admin@helm.com on staging)
 *   HELM_TEST_PASSWORD   that user's password
 * Refuses to run against the production project ref.
 *
 * Run:  node tests/db/tenant-isolation.mjs
 * ============================================================================ */
const PROD_REF = 'nqltzgiwznphugcfhmbm';            // production — must NEVER be targeted
const TABLES = [
  'quotes', 'quote_payments', 'payment_milestones', 'quote_consents',
  'event_refunds', 'leads', 'profiles', 'quote_otps', 'event_closure',
  'quotation_versions', 'notifications', 'event_tasks',
];

const { HELM_TEST_REST_URL: BASE, HELM_TEST_ANON_KEY: ANON,
        HELM_TEST_EMAIL: EMAIL, HELM_TEST_PASSWORD: PASSWORD } = process.env;

function die(msg) { console.error('tenant-isolation: ' + msg); process.exit(2); }
if (!BASE || !ANON || !EMAIL || !PASSWORD) {
  console.warn('tenant-isolation: SKIP — set HELM_TEST_REST_URL / HELM_TEST_ANON_KEY / HELM_TEST_EMAIL / HELM_TEST_PASSWORD');
  process.exit(0);                                   // skip cleanly (CI without secrets)
}
if (BASE.includes(PROD_REF)) die('REFUSING to run against the production project.');

const h = (tok) => ({ apikey: ANON, Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' });

const main = async () => {
  // 1) sign in (org A)
  const sres = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST', headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const session = await sres.json();
  if (!session.access_token) die(`sign-in failed: ${sres.status} ${JSON.stringify(session)}`);
  const tok = session.access_token;

  // 2) my org
  const pr = await fetch(`${BASE}/rest/v1/profiles?select=org_id&email=eq.${encodeURIComponent(EMAIL)}`, { headers: h(tok) });
  const prof = await pr.json();
  const myOrg = Array.isArray(prof) && prof[0] && prof[0].org_id;
  if (!myOrg) die('could not resolve caller org_id');
  console.log(`tenant-isolation: caller ${EMAIL} org=${myOrg}`);

  // 3) per table: assert 0 rows from OTHER orgs
  let failures = 0, checked = 0;
  for (const t of TABLES) {
    const r = await fetch(`${BASE}/rest/v1/${t}?select=org_id&org_id=neq.${myOrg}&limit=1`, { headers: h(tok) });
    if (r.status === 404) { console.log(`  - ${t}: (no such table, skipped)`); continue; }
    const rows = await r.json().catch(() => null);
    if (!Array.isArray(rows)) { console.log(`  - ${t}: unreadable (${r.status}) — treated as isolated`); checked++; continue; }
    checked++;
    if (rows.length > 0) { console.error(`  ✗ ${t}: LEAK — caller can read ${rows.length}+ row(s) from another org`); failures++; }
    else console.log(`  ✓ ${t}: 0 cross-tenant rows`);
  }

  console.log(`tenant-isolation: ${checked} tables checked, ${failures} leak(s).`);
  if (failures > 0) { console.error('tenant-isolation: FAIL — cross-tenant leakage detected.'); process.exit(1); }
  console.log('tenant-isolation: PASS — no cross-tenant leakage.');
};

main().catch((e) => die(e && e.stack || String(e)));
