// reserved-email.mjs (r21, migration 0248) - Helm's own e-mail domains are not for customers.
//
// Addresses on helm.events / helm.com (and any sub-domain, e.g. team.helm.events) belong to the
// Helm team. Nobody may sign up, be invited or be given a login with one - unless HQ has put that
// exact address on the staff allowlist (public.staff_email_allowlist, 0248).
//
// The DATABASE is the real gate (0248): the Supabase Auth "Before User Created" hook
// (hook_before_user_created) and a guard trigger on auth.users / public.invitations. This module is
// only the early, friendly check for edge functions; when the service role can ask the database
// (email_is_reserved, 0248 - also knows HQ's extra look-alike domains and the allowlist) that
// answer wins, otherwise this static list is used and FAILS CLOSED.
// Pure JS (no Deno / Node APIs): imported by the edge functions and by the Node tests.

export const RESERVED_EMAIL_DOMAINS = Object.freeze(["helm.events", "helm.com"]);

export const RESERVED_EMAIL_MESSAGE =
  "Addresses on helm.events are reserved for the Helm team. Please use your own e-mail address.";

// lower case, trimmed, trailing dots on the domain removed ("Anil@HELM.events." -> "anil@helm.events")
export function normEmail(email) {
  const s = String(email == null ? "" : email).trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 1) return s;
  return s.slice(0, at) + "@" + s.slice(at + 1).replace(/\.+$/, "");
}

// the reserved domain an address falls under ("helm.events" for x@helm.events / x@team.helm.events), or ""
export function reservedDomainOf(email, domains) {
  const e = normEmail(email);
  const at = e.lastIndexOf("@");
  if (at < 1) return "";
  const host = e.slice(at + 1);
  const list = Array.isArray(domains) && domains.length ? domains : RESERVED_EMAIL_DOMAINS;
  for (const d of list) {
    const dd = String(d || "").trim().toLowerCase();
    if (dd && (host === dd || host.endsWith("." + dd))) return dd;
  }
  return "";
}

// Ask the database first (service-role client): true / false from email_is_reserved(p_email).
// Any error (0248 not applied yet, network) -> the static list decides (fails closed for it).
export async function isReservedEmail(admin, email) {
  const e = normEmail(email);
  if (!e) return false;
  try {
    if (admin && typeof admin.rpc === "function") {
      const { data, error } = await admin.rpc("email_is_reserved", { p_email: e });
      if (!error && typeof data === "boolean") return data;
    }
  } catch (_) { /* fall through to the static list */ }
  return reservedDomainOf(e) !== "";
}
