// invite-signup — an invitee opening a valid invitation link creates their account and is
// signed in straight away (no "check your inbox" confirmation step).
//
// Why this is safe: the invitation token is a 48-hex bearer secret that was sent to (or
// handed by the studio admin to) ONE e-mail address. The account is created ONLY for that
// exact address: the e-mail typed on the form must equal invitations.email (case-insensitive),
// checked HERE on the server with the service role — the browser cannot pick another address.
// The invitation must be pending and unexpired. Nothing else is touched: the studio join
// itself still happens through the normal accept_invitation() RPC after sign-in (same checks).
//
// When it falls back to the normal (confirm-by-e-mail) sign-up — answer { fallback: true }:
//   * the invitation has no e-mail bound to it
// { token, peek: true } → { email } of a valid invitation, so the join form shows it locked.
// Refusals (4xx { error, code }):
//   invalid_invite  — unknown / not pending / expired token
//   email_mismatch  — the typed e-mail is not the invited one
//   account_exists  — this e-mail already has an account → sign in instead
//   weak_password   — fails Helm's password rule (same rule as the browser + 0030)
//
// Secrets / env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected). Kill switch:
//   HELM_INVITE_DIRECT_SIGNUP="false" → { fallback: true } for every call.
// Logs carry only error tags — never an address, a name, a password or a token.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { errTag, responders } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";

const TOKEN = /^[0-9a-f]{48}$/;
const EMAIL = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const SYMBOLS = "!@#$%^&*()_+-=[]{};'\\:\"|<>?,./`~";

// mirrors public._password_ok (0030) and store-api passwordProblem
export function passwordOk(p: string): boolean {
  if (typeof p !== "string" || p.length < 12 || p.length > 128) return false;
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/[0-9]/.test(p)) return false;
  for (const c of p) if (SYMBOLS.includes(c)) return true;
  return false;
}

export function directOn(v: string | undefined): boolean {
  return String(v ?? "").trim().toLowerCase() !== "false";
}

Deno.serve(async (req) => {
  const { cors, json, serverError } = responders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    if (!directOn(Deno.env.get("HELM_INVITE_DIRECT_SIGNUP"))) return json({ fallback: true });
    const body = await readJsonCapped(req);
    const token = String(body.token ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const fullName = String(body.full_name ?? "").trim().slice(0, 50);
    const wait = await checkLimits([["invsu:ip:" + clientIp(req), 30, 10 * 60_000], ["invsu:tok:" + token, 15, 10 * 60_000]]);
    if (wait) return tooMany(json, wait);
    if (!TOKEN.test(token)) return json({ error: "This invitation link isn't valid.", code: "invalid_invite" }, 400);
    const peek = body.peek === true;
    if (!peek && !EMAIL.test(email)) return json({ error: "Enter a valid e-mail address.", code: "bad_email" }, 400);
    if (!peek && !passwordOk(password)) {
      return json({ error: "Choose a stronger password: at least 12 characters with a lowercase letter, an uppercase letter, a number and a symbol.", code: "weak_password" }, 400);
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: inv, error: iErr } = await admin.from("invitations")
      .select("id,email,status,expires_at").eq("token", token).maybeSingle();
    if (iErr) return serverError(iErr);
    if (!inv || inv.status !== "pending" || !(new Date(inv.expires_at).getTime() > Date.now())) {
      return json({ error: "This invitation is no longer valid — ask your studio to send a new one.", code: "invalid_invite" }, 400);
    }
    const bound = String(inv.email ?? "").trim().toLowerCase();
    if (!bound) return json({ fallback: true });          // no e-mail bound → normal confirm-by-e-mail sign-up
    // peek: the invite page shows (and locks) the invited address — only to the token holder
    if (peek) return json({ email: bound });
    if (bound !== email) {
      return json({ error: "Use the e-mail address this invitation was sent to.", code: "email_mismatch" }, 403);
    }

    const { error: cErr } = await admin.auth.admin.createUser({
      email: bound, password, email_confirm: true,
      user_metadata: fullName ? { full_name: fullName } : {},
    });
    if (cErr) {
      const t = String(cErr.message || "") + " " + String((cErr as { code?: string }).code || "");
      if (/already|registered|exists/i.test(t) || cErr.status === 422) {
        return json({ error: "This e-mail already has a Helm account — sign in instead to accept the invitation.", code: "account_exists" }, 409);
      }
      if (/password/i.test(t)) return json({ error: "Choose a stronger password.", code: "weak_password" }, 400);
      return serverError(cErr);
    }
    return json({ ok: true });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    console.error("invite-signup:", errTag(e));
    return serverError(e);
  }
});
