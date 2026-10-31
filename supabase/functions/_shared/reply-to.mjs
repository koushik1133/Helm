// reply-to - R107: where a CLIENT'S reply to a studio e-mail goes (Reply-To header). Server-side only
// (service role); the resolved address is put in the e-mail header and NEVER returned to a page.
//
// Order (first valid address wins; an address equal to Helm's own sending address is never used,
// so a reply can never land in notifications@helm.events and be lost):
//   1. explicit  - the studio's own reply-to from the Integrations page (comms_settings.email_reply_to, 0150),
//                  when the caller already has it
//   2. business  - organizations.business_email (Settings > General)
//   3. owner     - public.studio_billing_email(org) (0300, service role: confirmed studio e-mail, else the
//                  studio owner's login e-mail, else the first active admin's); a database without 0300 ->
//                  organizations.created_by -> that user's auth e-mail
//   none        -> "" (no Reply-To header at all; never the sender address)
// Pure JS (no Deno globals) so node tests import it directly. Logs nothing about any address.
export const REPLY_EMAIL_RE = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

// the bare address out of 'Name <a@b>' or 'a@b'
function bare(v) {
  const s = String(v ?? "").trim();
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(s);
  return (m ? m[1] : s).trim().toLowerCase();
}

// every address Helm sends FROM (SMTP_FROM / SMTP_USER / RESEND_FROM) - never a valid Reply-To
export function senderAddresses(env) {
  const get = typeof env === "function" ? env : () => undefined;
  return ["SMTP_FROM", "SMTP_USER", "RESEND_FROM"].map((k) => bare(get(k))).filter((a) => REPLY_EMAIL_RE.test(a));
}

// first valid candidate that is not one of the sender addresses, else ""
export function pickReplyTo(candidates, senders = []) {
  const block = new Set((senders || []).map(bare).filter(Boolean));
  for (const c of candidates || []) {
    const e = String(c ?? "").trim();
    if (REPLY_EMAIL_RE.test(e) && !block.has(e.toLowerCase())) return e;
  }
  return "";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const missingFn = (err) => { const c = String((err && err.code) || ""); return c === "PGRST202" || c === "42883"; };

// the studio owner's login e-mail (owner / first admin via 0300; created_by before 0300), "" when none
export async function studioOwnerEmail(admin, org) {
  if (!admin || !UUID.test(String(org || ""))) return "";
  try {
    const { data, error } = await admin.rpc("studio_billing_email", { p_org: org });
    if (!error) return String(data ?? "").trim();
    if (!missingFn(error)) return "";
  } catch (_) { return ""; }
  try {
    const { data: o, error: oErr } = await admin.from("organizations").select("created_by").eq("id", org).maybeSingle();
    const uid = String((o && o.created_by) || "");
    if (oErr || !UUID.test(uid) || !admin.auth || !admin.auth.admin) return "";
    const { data: u, error: uErr } = await admin.auth.admin.getUserById(uid);
    return uErr ? "" : String((u && u.user && u.user.email) || "").trim();
  } catch (_) { return ""; }
}

// The Reply-To for a studio's client e-mail. opts.explicit = the Integrations reply-to (when known);
// opts.business = organizations.business_email when the caller already read it (undefined -> read here);
// opts.env = env getter (sender addresses are excluded). Never throws; "" = no Reply-To.
export async function studioReplyTo(admin, org, opts = {}) {
  const senders = senderAddresses(opts.env);
  const first = pickReplyTo([opts.explicit, opts.business], senders);
  if (first) return first;
  if (!admin || !UUID.test(String(org || ""))) return "";
  let business = opts.business;
  if (business === undefined) {
    try {
      const { data: o } = await admin.from("organizations").select("business_email").eq("id", org).maybeSingle();
      business = o && o.business_email;
    } catch (_) { business = null; }
    const b = pickReplyTo([business], senders);
    if (b) return b;
  }
  return pickReplyTo([await studioOwnerEmail(admin, org)], senders);
}

// comms-dispatch lanes -> the table whose row (by id) names the studio (org_id)
export const LANE_TABLES = {
  outbox: "comms_outbox", delivery: "delivery_reminder_sends", vendor: "vendor_request_sends",
  runsheet: "runsheet_reminder_sends", enquiry: "lead_enquiries", pkg: "pkg_outbox",
};

// Reply-To for a queued row: the row's own explicit reply-to when valid, else the studio's fallback.
// cache (a Map, one per run) keeps one lookup per studio.
export async function rowReplyTo(admin, lane, id, explicit, opts = {}) {
  const senders = senderAddresses(opts.env);
  const own = pickReplyTo([explicit], senders);
  if (own) return own;
  const table = LANE_TABLES[lane];
  if (!admin || !table || !UUID.test(String(id || ""))) return "";
  let org = "";
  try {
    const { data, error } = await admin.from(table).select("org_id").eq("id", id).maybeSingle();
    org = error ? "" : String((data && data.org_id) || "");
  } catch (_) { org = ""; }
  if (!UUID.test(org)) return "";
  const cache = opts.cache;
  if (cache && cache.has(org)) return cache.get(org);
  const r = await studioReplyTo(admin, org, { env: opts.env });
  if (cache) cache.set(org, r);
  return r;
}
