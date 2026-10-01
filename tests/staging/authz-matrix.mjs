#!/usr/bin/env node
// ============================================================================
// tests/staging/authz-matrix.mjs — RUNTIME role × mutating-RPC authorization
// matrix against STAGING. Signs in as each REAL seeded user, calls each mutating
// RPC, classifies ALLOW/DENY from the live PostgREST/Postgres response, and
// compares to tests/staging/expected-matrix.mjs. Final gate requires
// 0 unexpected ALLOW and 0 unexpected DENY.
//
// SAFETY INVARIANTS:
//   * STAGING ONLY. assertStagingRef() runs before any call; prod ref -> abort.
//   * Fails CLOSED: missing env/seed/fixtures -> exit 3 (BLOCKED), never PASS.
//   * Secrets from env only; never printed.
//   * Side effects are confined to the seeded HARDEN_TEST org/quote and clearly
//     prefixed test rows; no production data is touched.
// ============================================================================

import {
  assertStagingRef, assertEnv, BlockedError,
  signInRole, rpc, anonClient, serviceSelect,
  classify, makeReporter, rand,
} from './lib/client.mjs';
import { COLUMNS, RPCS } from './expected-matrix.mjs';

const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_BLOCKED = 3;
const ORG_A_SLUG = 'HARDEN_TEST_org_a';

function today() { return new Date().toISOString().slice(0, 10); }
function uuid() { return (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : '00000000-0000-4000-8000-' + rand(12); }

// Build the args object for a given RPC. `quoteId` is a REAL quote in the signed-in
// user's own org (org A) so assert_quote_org passes for AUTHORIZED roles — leaving
// the authorization guard as the ONLY thing that can deny.
function argsFor(name, quoteId) {
  const r = rand(8);
  switch (name) {
    case 'create_quote':
      return { p_code: 'HARDEN_TEST_' + r, p_title: 'HARDEN_TEST authz', p_event_type: 'wedding', p_data: { items: [] }, p_object_count: 0, p_event_date: today() };
    case 'convert_lead_to_quote':
      return { p_lead_id: uuid() };
    case 'save_quotation_version':
      return { p_quote: quoteId, p_pricing: { subtotal: 1000, discount: 0, gstPct: 18, other: 0 } };
    case 'set_discovery':
      return { p_quote_id: quoteId, p_meet_date: today(), p_mode: 'call', p_location: 'HT', p_attendees: 'HT', p_notes: 'HT', p_budget_min: 0, p_budget_max: 0 };
    case 'set_event_plan':
      return { p_quote_id: quoteId, p_venue_name: 'HT', p_venue_address: 'HT', p_venue_contact: 'HT', p_access_notes: 'HT', p_package: 'HT', p_menu: 'HT' };
    case 'set_proposal':
      return { p_quote_id: quoteId, p_concept: 'HT', p_theme: 'HT', p_palette: [], p_images: [], p_scope: [] };
    case 'generate_approval_token':
      return { p_quote_id: quoteId };
    case 'record_payment':
      return { p_quote: quoteId, p_amount: 1, p_method: 'cash' };
    case 'mark_paid':
      return { p_quote_id: quoteId, p_provider_ref: 'HT-' + r };
    case 'admin_create_user':
      return { p_email: `harden_test_authz_${r}@helm-staging.test`, p_password: 'HelmTest!' + r, p_role: 'sales' };
    case 'verify_task':
      return { p_id: uuid(), p_pass: true, p_note: 'HT' };
    default:
      throw new BlockedError(`no args builder for RPC '${name}' — matrix/code out of sync.`);
  }
}

// Discover a real quote in org A (service-role, fixture discovery only).
async function discoverOrgAQuote() {
  const org = await serviceSelect('organizations', `slug=eq.${ORG_A_SLUG}&select=id&limit=1`);
  if (!org.ok || !Array.isArray(org.data) || !org.data.length) {
    throw new BlockedError(`cannot find seeded org '${ORG_A_SLUG}' — run scripts/staging/seed-test-data.mjs first (fail-closed).`);
  }
  const orgA = org.data[0].id;
  const q = await serviceSelect('quotes', `org_id=eq.${orgA}&select=id&limit=1`);
  if (!q.ok || !Array.isArray(q.data) || !q.data.length) {
    throw new BlockedError(`no seeded quote found in org A (${orgA}) — seed fixtures missing (fail-closed).`);
  }
  return q.data[0].id;
}

// Run one RPC for one column; returns the live verdict 'ALLOW' | 'DENY'.
async function callCell(col, name, quoteId, jwtCache) {
  const args = argsFor(name, quoteId);
  if (col === 'anon') {
    return classify(await anonClient.rpc(name, args));
  }
  let jwt = jwtCache.get(col);
  if (jwt === undefined) {
    // Sign-in failure is a BLOCKED condition (seed missing), not a test FAIL.
    jwt = await signInRole(col, 'a');   // throws BlockedError if the seed user is absent
    jwtCache.set(col, jwt);
  }
  return classify(await rpc(name, args, jwt));
}

export async function run() {
  assertStagingRef();
  // Need the service_role key for fixture discovery; anon + password for sign-in.
  assertEnv({ needService: true });

  const rep = makeReporter('AUTHZ-MATRIX');
  const quoteId = await discoverOrgAQuote();

  // Pre-authenticate every non-anon column up front so a missing seed BLOCKS the
  // whole suite (fail-closed) rather than silently scoring individual cells.
  const jwtCache = new Map();
  for (const col of COLUMNS) {
    if (col === 'anon') continue;
    jwtCache.set(col, await signInRole(col, 'a'));
  }

  let unexpectedAllow = 0, unexpectedDeny = 0;
  for (const spec of RPCS) {
    for (const col of COLUMNS) {
      const expected = spec.expected[col];       // 'ALLOW' | 'DENY'
      const actual = await callCell(col, spec.name, quoteId, jwtCache);
      const ok = actual === expected;
      if (!ok) {
        if (actual === 'ALLOW') unexpectedAllow++; else unexpectedDeny++;
      }
      rep.line(`${spec.name} / ${col}`, ok, `expected ${expected}, got ${actual}`);
    }
  }

  const summary = rep.summary();
  console.log(`AUTHZ-MATRIX gate: ${unexpectedAllow} unexpected ALLOW / ${unexpectedDeny} unexpected DENY`);
  summary.ok = summary.ok && unexpectedAllow === 0 && unexpectedDeny === 0;
  return summary;
}

async function main() {
  try {
    const s = await run();
    process.exit(s.ok ? EXIT_PASS : EXIT_FAIL);
  } catch (err) {
    if (err instanceof BlockedError) {
      console.error(`AUTHZ-MATRIX: BLOCKED — ${err.message}`);
      process.exit(EXIT_BLOCKED);
    }
    console.error(`AUTHZ-MATRIX: BLOCKED — unexpected error: ${err?.message || err}`);
    process.exit(EXIT_BLOCKED);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
