// Wave 15 — ONE canonical synthetic lifecycle, threaded through the real app.
// A single quote row IS the event in Helm (every downstream table FKs to quotes.id),
// so the canonical id we thread is quoteId. service_role is used ONLY for node-side
// bootstrap + assertions and is NEVER passed to the browser.
import { STAGING_URL, STAGING_ANON, SERVICE_ROLE, emailFor, PASSWORD } from './env.mjs';
import { signIn } from './fixtures.mjs';

const anonH = (tok) => ({ apikey: STAGING_ANON, Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' });
const svcH = () => ({ apikey: SERVICE_ROLE, Authorization: 'Bearer ' + SERVICE_ROLE, 'Content-Type': 'application/json' });
const jj = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

export function newRunId() {
  return 'W15-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

// RPC as an authenticated role.
export async function rpcAs(role, fn, args) {
  const tok = await signIn(role);
  return jj(await fetch(STAGING_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST', headers: anonH(tok), body: JSON.stringify(args),
  }));
}

// Read server truth with service_role (assertions only).
export async function svcGet(path) {
  return jj(await fetch(STAGING_URL + '/rest/v1/' + path, { headers: svcH() }));
}

// Create the ONE canonical lead → quote for the run, as the correct CRM role (sales can create leads/quotes).
// Returns { runId, leadId, quoteId, phone }. The lead is converted server-side via convert_lead_to_quote.
export async function bootstrapCanonicalLead(runId) {
  const tok = await signIn('sales');
  const phone = '5' + Math.floor(1000000000 + Math.random() * 8999999999);
  const lead = (await jj(await fetch(STAGING_URL + '/rest/v1/leads', {
    method: 'POST', headers: { ...anonH(tok), Prefer: 'return=representation' },
    body: JSON.stringify({ name: runId + ' Client', phone, source: 'e2e', event_type: 'wedding', status: 'new' }),
  })))[0];
  const conv = await rpcAs('sales', 'convert_lead_to_quote', { p_lead_id: lead.id });
  // convert_lead_to_quote returns the new quote id (uuid) or a row; normalize.
  const quoteId = typeof conv === 'string' ? conv : (conv && (conv.id || conv.quote_id || conv[0]?.id));
  return { runId, leadId: lead.id, quoteId, phone };
}

// Assert every major record belongs to the same org + same canonical quote (continuity audit).
export async function continuityChain(quoteId) {
  const [quote] = await svcGet(`quotes?id=eq.${quoteId}&select=id,org_id,status,lifecycle_stage`);
  const org = quote?.org_id;
  const counts = {};
  for (const tbl of ['event_discovery', 'quotation_versions', 'event_plan', 'event_tasks', 'quote_payments', 'event_closure']) {
    const rows = await svcGet(`${tbl}?quote_id=eq.${quoteId}&select=quote_id,org_id`);
    counts[tbl] = Array.isArray(rows) ? rows.length : 0;
    // any row that exists must share the canonical org
    if (Array.isArray(rows)) for (const r of rows) if (r.org_id && org && r.org_id !== org) counts[tbl] = -1; // -1 flags cross-org leak
  }
  return { org, quote, counts };
}

export const CREDS = { PASSWORD, emailFor };
