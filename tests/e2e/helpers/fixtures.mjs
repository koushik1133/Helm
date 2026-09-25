// Node-only fixture bootstrap. Uses service_role from env for setup ONLY (create quote, approval token,
// known OTP). service_role is NEVER passed to the browser. Normal actions prefer authenticated user APIs.
import { STAGING_URL, STAGING_ANON, SERVICE_ROLE, PASSWORD, emailFor } from './env.mjs';

const H = (key) => ({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' });
const jj = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

export async function signIn(role) {
  const r = await fetch(STAGING_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: STAGING_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: emailFor(role), password: PASSWORD }),
  });
  const j = await r.json();
  return j.access_token;
}

// Create a fresh approval fixture with a KNOWN OTP for the approval E2E. Returns {token, phone, code, quoteId}.
export async function createApprovalFixture() {
  if (!SERVICE_ROLE) throw new Error('HELM_E2E_SERVICE_ROLE required for approval fixture bootstrap');
  const adminTok = await signIn('admin');
  const phone = '5' + Math.floor(1000000000 + Math.random() * 8999999999);
  const code = String(Math.floor(100000 + Math.random() * 899999));
  // quote created as the authenticated admin (org auto-set); pricing drives D8 total
  const q = (await jj(await fetch(STAGING_URL + '/rest/v1/quotes', {
    method: 'POST', headers: { ...H(STAGING_ANON), Authorization: 'Bearer ' + adminTok, Prefer: 'return=representation' },
    body: JSON.stringify({ code: 'E2E-W13-' + Date.now(), title: 'E2E W13', client: { name: 'E2E Client', phone }, pricing: { subtotal: 50000, gstPct: 18 } }),
  })))[0];
  const rpc = async (fn, tok, args) => jj(await fetch(STAGING_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST', headers: { ...H(STAGING_ANON), Authorization: 'Bearer ' + tok }, body: JSON.stringify(args),
  }));
  const token = await rpc('generate_approval_token', adminTok, { p_quote_id: q.id });
  await rpc('admin_store_otp', adminTok, { p_token: token, p_phone: phone, p_code: code });
  return { token, phone, code, quoteId: q.id };
}

// Re-store a known OTP code as the newest for a token+phone (after the UI's send-OTP created a random one).
export async function reStoreOtp(token, phone, code) {
  const adminTok = await signIn('admin');
  await fetch(STAGING_URL + '/rest/v1/rpc/admin_store_otp', {
    method: 'POST', headers: { ...H(STAGING_ANON), Authorization: 'Bearer ' + adminTok },
    body: JSON.stringify({ p_token: token, p_phone: phone, p_code: code }),
  });
}

// Read helper (service_role) for asserting server-side state after a UI action.
export async function svcGet(path) {
  return jj(await fetch(STAGING_URL + '/rest/v1/' + path, { headers: H(SERVICE_ROLE) }));
}
