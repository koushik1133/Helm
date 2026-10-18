// trial-guard - 0179: a free-trial studio sends NO real message to clients (approval code by SMS /
// WhatsApp / e-mail, approval / booklet link e-mail, staff WhatsApp, proposal WhatsApp).
// Asked with the SERVICE ROLE right before a send. A free trial = studio_subscriptions.status
// 'trial' (never trial_ends_at), or the Helm sample master studio. Paid studios: always false.
//
// public.trial_send_blocked(p_org, p_quote, p_token) answers in the database (0179). Until 0179 is
// applied (function missing) the same rule is read directly from the tables. If neither answer can
// be had, the send is BLOCKED (fail closed): a failed check must never turn into a real message.

export const TRIAL_NO_SEND_HINT = "trial_no_send";
export const TRIAL_NO_SEND_MSG =
  "Free trial: messages to clients are not sent during the free trial. Share the link with Copy link instead.";

type Ref = { org?: string | null; quote?: string | null; token?: string | null };

// deno-lint-ignore no-explicit-any
export async function trialSendBlocked(admin: any, ref: Ref): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc("trial_send_blocked", {
      p_org: ref.org || null, p_quote: ref.quote || null, p_token: ref.token || null,
    });
    if (!error) return data === true;
  } catch (_) { /* fall back to the tables below */ }
  try {
    const orgs: string[] = [];
    if (ref.org) orgs.push(ref.org);
    if (ref.quote) {
      const { data, error } = await admin.from("quotes").select("org_id").eq("id", ref.quote).maybeSingle();
      if (error) return true;
      if (data && data.org_id) orgs.push(String(data.org_id));
    }
    if (ref.token) {
      const { data, error } = await admin.from("quotes").select("org_id").eq("approval_token", ref.token).limit(1).maybeSingle();
      if (error) return true;
      if (data && data.org_id) orgs.push(String(data.org_id));
      const { data: b, error: bErr } = await admin.from("client_booklets").select("org_id").eq("token", ref.token).limit(1).maybeSingle();
      if (bErr) return true;
      if (b && b.org_id) orgs.push(String(b.org_id));
    }
    for (const org of orgs) {
      const { data: s, error: sErr } = await admin.from("studio_subscriptions").select("status")
        .eq("org_id", org).eq("status", "trial").limit(1).maybeSingle();
      if (sErr) return true;
      if (s) return true;
      const { data: o, error: oErr } = await admin.from("organizations").select("is_sample_master").eq("id", org).maybeSingle();
      if (oErr) return true;
      if (o && o.is_sample_master === true) return true;
    }
    return false;
  } catch (_) {
    return true;
  }
}

// a database refusal from a 0179 wrapper (42501, hint trial_no_send)
export function isTrialNoSend(err: unknown): boolean {
  // deno-lint-ignore no-explicit-any
  const e = err as any;
  return !!e && String(e.code || "") === "42501" && String(e.hint || "") === TRIAL_NO_SEND_HINT;
}
