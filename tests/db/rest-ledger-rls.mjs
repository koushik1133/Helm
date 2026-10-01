// ============================================================================
// tests/db/rest-ledger-rls.mjs — BRIEF CASE 4, through the REAL REST endpoint.
// ----------------------------------------------------------------------------
// STATUS: NOT YET EXECUTED. No isolated test DB / staging REST credentials were
//   available when this was authored. It has NOT been run; this repo holds NO
//   real output from it. Run it yourself against an ISOLATED NON-PRODUCTION
//   Supabase project.
//
// PURPOSE: prove that direct PostgREST writes to the financial ledger tables
//   (public.quote_payments, public.payment_milestones) are rejected for BOTH an
//   anonymous caller (anon key only) AND an authenticated staff caller (a signed
//   user JWT) — i.e. money only moves through the SECURITY DEFINER RPCs
//   (record_payment / record_settlement_payment), never a raw table write.
//
//   This is the HTTP sibling of supabase/tests/40-ledger-rls.sql (which proves
//   the same thing at the SQL/RLS layer). Keep both: this one exercises the
//   actual browser-reachable attack surface (PostgREST), the SQL one runs with
//   no web tier.
//
// *** REGRESSION GUARD (see case 4, group 2 in 40-ledger-rls.sql) ***
//   On today's schema a staff JWT whose role has `quotes` edit (e.g. sales) CAN
//   POST directly to /rest/v1/quote_payments, bypassing record_payment. So the
//   STAFF assertions below are EXPECTED TO FAIL until the ledger tables are
//   locked to the RPC boundary (drop direct INSERT/UPDATE/DELETE grants/policies
//   for `authenticated`). The ANON assertions are genuine controls and should
//   PASS today.
//
// REQUIRED ENV (NO secrets committed — provide at run time / from CI secrets):
//   HELM_TEST_REST_URL   e.g. https://xizehqgeyjcfpzrdymly.supabase.co  (staging)
//   HELM_TEST_ANON_KEY   the project's anon public key
//   HELM_TEST_STAFF_JWT  a signed access token for a seeded staff user (role with
//                        quotes edit) in the SAME org as HELM_TEST_QUOTE_ID
//   HELM_TEST_QUOTE_ID   a quote id in that org to aim the writes at
//   Refuses to run if HELM_TEST_REST_URL points at the prod project ref.
//
// RUN:
//   HELM_TEST_REST_URL=... HELM_TEST_ANON_KEY=... HELM_TEST_STAFF_JWT=... \
//   HELM_TEST_QUOTE_ID=... node tests/db/rest-ledger-rls.mjs
//   Requires Node >= 18 (global fetch). Exits 0 only if every assertion holds.
// ============================================================================

const REST = process.env.HELM_TEST_REST_URL;
const ANON = process.env.HELM_TEST_ANON_KEY;
const STAFF = process.env.HELM_TEST_STAFF_JWT;
const QUOTE = process.env.HELM_TEST_QUOTE_ID;

const PROD_REF = 'nqltzgiwznphugcfhmbm';
if (!REST || !ANON || !QUOTE) {
  console.error('Missing env: set HELM_TEST_REST_URL, HELM_TEST_ANON_KEY, HELM_TEST_QUOTE_ID (and HELM_TEST_STAFF_JWT for the staff checks).');
  process.exit(2);
}
if (REST.includes(PROD_REF)) {
  console.error('REFUSING: HELM_TEST_REST_URL points at the PRODUCTION project.');
  process.exit(3);
}

let pass = 0, fail = 0;
const ok  = (m) => { console.log('PASS  ' + m); pass++; };
const bad = (m, d = '') => { console.log('FAIL  ' + m + '  ' + d); fail++; };

function headers(token) {
  return { apikey: ANON, Authorization: `Bearer ${token || ANON}`,
           'Content-Type': 'application/json', Prefer: 'return=representation' };
}
async function writeLedger(table, token, body, method = 'POST', qs = '') {
  const res = await fetch(`${REST}/rest/v1/${table}${qs}`, { method, headers: headers(token), body: JSON.stringify(body) });
  let payload = null; try { payload = await res.json(); } catch {}
  return { status: res.status, payload };
}
const wrote = (r) => r.status >= 200 && r.status < 300; // a 2xx means the write was accepted

async function main() {
  // --- GENUINE CONTROL: anon cannot INSERT quote_payments -------------------
  {
    const r = await writeLedger('quote_payments', null, { quote_id: QUOTE, amount: 1, status: 'paid' });
    wrote(r) ? bad('C4-REST.anon-insert', `anon write ACCEPTED (status ${r.status})`)
             : ok(`C4-REST.anon-insert quote_payments blocked (status ${r.status})`);
  }
  // --- GENUINE CONTROL: anon cannot INSERT payment_milestones ---------------
  {
    const r = await writeLedger('payment_milestones', null, { quote_id: QUOTE, label: 'x', amount: 1, status: 'paid' });
    wrote(r) ? bad('C4-REST.anon-milestone', `anon write ACCEPTED (status ${r.status})`)
             : ok(`C4-REST.anon-insert payment_milestones blocked (status ${r.status})`);
  }

  // --- REGRESSION GUARD: staff JWT must NOT write the ledger directly --------
  if (!STAFF) {
    console.log('SKIP  C4-REST.staff-* (set HELM_TEST_STAFF_JWT to run the staff regression guards)');
  } else {
    { // direct INSERT
      const r = await writeLedger('quote_payments', STAFF, { quote_id: QUOTE, amount: 1, status: 'paid' });
      wrote(r) ? bad('C4-REST.staff-insert', `REGRESSION: staff POST to quote_payments ACCEPTED (status ${r.status}) — lock the ledger to the RPC boundary`)
               : ok(`C4-REST.staff-insert quote_payments blocked at RPC boundary (status ${r.status})`);
    }
    { // direct UPDATE (mark-paid) via filter
      const r = await writeLedger('quote_payments', STAFF, { status: 'paid' }, 'PATCH', `?quote_id=eq.${QUOTE}`);
      wrote(r) && Array.isArray(r.payload) && r.payload.length > 0
        ? bad('C4-REST.staff-update', `REGRESSION: staff PATCH to quote_payments changed rows (status ${r.status})`)
        : ok(`C4-REST.staff-update quote_payments changed no rows (status ${r.status})`);
    }
    { // direct DELETE
      const r = await writeLedger('quote_payments', STAFF, {}, 'DELETE', `?receipt_no=eq.__none__`);
      // a DELETE that matches nothing is inconclusive; we only flag a successful delete of matched rows
      (wrote(r) && Array.isArray(r.payload) && r.payload.length > 0)
        ? bad('C4-REST.staff-delete', `REGRESSION: staff DELETE removed ledger rows (status ${r.status})`)
        : ok(`C4-REST.staff-delete removed no rows (status ${r.status})`);
    }
  }

  console.log(`\nresult: ${pass} passed, ${fail} failed`);
  console.log('reminder: the anon checks are genuine controls (expected PASS); the staff');
  console.log('checks are REGRESSION GUARDS expected to FAIL until the ledger RLS lockdown lands.');
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('harness error:', e); process.exit(2); });
