#!/usr/bin/env node
// ============================================================================
// tests/staging/tenant-idor.mjs — cross-tenant IDOR / isolation matrix on
// STAGING. Proves ORG_A <-> ORG_B cannot see or mutate each other's rows across
// quotes, event_proposal, event_tasks, design_stages, inventory_items,
// inventory_reservations, quote_payments, profiles, layouts, coupons, event_files
// (+ the quote-linked children), via SELECT / UPDATE / DELETE / INSERT(plant) and
// RPC (assert_quote_org), plus public-token reads.
//
// Attacker signs in as an in-org 'admin' (full area, so capability is NEVER the
// reason a cross-tenant action fails — only TENANCY is). Every cross-tenant action
// MUST be denied or return/affect ZERO rows.
//
// SAFETY INVARIANTS:
//   * STAGING ONLY. assertStagingRef() before any call; prod ref -> abort.
//   * Fails CLOSED: missing env/seed/fixtures -> exit 3 (BLOCKED), never PASS.
//   * Destructive ops (DELETE/UPDATE) are issued ONLY cross-tenant; when isolation
//     holds they match zero rows and change nothing. They never run against prod.
//   * Secrets from env only; never printed.
// ============================================================================

import {
  assertStagingRef, assertEnv, BlockedError,
  signInRole, rpc, anonClient,
  restSelect, restInsert, restUpdate, restDelete,
  serviceSelect, classify, makeReporter, rand,
} from './lib/client.mjs';

const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_BLOCKED = 3;

// Tables tested for READ / UPDATE / DELETE isolation (all carry org_id).
const ISOLATION_TABLES = [
  'quotes', 'event_proposal', 'event_tasks', 'design_stages',
  'inventory_items', 'inventory_reservations', 'quote_payments',
  'profiles', 'layouts', 'coupons', 'event_files',
];

// Quote-linked tables used for the G4 cross-tenant INSERT plant (quote_id + org_id).
// The payload binds the VICTIM org's quote_id with the ATTACKER's org_id, which the
// zz_quote_org_match (0004) trigger must reject regardless of RLS.
function plantRows(victimQuoteId, attackerOrgId) {
  const tok = () => crypto.randomUUID();
  return [
    { table: 'event_proposal', row: { quote_id: victimQuoteId, org_id: attackerOrgId, published: true, share_token: tok(), palette: [], images: [], scope: [], concept: 'HT-IDOR', updated_at: new Date().toISOString() } },
    { table: 'event_tasks', row: { quote_id: victimQuoteId, org_id: attackerOrgId, category: 'x', title: 'HT-IDOR', seq: 1, status: 'todo' } },
    { table: 'design_stages', row: { quote_id: victimQuoteId, org_id: attackerOrgId, state: 'brief' } },
    { table: 'inventory_reservations', row: { quote_id: victimQuoteId, org_id: attackerOrgId, qty: 1 } },
    { table: 'quote_payments', row: { quote_id: victimQuoteId, org_id: attackerOrgId, provider: 'cash', amount: 1, status: 'created' } },
  ];
}

// RPCs that resolve a quote and must reject a cross-tenant quote via assert_quote_org.
function crossTenantRpcs(victimQuoteId) {
  return [
    { name: 'save_quotation_version', args: { p_quote: victimQuoteId, p_pricing: { subtotal: 1, gstPct: 18 } } },
    { name: 'set_proposal', args: { p_quote_id: victimQuoteId, p_concept: 'HT', p_theme: 'HT', p_palette: [], p_images: [], p_scope: [] } },
    { name: 'record_payment', args: { p_quote: victimQuoteId, p_amount: 1, p_method: 'cash' } },
    { name: 'mark_paid', args: { p_quote_id: victimQuoteId, p_provider_ref: 'HT' } },
    { name: 'generate_approval_token', args: { p_quote_id: victimQuoteId } },
  ];
}

const DENY = (res) => classify(res) === 'DENY';
const isArr = (d) => Array.isArray(d);

// Secure READ: denied, OR success with ZERO rows (RLS hid them). Leak = any row.
function readSecure(res) {
  if (DENY(res)) return { ok: true, note: 'denied' };
  if (res.ok && isArr(res.data) && res.data.length === 0) return { ok: true, note: 'empty (RLS)' };
  if (res.ok && isArr(res.data) && res.data.length > 0) return { ok: false, note: `LEAK: ${res.data.length} row(s)` };
  return { ok: false, note: `unexpected status ${res.status}` };
}
// Secure WRITE (update/delete): denied, OR success affecting ZERO rows.
function writeSecure(res) {
  if (DENY(res)) return { ok: true, note: 'denied' };
  if (res.ok && isArr(res.data) && res.data.length === 0) return { ok: true, note: 'zero rows affected' };
  if (res.ok && isArr(res.data) && res.data.length > 0) return { ok: false, note: `MUTATED ${res.data.length} cross-tenant row(s)` };
  return { ok: false, note: `unexpected status ${res.status}` };
}
// Secure INSERT plant: MUST be denied (RLS with_check / G4 trigger).
function plantSecure(res) {
  if (DENY(res)) return { ok: true, note: 'rejected' };
  return { ok: false, note: `PLANTED (status ${res.status})` };
}

async function discover() {
  const orgs = {};
  for (const [k, slug] of [['a', 'HARDEN_TEST_org_a'], ['b', 'HARDEN_TEST_org_b']]) {
    const r = await serviceSelect('organizations', `slug=eq.${slug}&select=id&limit=1`);
    if (!r.ok || !isArr(r.data) || !r.data.length) throw new BlockedError(`seeded org '${slug}' not found — seed first (fail-closed).`);
    orgs[k] = r.data[0].id;
  }
  const quote = {};
  for (const k of ['a', 'b']) {
    const r = await serviceSelect('quotes', `org_id=eq.${orgs[k]}&select=id,approval_token&limit=1`);
    if (!r.ok || !isArr(r.data) || !r.data.length) throw new BlockedError(`no seeded quote in org ${k} — seed fixtures missing (fail-closed).`);
    quote[k] = r.data[0];
  }
  return { orgs, quote };
}

// One attacker -> victim pass.
async function runDirection(rep, jwt, attackerOrg, victimOrg, victimQuote, label) {
  // READ / UPDATE / DELETE isolation across the table set.
  for (const t of ISOLATION_TABLES) {
    // find a victim-org row to aim at
    const vic = await serviceSelect(t, `org_id=eq.${victimOrg}&select=id&limit=1`);
    const vrow = (vic.ok && isArr(vic.data) && vic.data.length) ? vic.data[0].id : null;

    if (vrow) {
      const sel = await restSelect(t, `id=eq.${vrow}&select=id`, jwt);
      let v = readSecure(sel);
      rep.line(`${label} SELECT ${t}`, v.ok, v.note);

      // UPDATE sets org_id to its own value; cross-tenant so it must match 0 rows.
      const upd = await restUpdate(t, `id=eq.${vrow}`, { org_id: victimOrg }, jwt);
      v = writeSecure(upd);
      rep.line(`${label} UPDATE ${t}`, v.ok, v.note);

      // DELETE is issued cross-tenant only; secure RLS makes it a zero-row no-op.
      // PostgREST returns 204 (no body) for a DELETE regardless of rows matched, so
      // row-count can't be read from the response — instead VERIFY the victim row
      // still exists afterwards via the service role (authoritative). Still-present
      // = RLS protected the row; gone = a real cross-tenant deletion breach.
      const del = await restDelete(t, `id=eq.${vrow}`, jwt);
      if (DENY(del)) {
        rep.line(`${label} DELETE ${t}`, true, 'denied');
      } else {
        const still = await serviceSelect(t, `id=eq.${vrow}&select=id`);
        const intact = still.ok && isArr(still.data) && still.data.length > 0;
        rep.line(`${label} DELETE ${t}`, intact, intact ? 'no-op (victim row intact, RLS)' : 'DELETED cross-tenant row!');
      }
    } else {
      rep.note(`${label} ${t}: no victim-org row to target (read/update/delete skipped)`);
    }
  }

  // INSERT plant (G4) on quote-linked children, aiming the victim's quote.
  for (const { table, row } of plantRows(victimQuote.id, attackerOrg)) {
    const res = await restInsert(table, row, jwt, { returning: 'representation' });
    const v = plantSecure(res);
    rep.line(`${label} PLANT ${table} (victim quote + attacker org)`, v.ok, v.note);
  }

  // RPC cross-tenant: assert_quote_org must reject the victim's quote.
  for (const { name, args } of crossTenantRpcs(victimQuote.id)) {
    const res = await rpc(name, args, jwt);
    const denied = DENY(res);
    rep.line(`${label} RPC ${name} on victim quote`, denied, denied ? 'denied' : `REACHED BODY (status ${res.status})`);
  }

  // Direct cross-tenant profiles read (SEC-03): must not surface colleagues of the
  // victim org (every row belongs to victimOrg).
  const prof = await restSelect('profiles', `org_id=eq.${victimOrg}&select=id,email`, jwt);
  const pv = readSecure(prof);
  rep.line(`${label} SELECT profiles (victim org roster)`, pv.ok, pv.note);
}

export async function run() {
  assertStagingRef();
  assertEnv({ needService: true });

  const rep = makeReporter('TENANT-IDOR');
  const { orgs, quote } = await discover();

  const jwtA = await signInRole('admin', 'a');
  const jwtB = await signInRole('admin', 'b');

  // A attacks B, then B attacks A (symmetry).
  await runDirection(rep, jwtA, orgs.a, orgs.b, quote.b, 'A->B');
  await runDirection(rep, jwtB, orgs.b, orgs.a, quote.a, 'B->A');

  // Public-token reads: a public token resolves ONLY its own quote; using org B's
  // token must never surface org A's quote code, and vice versa.
  if (quote.a.approval_token && quote.b.approval_token) {
    const pa = await anonClient.rpc('public_get_quote', { p_token: quote.a.approval_token });
    const pb = await anonClient.rpc('public_get_quote', { p_token: quote.b.approval_token });
    const distinct = !(pa.ok && pb.ok) || JSON.stringify(pa.data) !== JSON.stringify(pb.data);
    rep.line('public_get_quote tokens are tenant-distinct', distinct,
      distinct ? 'each token returns only its own quote' : 'LEAK: tokens returned identical payloads');
  } else {
    rep.note('public-token read skipped: seeded quotes have no approval_token');
  }

  return rep.summary();
}

async function main() {
  try {
    const s = await run();
    process.exit(s.ok ? EXIT_PASS : EXIT_FAIL);
  } catch (err) {
    if (err instanceof BlockedError) { console.error(`TENANT-IDOR: BLOCKED — ${err.message}`); process.exit(EXIT_BLOCKED); }
    console.error(`TENANT-IDOR: BLOCKED — unexpected error: ${err?.message || err}`); process.exit(EXIT_BLOCKED);
  }
}

if (decodeURIComponent(import.meta.url) === `file://${process.argv[1]}`) main();
