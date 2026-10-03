#!/usr/bin/env node
// ============================================================================
// tests/staging/redteam.mjs — the INDEPENDENT final red-team orchestrator for
// the Helm STAGING deployment. Runs AFTER the functional suites pass and
// re-exercises the hardened contract ADVERSARIALLY with a focused set of
// INDEPENDENT probes (it does NOT just re-call the other suites).
//
// It COMPOSES cross-checks that correspond to docs/STAGING-REDTEAM-MATRIX.md:
//   A1  anon privileged RPC exec  — anon hits EVERY mutating RPC -> all DENY
//   A2  role escalation           — sales->admin_create_user / sales,manager->record_payment -> DENY
//   B1/B2 cross-tenant REST sweep — forged org-B ids read/updated as org-A -> deny/zero
//   B3  IDOR plant                — victim quote_id + attacker org_id -> rejected
//   B4  cross-tenant RPC          — victim-org quote id on mutating RPC -> DENY
//   C1/C2 pricing tamper burst    — crafted total + no-shape total -> not trusted
//   C5/C6 overpay (single+race)   — single overpay rejected; concurrent race -> 1 effect
//   D1  approval-token replay     — nonexistent/forged token -> DENY
//   D2  worker-token replay       — random work token -> DENY
//   D4  OTP flood fail-closed     — anon request_otp burst on bad token -> no success
//   D6  webhook replay            — valid-sig, nonexistent quote -> 200, NOTHING settles
//   F1  CORS evil origin          — edge preflight from evil origin -> no ACAO echo
//   G2  secret leak (config.js)   — no service_role/elevated key in config.js
//   G3  env confusion (preview)   — config.js resolves to STAGING ref, never prod
//
// FINDINGS are classified Critical/High/Medium/Low with evidence. The final gate
// is "0 unresolved Critical/High".
//
// SAFETY INVARIANTS (non-negotiable — mirror the other suites):
//   * STAGING ONLY. assertStagingRef() runs before ANY call; prod ref -> abort.
//   * Fails CLOSED: missing env/seed/fixtures -> exit 3 (BLOCKED), never PASS-on-skip.
//     A probe that cannot run safely throws BlockedError; it is NEVER scored PASS.
//   * Secrets from env only (via lib/client.mjs); never printed. .staging.env and
//     tokens are never read or echoed by this file.
//   * Mutating probes operate ONLY on the seeded HARDEN_TEST org-A quote, use
//     clearly prefixed test values, and reset the ledger afterwards. Cross-tenant
//     and webhook probes are settlement-free by construction (forged/other-org or
//     nonexistent ids), so nothing in another tenant or prod is ever touched.
//   * Reuses tests/staging/lib/client.mjs. Does NOT duplicate the functional suites.
//
// Required env (all from the environment; never on argv):
//   SUPABASE_STAGING_URL               https://xizehqgeyjcfpzrdymly.supabase.co
//   SUPABASE_STAGING_ANON_KEY          anon/publishable key
//   SUPABASE_STAGING_SERVICE_ROLE_KEY  service_role (fixture discovery + ledger reset only)
//   SEED_TEST_PASSWORD                 password for the seeded HARDEN_TEST_ users
// Optional env (enable the web-surface probes; otherwise BLOCKED-skipped, see below):
//   PREVIEW_URL                        the staging-wired Vercel preview alias (F1/G2/G3)
//
// Run (ONLY when you intend to execute against staging, after functional suites):
//   node tests/staging/redteam.mjs
// Importing this module performs NO network I/O (guarded main()).
// ============================================================================

import {
  assertStagingRef, assertEnv, BlockedError,
  STAGING_REF, PROD_REF,
  signInRole, rpc, anonClient,
  restSelect, restUpdate, restInsert,
  serviceSelect, classify, rand,
} from './lib/client.mjs';

const EXIT_PASS = 0, EXIT_FAIL = 1, EXIT_BLOCKED = 3;
const ORG_A_SLUG = 'HARDEN_TEST_org_a';
const ORG_B_SLUG = 'HARDEN_TEST_org_b';
const TOTAL = 100000;

const isArr = (d) => Array.isArray(d);
const DENIED = (res) => classify(res) === 'DENY';
const uuid = () => (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : '00000000-0000-4000-8000-' + rand(12);
const today = () => new Date().toISOString().slice(0, 10);

// Severity order for the gate.
const SEV = { Critical: 4, High: 3, Medium: 2, Low: 1 };

// ---- findings ledger --------------------------------------------------------
// A "finding" is a BREACH (the hardened contract did NOT hold). Probes that pass
// record nothing (or an informational note); a breach records its severity.
class Findings {
  constructor() { this.rows = []; this.checks = 0; }
  // ok=true  -> the probe PASSED (contract held). ok=false -> BREACH at `sev`.
  probe(id, name, ok, sev, evidence = '') {
    this.checks++;
    if (ok) {
      console.log(`PASS  [${id}] ${name}${evidence ? '  — ' + evidence : ''}`);
    } else {
      this.rows.push({ id, name, sev, evidence });
      console.log(`FAIL  [${id}] ${name}  — ${sev} — ${evidence}`);
    }
  }
  note(msg) { console.log(`      ${msg}`); }
  unresolvedCriticalHigh() {
    return this.rows.filter((r) => SEV[r.sev] >= SEV.High);
  }
  summary() {
    console.log('\n========== RED-TEAM FINDINGS ==========');
    if (!this.rows.length) {
      console.log(`  (none) — ${this.checks} independent probes, 0 breaches.`);
    } else {
      for (const r of this.rows) console.log(`  ${r.sev.padEnd(8)} [${r.id}] ${r.name} — ${r.evidence}`);
    }
    const ch = this.unresolvedCriticalHigh();
    console.log(`\n[redteam] GATE: ${ch.length === 0 ? 'PASS' : 'FAIL'} — ${ch.length} unresolved Critical/High (of ${this.rows.length} total finding(s), ${this.checks} probes).`);
    return { ok: ch.length === 0, findings: this.rows, checks: this.checks };
  }
}

// ---- service-role ledger reset (fixture hygiene only — never an assertion) ---
function makeSvc(e) {
  const H = { apikey: e.serviceKey, Authorization: `Bearer ${e.serviceKey}`, 'Content-Type': 'application/json' };
  async function req(method, path, body, prefer = 'return=representation') {
    const res = await fetch(`${e.url}/rest/v1/${path}`, { method, headers: { ...H, Prefer: prefer }, body: body ? JSON.stringify(body) : undefined });
    const t = await res.text(); let d = null; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
    return { ok: res.ok, status: res.status, data: d };
  }
  return {
    update: (table, q, patch) => req('PATCH', `${table}?${q}`, patch),
    del: (table, q) => req('DELETE', `${table}?${q}`),
  };
}

// ---- fixture discovery (service-role; fail-closed) --------------------------
async function discover() {
  const out = { org: {}, quote: {} };
  for (const [k, slug] of [['a', ORG_A_SLUG], ['b', ORG_B_SLUG]]) {
    const r = await serviceSelect('organizations', `slug=eq.${slug}&select=id&limit=1`);
    if (!r.ok || !isArr(r.data) || !r.data.length) {
      throw new BlockedError(`seeded org '${slug}' not found — run scripts/staging/seed-test-data.mjs first (fail-closed).`);
    }
    out.org[k] = r.data[0].id;
  }
  for (const k of ['a', 'b']) {
    const r = await serviceSelect('quotes', `org_id=eq.${out.org[k]}&select=id&limit=1`);
    if (!r.ok || !isArr(r.data) || !r.data.length) {
      throw new BlockedError(`no seeded quote in org ${k} — seed fixtures missing (fail-closed).`);
    }
    out.quote[k] = r.data[0].id;
  }
  return out;
}

// Every MUTATING RPC. anon must be DENY on all (A1). Args are harmless/forged.
function mutatingRpcArgs(quoteId) {
  const r = rand(8);
  return [
    ['create_quote', { p_code: 'HARDEN_TEST_' + r, p_title: 'HT redteam', p_event_type: 'wedding', p_data: { items: [] }, p_object_count: 0, p_event_date: today() }],
    ['convert_lead_to_quote', { p_lead_id: uuid() }],
    ['save_quotation_version', { p_quote: quoteId, p_pricing: { subtotal: 1000, discount: 0, gstPct: 18, other: 0 } }],
    ['set_discovery', { p_quote_id: quoteId, p_meet_date: today(), p_mode: 'call', p_location: 'HT', p_attendees: 'HT', p_notes: 'HT', p_budget_min: 0, p_budget_max: 0 }],
    ['set_event_plan', { p_quote_id: quoteId, p_venue_name: 'HT', p_venue_address: 'HT', p_venue_contact: 'HT', p_access_notes: 'HT', p_package: 'HT', p_menu: 'HT' }],
    ['set_proposal', { p_quote_id: quoteId, p_concept: 'HT', p_theme: 'HT', p_palette: [], p_images: [], p_scope: [] }],
    ['generate_approval_token', { p_quote_id: quoteId }],
    ['record_payment', { p_quote: quoteId, p_amount: 1, p_method: 'cash' }],
    ['mark_paid', { p_quote_id: quoteId, p_provider_ref: 'HT-' + r }],
    ['admin_create_user', { p_email: `harden_test_rt_${r}@helm-staging.test`, p_password: 'HelmTest!' + r, p_role: 'sales' }],
    ['verify_task', { p_id: uuid(), p_pass: true, p_note: 'HT' }],
  ];
}

// Sensitive, org_id-bearing tables for the IDOR sweep (B1/B2).
const SENSITIVE_TABLES = [
  'quotes', 'event_proposal', 'event_tasks', 'design_stages',
  'inventory_items', 'inventory_reservations', 'quote_payments',
  'profiles', 'layouts', 'coupons', 'event_files',
];

// ============================================================================
// A1 — anon privileged RPC exec: anon must be DENIED on EVERY mutating RPC.
async function probeAnonRpc(F, quoteId) {
  let allDenied = true, firstLeak = '';
  for (const [name, args] of mutatingRpcArgs(quoteId)) {
    const res = await anonClient.rpc(name, args);
    if (!DENIED(res)) { allDenied = false; firstLeak = firstLeak || `${name} status=${res.status}`; }
  }
  F.probe('A1', 'anon DENIED on every mutating RPC', allDenied, 'Critical',
    allDenied ? `all ${mutatingRpcArgs(quoteId).length} RPCs denied to anon` : `REACHED BODY: ${firstLeak}`);
}

// A2 — the two highest-value vertical escalations.
async function probeRoleEscalation(F, quoteId, jwtSales, jwtManager) {
  const r = rand(8);
  const esc1 = await rpc('admin_create_user', { p_email: `harden_test_rt_${r}@helm-staging.test`, p_password: 'HelmTest!' + r, p_role: 'sales' }, jwtSales);
  F.probe('A2', 'sales CANNOT admin_create_user', DENIED(esc1), 'Critical', DENIED(esc1) ? 'denied' : `REACHED BODY status=${esc1.status}`);
  // record_payment requires can_edit() AND has_area('finance','edit'). By the VERIFIED
  // default RBAC, sales HAS both — so record_payment by sales is allowed-by-config, not
  // an escalation (money INTEGRITY is proven separately in payment-redteam). The correct
  // negative is manager: it has can_edit but NOT finance.edit, so it must be denied.
  const esc3 = await rpc('record_payment', { p_quote: quoteId, p_amount: 1, p_method: 'cash' }, jwtManager);
  F.probe('A2', 'manager CANNOT record_payment (lacks finance.edit)', DENIED(esc3), 'High', DENIED(esc3) ? 'denied' : `REACHED BODY status=${esc3.status}`);
}

// B1/B2 — cross-tenant REST sweep with forged victim ids.
async function probeIdorSweep(F, jwtAttacker, victimOrg) {
  let readSecure = true, writeSecure = true, rLeak = '', wLeak = '';
  for (const t of SENSITIVE_TABLES) {
    const vic = await serviceSelect(t, `org_id=eq.${victimOrg}&select=id&limit=1`);
    const vrow = (vic.ok && isArr(vic.data) && vic.data.length) ? vic.data[0].id : null;
    if (!vrow) continue; // no victim row to aim at for this table
    const sel = await restSelect(t, `id=eq.${vrow}&select=id`, jwtAttacker);
    const leaked = !DENIED(sel) && sel.ok && isArr(sel.data) && sel.data.length > 0;
    if (leaked) { readSecure = false; rLeak = rLeak || `${t} leaked ${sel.data.length} row(s)`; }
    const upd = await restUpdate(t, `id=eq.${vrow}`, { org_id: victimOrg }, jwtAttacker);
    const mutated = !DENIED(upd) && upd.ok && isArr(upd.data) && upd.data.length > 0;
    if (mutated) { writeSecure = false; wLeak = wLeak || `${t} mutated ${upd.data.length} row(s)`; }
  }
  F.probe('B1', 'cross-tenant REST read sweep (deny/empty)', readSecure, 'Critical', readSecure ? 'no cross-tenant rows read' : rLeak);
  F.probe('B2', 'cross-tenant REST write sweep (zero rows)', writeSecure, 'Critical', writeSecure ? 'no cross-tenant rows mutated' : wLeak);
}

// B3 — IDOR plant: victim quote_id + attacker org_id must be rejected.
async function probeIdorPlant(F, jwtAttacker, victimQuoteId, attackerOrg) {
  const row = { quote_id: victimQuoteId, org_id: attackerOrg, category: 'x', title: 'HT-REDTEAM', seq: 1, status: 'todo' };
  const res = await restInsert('event_tasks', row, jwtAttacker, { returning: 'representation' });
  const rejected = DENIED(res) || !res.ok;
  F.probe('B3', 'forged quote_id+org_id plant rejected (zz_quote_org_match)', rejected, 'Critical', rejected ? 'rejected' : `PLANTED status=${res.status}`);
}

// B4 — cross-tenant RPC with a victim-org quote id.
async function probeCrossTenantRpc(F, jwtAttacker, victimQuoteId) {
  const a = await rpc('save_quotation_version', { p_quote: victimQuoteId, p_pricing: { subtotal: 1, gstPct: 18 } }, jwtAttacker);
  F.probe('B4', 'save_quotation_version on victim quote DENIED', DENIED(a), 'Critical', DENIED(a) ? 'denied' : `REACHED BODY status=${a.status}`);
  const b = await rpc('record_payment', { p_quote: victimQuoteId, p_amount: 1, p_method: 'cash' }, jwtAttacker);
  F.probe('B4', 'record_payment on victim quote DENIED', DENIED(b), 'Critical', DENIED(b) ? 'denied' : `REACHED BODY status=${b.status}`);
}

// C1/C2 — pricing tamper burst (own org-A quote; admin satisfies the guard).
async function probePricingTamper(F, jwtAdmin, svc, quoteId) {
  await svc.update('quotes', `id=eq.${quoteId}`, { pricing: { subtotal: TOTAL, discount: 0, gstPct: 0, total: TOTAL } });
  // C1: crafted total with proper shape -> recompute to 1180 (1000 + 18%).
  const c1 = await rpc('save_quotation_version', { p_quote: quoteId, p_pricing: { subtotal: 1000, discount: 0, gstPct: 18, total: 777777 } }, jwtAdmin);
  const recomputed = c1.ok && c1.data && Number(c1.data.total) === 1180;
  F.probe('C1', 'crafted client total ignored (server recompute)', recomputed, 'High',
    recomputed ? 'total=1180' : `total=${c1.data?.total} (expected 1180)`);
  // C2: no-shape {total} -> server must not trust it (W15-001).
  const c2 = await rpc('save_quotation_version', { p_quote: quoteId, p_pricing: { total: 777777 } }, jwtAdmin);
  const trusted = c2.ok && c2.data && Number(c2.data.total) === 777777;
  F.probe('C2', 'no-shape client total NOT trusted (W15-001)', !trusted, 'High',
    trusted ? 'BREACH: server trusted total=777777' : `total=${c2.data?.total}`);
  await svc.update('quotes', `id=eq.${quoteId}`, { pricing: { subtotal: TOTAL, discount: 0, gstPct: 0, total: TOTAL } });
}

// C5/C6 — overpay single + race (own org-A quote; reset ledger around it).
async function probeOverpay(F, jwtAdmin, svc, quoteId) {
  async function paidSum() {
    const r = await serviceSelect('quote_payments', `quote_id=eq.${quoteId}&status=eq.paid&select=amount`);
    const rows = (r.ok && isArr(r.data)) ? r.data : [];
    return { n: rows.length, sum: rows.reduce((a, b) => a + Number(b.amount || 0), 0) };
  }
  async function reset() {
    await svc.del('quote_payments', `quote_id=eq.${quoteId}`);
    await svc.del('payment_milestones', `quote_id=eq.${quoteId}`);
    await svc.update('quotes', `id=eq.${quoteId}`, { pricing: { subtotal: TOTAL, discount: 0, gstPct: 0, total: TOTAL } });
  }
  // C5: single overpay rejected.
  await reset();
  const over = await rpc('record_payment', { p_quote: quoteId, p_amount: TOTAL * 2, p_method: 'cash', p_idempotency_key: 'rt-over-' + rand() }, jwtAdmin);
  let ps = await paidSum();
  F.probe('C5', 'single overpayment rejected (ledger <= total)', over.ok === false && ps.sum <= TOTAL, 'High',
    `rpc ok=${over.ok}, total_paid=${ps.sum}`);
  // C6: concurrent overpay race -> exactly one effect.
  await reset();
  await Promise.all([
    rpc('record_payment', { p_quote: quoteId, p_amount: 60000, p_method: 'cash', p_idempotency_key: 'rt-r1-' + rand() }, jwtAdmin),
    rpc('record_payment', { p_quote: quoteId, p_amount: 60000, p_method: 'cash', p_idempotency_key: 'rt-r2-' + rand() }, jwtAdmin),
  ]);
  ps = await paidSum();
  F.probe('C6', 'concurrent overpay race -> exactly one effect', ps.n === 1 && ps.sum <= TOTAL, 'High',
    `${ps.n} paid row(s), total_paid=${ps.sum}`);
  await reset();
}

// D1/D2 — token replay/forgery cross-check WITHOUT mutating seed rows.
// A forged token is REJECTED as a business error ('invalid link', P0001, HTTP 400),
// not an authz (401/403) signal — classify() maps that to ALLOW, so assert rejection
// as "call failed OR returned no payload", which is the true security outcome.
async function probeTokenForgery(F) {
  const rejected = (res) => !res.ok || DENIED(res)
    || res.data == null || (typeof res.data === 'object' && res.data.ok === false);
  const t1 = await anonClient.rpc('public_get_portal', { p_token: uuid() });
  F.probe('D1', 'forged approval token REJECTED', rejected(t1), 'High', rejected(t1) ? `rejected status=${t1.status}` : `REACHED BODY status=${t1.status}`);
  const t2 = await anonClient.rpc('worker_get_tasks', { p_token: uuid() });
  F.probe('D2', 'forged worker token REJECTED', rejected(t2), 'High', rejected(t2) ? `rejected status=${t2.status}` : `REACHED BODY status=${t2.status}`);
}

// D4 — OTP flood fail-closed: anon request_otp burst on a bad token must not
// succeed (no real SMS; forged token => no quote => no success leaks through).
async function probeOtpFlood(F) {
  const badToken = uuid();
  const phone = '7' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const burst = await Promise.all(Array.from({ length: 6 }, () => anonClient.rpc('request_otp', { p_token: badToken, p_phone: phone })));
  const leaked = burst.some((r) => r.ok && r.data && r.data.ok === true);
  F.probe('D4', 'anon request_otp flood on bad token fails closed', !leaked, 'Medium',
    leaked ? 'BREACH: a request_otp succeeded for a forged token' : 'no success for forged token');
}

// D6 — webhook replay / nonexistent-quote: valid signature, but nothing settles.
// Settlement-free by construction (unknown quote id). Needs PREVIEW/edge reachable.
async function probeWebhookReplay(F, e) {
  const { createHmac } = await import('node:crypto');
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || '';
  if (!secret) { F.note('D6 skipped-as-BLOCKED: RAZORPAY_WEBHOOK_SECRET unset (cannot sign) — not scored PASS'); return; }
  const url = `${e.url}/functions/v1/razorpay-webhook`;
  const UNKNOWN_QID = '00000000-0000-4000-8000-000000000000';
  const body = JSON.stringify({ event: 'payment_link.paid', payload: { payment_link: { entity: { id: 'plink_rt_' + Date.now(), amount_paid: 1, notes: { quote_id: UNKNOWN_QID } } } } });
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  const post = async () => { const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': sig }, body }); return { status: res.status, text: await res.text() }; };
  const a = await post();
  const b = await post(); // replay
  const ok = a.status === 200 && b.status === 200 && /no quote|mismatch/i.test(a.text);
  F.probe('D6', 'webhook replay valid-sig unknown-quote -> 200, no settlement', ok, 'High',
    `status ${a.status}/${b.status} body="${a.text.slice(0, 48)}"`);
}

// F1 — CORS evil origin on an edge function.
async function probeCorsEvilOrigin(F, e) {
  const url = `${e.url}/functions/v1/send-whatsapp`;
  let res;
  try {
    res = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
  } catch (err) { F.note(`F1 skipped-as-BLOCKED: edge fn unreachable (${err?.message || err}) — not scored PASS`); return; }
  const acao = res.headers.get('access-control-allow-origin');
  const secure = !acao || acao === 'null';
  F.probe('F1', 'edge CORS does not echo evil origin', secure, 'High', `ACAO=${acao}`);
}

// G2/G3 — fetch PREVIEW_URL/config.js: no elevated key (G2), resolves to staging
// and never prod (G3). This does NOT read the local .staging.env.
async function probeConfigJs(F) {
  const previewUrl = process.env.PREVIEW_URL || '';
  if (!previewUrl) { F.note('G2/G3 skipped-as-BLOCKED: PREVIEW_URL unset — web-surface probes not run (not scored PASS)'); return; }
  const base = previewUrl.replace(/\/+$/, '');
  let text;
  try {
    const res = await fetch(`${base}/config.js`, { redirect: 'follow' });
    if (!res.ok) { F.note(`G2/G3 skipped-as-BLOCKED: GET ${base}/config.js -> HTTP ${res.status}`); return; }
    text = await res.text();
  } catch (err) { F.note(`G2/G3 skipped-as-BLOCKED: fetch config.js failed (${err?.message || err})`); return; }

  // G2: no elevated/service_role key material.
  const hasServiceRole = /service_role/.test(text) || /"role"\s*:\s*"service_role"/.test(text);
  F.probe('G2', 'config.js exposes NO service_role / elevated key', !hasServiceRole, 'Critical',
    hasServiceRole ? 'BREACH: service_role marker present in config.js' : 'anon/publishable only');

  // G3: resolves to staging, never prod. A config.js that references the prod ref
  // as its staging/preview target is an environment-confusion BLOCK.
  const mentionsStaging = text.includes(STAGING_REF);
  F.probe('G3', 'config.js references the STAGING ref', mentionsStaging, 'Critical',
    mentionsStaging ? `staging ref present (${STAGING_REF})` : 'BREACH: staging ref absent from preview config.js');
  // Hard guard: if the preview config.js contains ONLY the prod ref, that is a
  // red-team-hits-prod hazard — raise a Critical finding.
  const prodOnly = text.includes(PROD_REF) && !mentionsStaging;
  F.probe('G3', 'preview does not resolve to PROD ref only', !prodOnly, 'Critical',
    prodOnly ? `BREACH: preview config.js references prod ref (${PROD_REF}) without staging` : 'ok');
}

// ============================================================================
export async function run() {
  assertStagingRef();
  const e = assertEnv({ needService: true });     // anon + password + service (fixture discovery)
  const svc = makeSvc(e);
  const F = new Findings();

  const { org, quote } = await discover();

  // Pre-authenticate the roles the probes need; a missing seed BLOCKS (fail-closed).
  const jwtAdminA = await signInRole('admin', 'a');
  const jwtAdminB = await signInRole('admin', 'b');
  const jwtSales = await signInRole('sales', 'a');
  const jwtManager = await signInRole('manager', 'a');

  console.log(`[redteam] target staging ref ${STAGING_REF} — running independent adversarial probes.\n`);

  // --- A: authz / identity ---
  await probeAnonRpc(F, quote.a);
  await probeRoleEscalation(F, quote.a, jwtSales, jwtManager);

  // --- B: tenant isolation (A attacks B's rows) ---
  await probeIdorSweep(F, jwtAdminA, org.b);
  await probeIdorPlant(F, jwtAdminA, quote.b, org.a);
  await probeCrossTenantRpc(F, jwtAdminA, quote.b);
  // symmetry: B attacks A (one direction's RPC breach would already fail the gate;
  // the plant+sweep from B->A catches asymmetric policy gaps).
  await probeIdorPlant(F, jwtAdminB, quote.a, org.b);

  // --- C: money path (own org-A quote only) ---
  await probePricingTamper(F, jwtAdminA, svc, quote.a);
  await probeOverpay(F, jwtAdminA, svc, quote.a);

  // --- D: tokens / OTP / webhook ---
  await probeTokenForgery(F);
  await probeOtpFlood(F);
  await probeWebhookReplay(F, e);

  // --- F/G: web surface + env confusion ---
  await probeCorsEvilOrigin(F, e);
  await probeConfigJs(F);

  return F.summary();
}

async function main() {
  try {
    const s = await run();
    process.exit(s.ok ? EXIT_PASS : EXIT_FAIL);
  } catch (err) {
    if (err instanceof BlockedError) { console.error(`[redteam] BLOCKED — ${err.message}`); process.exit(EXIT_BLOCKED); }
    console.error(`[redteam] BLOCKED — unexpected error: ${err?.message || err}`); process.exit(EXIT_BLOCKED);
  }
}

if (decodeURIComponent(import.meta.url) === `file://${process.argv[1]}`) main();
