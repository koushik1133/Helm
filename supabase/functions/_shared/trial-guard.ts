// trial-guard - 0179: a free-trial studio sends NO real message to clients (approval code by SMS /
// WhatsApp / e-mail, approval / booklet link e-mail, staff WhatsApp, proposal WhatsApp).
// 0212: E-MAIL is the exception in an ACTIVE trial (capped) - see trialEmailGate at the end of this file.
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

// ---- 0212: free-trial client E-MAIL --------------------------------------------------------------------------
// An ACTIVE free trial may e-mail its clients (approval / booklet link, approval code by e-mail) under caps
// (30 a day per studio, 5 a day per address); WhatsApp / SMS / payment links stay blocked (trialSendBlocked above).
// public.trial_email_gate answers {allowed, trial, reason} and takes one cap slot for an allowed trial e-mail.
// Returns null when it gives no clear answer - no 0212 in the database yet, an error, an odd reply: the caller then
// keeps the pre-0212 gates (trial-outbound.ts + trialSendBlocked), under which a trial sends NOTHING and an
// unreadable plan fails closed. So a broken gate can never turn into a trial e-mail.
export type EmailKind = "approval_link" | "booklet_link" | "invite_site" | "otp";
export type EmailGate = { allowed: boolean; trial: boolean; reason?: string };
export const TRIAL_EMAIL_CAP_MSG =
  "Free trial e-mail limit reached for today (30 a day, 5 to one address) - nothing was sent. Copy the link instead, or choose a plan.";
export const TRIAL_DEMO_MSG = "This is a sample (demo) event - e-mails go only to the clients of your own events.";

// PostgREST / Postgres "function does not exist" (0212 not applied yet)
export function isMissingFn(err: unknown): boolean {
  // deno-lint-ignore no-explicit-any
  const e = err as any;
  const c = String((e && e.code) || "");
  return c === "PGRST202" || c === "42883";
}

// deno-lint-ignore no-explicit-any
export async function trialEmailGate(admin: any, ref: Ref, recipient: string, kind: EmailKind): Promise<EmailGate | null> {
  try {
    const { data, error } = await admin.rpc("trial_email_gate", {
      p_org: ref.org || null, p_quote: ref.quote || null, p_token: ref.token || null, p_recipient: recipient || null, p_kind: kind,
    });
    if (error || !data || typeof data !== "object" || typeof data.allowed !== "boolean") return null;
    return { allowed: data.allowed === true, trial: data.trial === true, reason: data.reason ? String(data.reason) : undefined };
  } catch (_) {
    return null;
  }
}
