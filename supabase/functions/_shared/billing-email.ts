// billing-email - r59 (0300, audit E-03): where Helm's payment / billing mails for a studio go.
// The studio e-mail (organizations.business_email) only once it is CONFIRMED; otherwise the studio
// owner's login e-mail (else the first active admin's) - public.studio_billing_email(org), service role.
// Before 0300 is applied (function missing) the confirmed studio e-mail is read directly; an
// unconfirmed one is never used. Returns "" when there is no safe address, null on a database error.
const EMAIL = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

// deno-lint-ignore no-explicit-any
export async function studioBillingEmail(admin: any, org: string): Promise<string | null> {
  const { data, error } = await admin.rpc("studio_billing_email", { p_org: org });
  if (!error) { const e = String(data ?? "").trim(); return EMAIL.test(e) ? e : ""; }
  const c = String((error as { code?: string }).code || "");
  if (c !== "PGRST202" && c !== "42883") return null;
  const { data: o, error: oErr } = await admin.from("organizations").select("business_email, business_email_confirmed").eq("id", org).maybeSingle();
  if (oErr) return null;
  const e = String(o?.business_email || "").trim();
  return o && o.business_email_confirmed === true && EMAIL.test(e) ? e : "";
}
