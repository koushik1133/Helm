// captcha-verify/logic.mjs - pure helpers (no network, no Deno APIs) so node tests can cover them.
// Cloudflare Turnstile server-side check: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
// the RPC paths that may ask for a pass
//   signed in (0249 captcha_passes, per user):        sales  (checkout "Contact sales")
//   r26 signed out (0276 captcha_public_passes, by a one-use pass id the form sends back):
//     contact (submit_sales_enquiry), enquiry (public_enquiry_submit), suggest (submit_suggestion)
export const USER_ACTIONS = ["sales"];
export const PUBLIC_ACTIONS = ["contact", "enquiry", "suggest"];
export const ACTIONS = USER_ACTIONS.concat(PUBLIC_ACTIONS);
export const isPublicAction = (a) => PUBLIC_ACTIONS.includes(String(a || ""));
// Turnstile tokens are opaque printable ASCII, at most 2048 characters
export const TOKEN_RE = /^[\x21-\x7e]{10,2048}$/;

export function validRequest(body) {
  const b = body && typeof body === "object" ? body : {};
  const action = String(b.action || "");
  const token = typeof b.token === "string" ? b.token : "";
  if (!ACTIONS.includes(action)) return { ok: false, error: "unknown action" };
  if (!TOKEN_RE.test(token)) return { ok: false, error: "missing security check" };
  return { ok: true, action, token };
}

// "a.com, b.com" -> ["a.com", "b.com"] (lower-case, empty = no hostname check)
export function hostList(v) {
  return String(v || "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9.-]{1,253}$/.test(s));
}

// The siteverify answer -> { ok, reason }. Fails CLOSED on anything unexpected.
//   expect.action    the widget action the page used ("sales"); checked when Cloudflare returns one
//   expect.hostnames allowed hostnames (empty = not checked)
export function judge(res, expect) {
  const r = res && typeof res === "object" ? res : null;
  const e = expect || {};
  if (!r) return { ok: false, reason: "no-answer" };
  if (r.success !== true) {
    const codes = Array.isArray(r["error-codes"]) ? r["error-codes"].map((c) => String(c).slice(0, 40)).slice(0, 5) : [];
    return { ok: false, reason: "rejected" + (codes.length ? ":" + codes.join(",") : "") };
  }
  if (e.action && r.action && String(r.action) !== String(e.action)) return { ok: false, reason: "action-mismatch" };
  const hosts = Array.isArray(e.hostnames) ? e.hostnames : [];
  if (hosts.length && !hosts.includes(String(r.hostname || "").toLowerCase())) return { ok: false, reason: "hostname-mismatch" };
  return { ok: true, reason: "ok" };
}

// form body for siteverify (secret never logged)
export function verifyForm(secret, token, ip, idempotencyKey) {
  const f = new URLSearchParams();
  f.set("secret", String(secret || ""));
  f.set("response", String(token || ""));
  if (ip && ip !== "unknown") f.set("remoteip", String(ip).slice(0, 64));
  if (idempotencyKey) f.set("idempotency_key", String(idempotencyKey));
  return f;
}
