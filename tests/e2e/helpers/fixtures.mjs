// Node-only fixture bootstrap. Uses service_role from env for setup ONLY (create quote, approval token,
// known OTP). service_role is NEVER passed to the browser. Normal actions prefer authenticated user APIs.
import { STAGING_URL, STAGING_ANON, SERVICE_ROLE, PASSWORD, emailFor } from './env.mjs';

const H = (key) => ({ apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' });
const jj = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

// Cache the access token per role for the test run. A serial lifecycle re-signs-in
// dozens of times otherwise, which rate-limits /auth/v1/token and returns empty
// tokens (intermittent "lead bootstrap failed"). Tokens are valid ~1h ≫ a run.
const _tokCache = new Map();
export async function signIn(role) {
  if (_tokCache.has(role)) return _tokCache.get(role);
  const r = await fetch(STAGING_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: STAGING_ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: emailFor(role), password: PASSWORD }),
  });
  const j = await r.json();
  if (j.access_token) _tokCache.set(role, j.access_token);   // cache only a successful token
  return j.access_token;
}

// Create a fresh approval fixture with a KNOWN OTP for the approval E2E. Returns {token, phone, code, quoteId}.
export async function createApprovalFixture() {
  if (!SERVICE_ROLE) throw new Error('HELM_E2E_SERVICE_ROLE required for approval fixture bootstrap');
  const adminTok = await signIn('admin');
  // Valid 10-digit Indian mobile (6-9 lead digit), stored as +91 E.164 like the app's phone widget.
  const phone = '+91' + (9000000000 + Math.floor(Math.random() * 999999999));
  const code = String(Math.floor(100000 + Math.random() * 899999));
  const authH = { ...H(STAGING_ANON), Authorization: 'Bearer ' + adminTok };
  // 0049 revoked direct INSERT on quotes: create via the same RPC the app uses (store-api.js startBlank),
  // then set client + pricing through the column-level UPDATE grant (as updateMeta does).
  const qcode = 'E2E-W13-' + Date.now();
  const started = await jj(await fetch(STAGING_URL + '/rest/v1/rpc/start_blank_quote', {
    method: 'POST', headers: authH, body: JSON.stringify({ p_code: qcode, p_title: qcode }),
  }));
  const row = Array.isArray(started) ? started[0] : started;
  if (!row || !row.id) throw new Error('start_blank_quote failed: ' + JSON.stringify(started));
  const upd = await jj(await fetch(STAGING_URL + '/rest/v1/quotes?id=eq.' + row.id, {
    method: 'PATCH', headers: { ...authH, Prefer: 'return=representation' },
    body: JSON.stringify({ title: 'E2E W13', client: { name: 'E2E Client', phone }, pricing: { subtotal: 50000, gstPct: 18 } }),
  }));
  const q = Array.isArray(upd) && upd[0] ? upd[0] : null;
  if (!q) throw new Error('quote client/pricing update failed: ' + JSON.stringify(upd));
  const rpc = async (fn, tok, args) => jj(await fetch(STAGING_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST', headers: { ...H(STAGING_ANON), Authorization: 'Bearer ' + tok }, body: JSON.stringify(args),
  }));
  const token = await rpc('generate_approval_token', adminTok, { p_quote_id: q.id });
  // The known code is stored by reStoreOtp AFTER the UI's send step (one active code per test, like
  // a real client who asks once). Storing it here too would leave a 2nd live row with the same code,
  // which masks the replay check (OTPUI-09) - see r81-REPORT.md product note on older codes.
  return { token, phone, code, quoteId: q.id };
}

// Re-store a known OTP code as the newest for a token+phone (after the UI's send-OTP created a random one).
export async function reStoreOtp(token, phone, code) {
  // service_role-only RPC since 0025 (node-side setup only).
  await fetch(STAGING_URL + '/rest/v1/rpc/admin_store_otp', {
    method: 'POST', headers: H(SERVICE_ROLE),
    body: JSON.stringify({ p_token: token, p_phone: phone, p_code: code }),
  });
}

// Read helper (service_role) for asserting server-side state after a UI action.
export async function svcGet(path) {
  return jj(await fetch(STAGING_URL + '/rest/v1/' + path, { headers: H(SERVICE_ROLE) }));
}

// Staging has no SMS provider and no otp_dev_echo, so request_otp answers {sent:false} and the
// approve page (correctly) refuses to show the OTP step. The OTP *send* is not what these tests
// check: we stub only that one browser response, then store a KNOWN code server-side with
// admin_store_otp (reStoreOtp). Verification, lockout, expiry and replay stay fully server-side.
export async function stubOtpDelivery(page) {
  await page.route('**/rest/v1/rpc/request_otp', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ live: false, sent: true, delivery: 'e2e-stub', dev_code: null }),
  }));
}
