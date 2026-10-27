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
// 0205 (prod bug 2026-10-18): when the invitation went out through Supabase Auth's own mailer
// (invite-mailer without a Resend key), Supabase ALREADY created the login - with no password.
// Its "Accept invitation" link works once, for 24 h. If that link's sign-in was lost (used,
// expired, opened while someone else was signed in) the invitee must NOT be told to "sign in":
// they have no password. invite_account_state(token) (0205, service role only) tells the cases
// apart, and { token, resend: true } e-mails a NEW link to the invited address only.
//
// When it falls back to the normal (confirm-by-e-mail) sign-up — answer { fallback: true }:
//   * the invitation has no e-mail bound to it
// { token, peek: true }   → { email, account?, studio, inviter, role, role_label } of a valid
//                           invitation, so EVERY path of the join page reads "Join <studio> on Helm -
//                           <inviter> invited you as <role>" with the invited e-mail locked.
//                           account (0205 applied): "new" (no login yet) | "needs_link" (a login made
//                           by the invite, no password yet) | "existing" (a real account: sign in).
//                           Only ever about the invitation's OWN e-mail. A known but no longer valid
//                           token → 400 invalid_invite + { reason: expired | used | revoked, studio }.
// { token, resend: true } → e-mails the invited address a new link (Supabase "Invite user"
//                           e-mail while unconfirmed, else its "Magic Link" e-mail) that lands on
//                           /login?invite=<token> signed in → "Set your password" → join.
//                           { ok: true, sent: true } | { account: "new" } | 409 account_exists.
//                           Rate limited (3 / hour per invitation, 10 / hour per IP).
//                           On an EXPIRED invitation it never renews anything: it asks the studio
//                           (invite_request_new_link, 0205: one bell note per 24 h) → { requested: true }.
// 0210 (round 19, free-trial sign-up) - no token, an e-mail only, BEFORE a trial creates anything:
// { email_lookup: true, email } → { invited: false } | { invited: true, studio, role, role_label }:
//                           only the studio name + role of the newest OPEN (pending, unexpired) invitation
//                           of exactly that e-mail (invite_open_for_email, 0210, service role only) - never
//                           the token, the inviter, the expiry or anything about a login. Every other
//                           e-mail gets the same { invited: false }. Rate limited (20 / 10 min per IP,
//                           5 / 10 min per e-mail).
// { email_send: true, email } → e-mails THAT address its invitation again (the same "Join <Studio>" e-mail
//                           invite-mailer sends: branded via the provider, else Supabase Auth's own e-mail)
//                           with the Join link /login?invite=<token>. The token never reaches the browser:
//                           opening the e-mail proves the address. Always { ok: true } + sent true / false.
//                           Rate limited (3 / hour per e-mail, 10 / hour per IP). Invite e-mails off
//                           (HELM_INVITE_EMAILS_ENABLED="false") → { ok: true, sent: false }.
// Refusals (4xx { error, code }):
//   invalid_invite  — unknown / not pending / expired token
//   email_mismatch  — the typed e-mail is not the invited one
//   needs_link      — the invite already made a login without a password (or a self sign-up was
//                     never confirmed: reason "unconfirmed") → offer resend, never "sign in"
//   account_exists  — this e-mail already has a real account → sign in instead
//   weak_password   — fails Helm's password rule (same rule as the browser + 0030)
//   rate_limited / send_failed — resend only
//
// Secrets / env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected), APP_URL (base of the link,
//   default https://www.helm.events). Kill switch: HELM_INVITE_DIRECT_SIGNUP="false" →
//   { fallback: true } for every call.
// Logs carry only error tags — never an address, a name, a password or a token.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { errTag, responders } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";
import { clean, inviteEmail, newLinkEmail, roleLabel } from "../invite-mailer/templates.ts";
import { mailConfig, sendMail } from "../_shared/mailer.ts";
import { isReservedEmail, RESERVED_EMAIL_MESSAGE } from "../_shared/reserved-email.mjs";

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

// same link the invitation e-mail carries (invite-mailer/templates.ts joinLink): fixed origin + hex token
export function joinLink(token: string, base?: string): string | null {
  if (!TOKEN.test(token)) return null;
  let origin = "https://www.helm.events";
  try { const u = new URL(String(base || "").trim()); if (u.protocol === "https:") origin = u.origin; } catch (_) { /* default */ }
  return `${origin}/login?invite=${encodeURIComponent(token)}`;
}

// 0205: an auth e-mail link on Helm's OWN domain (public/auth-confirm.html verifies the one-time
// hashed token there) - never the Supabase project URL. next = a fixed same-origin path.
export function confirmLink(hashedToken: string, type: "invite" | "magiclink", next: string, base?: string): string | null {
  if (!/^[A-Za-z0-9_-]{8,256}$/.test(hashedToken) || !/^\/[^/\\]/.test(next)) return null;
  let origin = "https://www.helm.events";
  try { const u = new URL(String(base || "").trim()); if (u.protocol === "https:") origin = u.origin; } catch (_) { /* default */ }
  return `${origin}/auth/confirm?token_hash=${encodeURIComponent(hashedToken)}&type=${type}&next=${encodeURIComponent(next)}`;
}

// invite_account_state (0205) → what the browser may know about the invitation's OWN e-mail.
// "unknown" = 0205 not applied yet / lookup failed (callers keep the old behaviour).
export type AccountState = "new" | "needs_link" | "unconfirmed" | "existing" | "unknown";
export function mapAccount(row: unknown): { account: AccountState; confirmed: boolean | null } {
  const r = (row && typeof row === "object") ? row as Record<string, unknown> : null;
  if (!r || r.valid !== true) return { account: "unknown", confirmed: null };
  const c = typeof r.confirmed === "boolean" ? r.confirmed : null;
  if (r.account === "none") return { account: "new", confirmed: c };
  if (r.account === "needs_password") return { account: "needs_link", confirmed: c };
  if (r.account === "unconfirmed") return { account: "unconfirmed", confirmed: false };   // self sign-up never confirmed
  if (r.account === "existing") return { account: "existing", confirmed: c };
  return { account: "unknown", confirmed: null };
}

const alreadyRe = /already|registered|exists/i;
// deno-lint-ignore no-explicit-any
const isAlready = (e: any) => alreadyRe.test(String(e?.message || "") + " " + String(e?.code || "")) || e?.status === 422;
// deno-lint-ignore no-explicit-any
const isRateLimited = (e: any) => e?.status === 429 || /rate|too many|security purposes/i.test(String(e?.message || "") + " " + String(e?.code || ""));

const NEEDS_LINK_MSG = "Your invitation already set up a Helm login for this e-mail, but it has no password yet. " +
  "The button in the invitation e-mail works once and only for 24 hours, so it may have been used or expired. " +
  "We can e-mail you a new link to set your password.";
const UNCONFIRMED_MSG = "This e-mail already started a Helm sign-up that was never confirmed, so signing in can't work yet. " +
  "We can e-mail you a link: open it to confirm your e-mail and join the studio.";
const EXISTS_MSG = "This e-mail already has a Helm account — sign in instead to accept the invitation.";

// 0210: what the sign-up page may learn about an e-mail's open invitation (studio + role, nothing else)
export function lookupAnswer(row: unknown): { invited: boolean; studio?: string; role?: string; role_label?: string } {
  const r = (row && typeof row === "object") ? row as Record<string, unknown> : null;
  if (!r || r.found !== true || typeof r.token !== "string" || !TOKEN.test(r.token)) return { invited: false };
  return { invited: true, studio: clean(r.studio, 120), role: clean(r.role, 40), role_label: roleLabel(r.role) };
}

// 0210: { email_lookup } / { email_send } - see the header. `email` is already trimmed + lower case.
// deno-lint-ignore no-explicit-any
async function byEmail(mode: "lookup" | "send", email: string, ip: string, json: any, serverError: any): Promise<Response> {
  const limits: Array<[string, number, number]> = mode === "send"
    ? [["invem:ip:" + ip, 10, 60 * 60_000], ["invem:em:" + email, 3, 60 * 60_000]]
    : [["invlk:ip:" + ip, 20, 10 * 60_000], ["invlk:em:" + email, 5, 10 * 60_000]];
  const wait = await checkLimits(limits);
  if (wait) {
    return json({ error: mode === "send" ? "We sent it a moment ago - check your inbox (and spam), or try again later." : "Too many requests - please try again in a few minutes.",
      code: "rate_limited", retry_after: wait }, 429);
  }
  if (!EMAIL.test(email) || email.length > 254) return json(mode === "send" ? { ok: true, sent: false } : { invited: false });
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  // r21 (0248): Helm's own domains (helm.events, ...) are never offered a studio login from here
  if (await isReservedEmail(admin, email)) {
    return mode === "send" ? json({ error: RESERVED_EMAIL_MESSAGE, code: "reserved_domain" }, 403) : json({ invited: false });
  }
  const { data: row, error } = await admin.rpc("invite_open_for_email", { p_email: email });
  if (error) {
    // 0210 not applied yet: the sign-up simply carries on (no invitation offered)
    if (/could not find|does not exist|PGRST202|42883/i.test(String(error.message || "") + " " + String((error as { code?: string }).code || ""))) {
      return json(mode === "send" ? { ok: true, sent: false } : { invited: false });
    }
    return serverError(error);
  }
  const ans = lookupAnswer(row);
  if (mode === "lookup") return json(ans);
  if (!ans.invited) return json({ ok: true, sent: false });
  if (String(Deno.env.get("HELM_INVITE_EMAILS_ENABLED") ?? "").trim().toLowerCase() === "false") return json({ ok: true, sent: false });
  // deno-lint-ignore no-explicit-any
  const r = row as any;
  const token = String(r.token);
  const link = joinLink(token, Deno.env.get("APP_URL"));
  if (!link) return json({ ok: true, sent: false });
  let inviter = "";
  if (r.invited_by) {
    try { const { data } = await admin.from("profiles").select("full_name").eq("id", r.invited_by).maybeSingle(); inviter = clean(data?.full_name, 60); } catch (_) { /* "Your studio admin" */ }
  }
  const studio = clean(r.studio, 120);
  if (mailConfig().provider) {
    const mail = inviteEmail({ token, inviter, studio, role: r.role, expires_at: r.expires_at });
    if (mail) {
      const s = await sendMail({ to: email, subject: mail.subject, html: mail.html, text: mail.text, studio, txReason: "invite" });
      if (s.status === "sent") return json({ ok: true, sent: true });
    }
  }
  // no provider (or it refused): Supabase Auth's own e-mail, like invite-mailer - a new address gets the
  // "Invite user" e-mail, an existing login the "Magic Link" one (never creating a user by OTP)
  const meta = { studio: studio.slice(0, 120), role: roleLabel(r.role).slice(0, 60), invited_by: inviter.slice(0, 120) };
  const { error: iErr } = await admin.auth.admin.inviteUserByEmail(email, { redirectTo: link, data: meta });
  if (!iErr) return json({ ok: true, sent: true });
  if (isRateLimited(iErr)) return json({ error: "We sent it a moment ago - check your inbox (and spam), or try again in a minute.", code: "rate_limited" }, 429);
  if (isAlready(iErr)) {
    const { error: oErr } = await admin.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: link } });
    if (!oErr) return json({ ok: true, sent: true });
    if (isRateLimited(oErr)) return json({ error: "We sent it a moment ago - check your inbox (and spam), or try again in a minute.", code: "rate_limited" }, 429);
    console.error("invite-signup: email_send magic link failed", errTag(oErr));
  } else console.error("invite-signup: email_send invite failed", errTag(iErr));
  return json({ error: "We couldn't send the e-mail just now - open the invitation e-mail you already have, or ask the studio to re-send it.", code: "send_failed" }, 502);
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
    const ip = clientIp(req);
    // 0210: the free-trial sign-up asks about an e-mail (no token) - its own limits, before the token ones
    if (body.email_lookup === true || body.email_send === true) {
      return await byEmail(body.email_send === true ? "send" : "lookup", email, ip, json, serverError);
    }
    const wait = await checkLimits([["invsu:ip:" + ip, 30, 10 * 60_000], ["invsu:tok:" + token, 15, 10 * 60_000]]);
    if (wait) return tooMany(json, wait);
    if (!TOKEN.test(token)) return json({ error: "This invitation link isn't valid.", code: "invalid_invite" }, 400);
    const peek = body.peek === true;
    const resend = !peek && body.resend === true;
    if (resend) {
      // a new e-mail costs a send: much tighter than the form (and Supabase Auth limits it too)
      const w2 = await checkLimits([["invrs:tok:" + token, 3, 60 * 60_000], ["invrs:ip:" + ip, 10, 60 * 60_000]]);
      if (w2) return json({ error: "A new link was sent a moment ago — check your inbox (and spam), or try again later.", code: "rate_limited", retry_after: w2 }, 429);
    }
    if (!peek && !resend && !EMAIL.test(email)) return json({ error: "Enter a valid e-mail address.", code: "bad_email" }, 400);
    if (!peek && !resend && !passwordOk(password)) {
      return json({ error: "Choose a stronger password: at least 12 characters with a lowercase letter, an uppercase letter, a number and a symbol.", code: "weak_password" }, 400);
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: inv, error: iErr } = await admin.from("invitations")
      .select("id,email,status,expires_at,org_id,role,invited_by").eq("token", token).maybeSingle();
    if (iErr) return serverError(iErr);
    // studio + inviter display name (no e-mail, no id) for the join page's "Join <studio>" header
    const contextOf = async () => {
      let studio = "", inviter = "";
      try { const { data } = await admin.from("organizations").select("name").eq("id", inv?.org_id).maybeSingle(); studio = clean(data?.name, 120); } catch (_) { /* header falls back */ }
      if (inv?.invited_by) {
        try { const { data } = await admin.from("profiles").select("full_name").eq("id", inv.invited_by).maybeSingle(); inviter = clean(data?.full_name, 60); } catch (_) { /* "Your studio admin" */ }
      }
      return { studio, inviter };
    };
    if (!inv || inv.status !== "pending" || !(new Date(inv.expires_at).getTime() > Date.now())) {
      const reason = !inv ? null : inv.status === "accepted" ? "used" : inv.status === "revoked" ? "revoked" : "expired";
      const studio = inv ? (await contextOf()).studio : "";
      if (resend && reason === "expired") {
        // the invitee cannot renew an invitation (seat limit, admin's choice): ask the studio instead
        try {
          const { data: q, error: qErr } = await admin.rpc("invite_request_new_link", { p_token: token });
          if (!qErr && q && (q.result === "requested" || q.result === "already_requested")) return json({ requested: true, studio });
        } catch (_) { /* 0205 not applied: plain answer below */ }
      }
      const who = studio || "your studio";
      const msg = reason === "used" ? `This invitation link was already used. If you joined ${who} but never chose a password, use "Forgot password?" to set one.`
        : reason === "revoked" ? `This invitation was cancelled — ask ${who} if you should still join.`
        : reason === "expired" ? `This invitation link has expired or was already used — ask ${who} to resend it.`
        : "This invitation is no longer valid — ask your studio to send a new one.";
      return json({ error: msg, code: "invalid_invite", ...(reason ? { reason } : {}), ...(studio ? { studio } : {}) }, 400);
    }
    const bound = String(inv.email ?? "").trim().toLowerCase();
    if (!bound) return json({ fallback: true });          // no e-mail bound → normal confirm-by-e-mail sign-up
    // the login state of the invitation's OWN e-mail (0205; "unknown" until it is applied)
    const stateOf = async () => {
      try { const { data, error } = await admin.rpc("invite_account_state", { p_token: token }); return error ? mapAccount(null) : mapAccount(data); }
      catch (_) { return mapAccount(null); }
    };
    // peek: the invite page shows (and locks) the invited address — only to the token holder
    if (peek) {
      const [st, ctx] = await Promise.all([stateOf(), contextOf()]);
      const info = { email: bound, studio: ctx.studio, inviter: ctx.inviter, role: String(inv.role ?? ""), role_label: roleLabel(inv.role) };
      return json(st.account === "unknown" ? info : { ...info, account: st.account });
    }

    // r21 (0248): an invitation bound to one of Helm's own domains (helm.events, ...) never makes or
    // re-links a login. The database refuses it too (hook + auth.users guard); this is the friendly answer.
    if (await isReservedEmail(admin, bound)) return json({ error: RESERVED_EMAIL_MESSAGE, code: "reserved_domain" }, 403);

    if (resend) {
      const st = await stateOf();
      if (st.account === "new") return json({ account: "new" });   // no login yet: the join form creates it
      if (st.account === "existing") return json({ error: EXISTS_MSG, code: "account_exists" }, 409);
      if (!EMAIL.test(bound)) return json({ error: "This invitation's e-mail address can't receive a link.", code: "send_failed" }, 400);
      const link = joinLink(token, Deno.env.get("APP_URL"));
      if (!link) return json({ error: "This invitation link isn't valid.", code: "invalid_invite" }, 400);
      // With an e-mail provider (same as invite-mailer): Supabase only MAKES the one-time token
      // (generateLink: "invite" while never confirmed, else "magiclink" - never creating a login for a
      // "needs_link" state); Helm sends it in the branded invitation look as a www.helm.events
      // /auth/confirm link (the Supabase project URL never appears in the e-mail).
      if (mailConfig().provider && (st.account === "needs_link" || st.account === "unconfirmed")) {
        const ltype = st.confirmed === true ? "magiclink" : "invite";
        const { data: gl, error: gErr } = await admin.auth.admin.generateLink({ type: ltype, email: bound, options: { redirectTo: link } });
        const action = confirmLink(String(gl?.properties?.hashed_token ?? ""), ltype, "/login?invite=" + token, Deno.env.get("APP_URL")) || "";
        if (!gErr && action) {
          const ctx = await contextOf();
          const mail = newLinkEmail({ link: action, studio: ctx.studio, inviter: ctx.inviter, role: inv.role });
          if (mail) {
            const r = await sendMail({ to: bound, subject: mail.subject, html: mail.html, text: mail.text, studio: ctx.studio, txReason: "invite" });
            if (r.status === "sent") return json({ ok: true, sent: true });
          }
        } else if (isRateLimited(gErr)) {
          return json({ error: "A new link was sent a moment ago — check your inbox (and spam), or try again in a minute.", code: "rate_limited" }, 429);
        }
        // provider refused / link not made: fall through to Supabase Auth's own e-mail
      }
      // no provider: never confirmed → the "Invite user" e-mail again (Supabase re-sends it for the same
      // login); confirmed (the first link was opened) or unknown → the "Magic Link" e-mail, never creating a user
      let sendErr: unknown = null;
      if (st.confirmed !== true) {
        const { error } = await admin.auth.admin.inviteUserByEmail(bound, { redirectTo: link });
        sendErr = error && isAlready(error) ? "otp" : error;
        if (!error) return json({ ok: true, sent: true });
      } else sendErr = "otp";
      if (sendErr === "otp") {
        const { error } = await admin.auth.signInWithOtp({ email: bound, options: { shouldCreateUser: false, emailRedirectTo: link } });
        sendErr = error || null;
        if (!error) return json({ ok: true, sent: true });
      }
      if (isRateLimited(sendErr)) return json({ error: "A new link was sent a moment ago — check your inbox (and spam), or try again in a minute.", code: "rate_limited" }, 429);
      console.error("invite-signup: resend failed", errTag(sendErr));
      return json({ error: "We couldn't send the e-mail just now — try again in a minute, or ask your studio admin to re-send the invitation.", code: "send_failed" }, 502);
    }

    if (bound !== email) {
      return json({ error: "Use the e-mail address this invitation was sent to.", code: "email_mismatch" }, 403);
    }

    const { error: cErr } = await admin.auth.admin.createUser({
      email: bound, password, email_confirm: true,
      user_metadata: fullName ? { full_name: fullName } : {},
    });
    if (cErr) {
      const t = String(cErr.message || "") + " " + String((cErr as { code?: string }).code || "");
      if (isAlready(cErr)) {
        // the Supabase invite e-mail made this login without a password: never say "sign in"
        const st = await stateOf();
        if (st.account === "needs_link") return json({ error: NEEDS_LINK_MSG, code: "needs_link" }, 409);
        if (st.account === "unconfirmed") return json({ error: UNCONFIRMED_MSG, code: "needs_link", reason: "unconfirmed" }, 409);
        return json({ error: EXISTS_MSG, code: "account_exists" }, 409);
      }
      // r29: Supabase's leaked-password check (HaveIBeenPwned) -> the same plain words as the sign-up page
      if (/pwned|known to be weak|easy to guess|leaked/i.test(t) || ((cErr as { reasons?: string[] }).reasons || []).includes("pwned"))
        return json({ error: "This password is too common and easy to guess. Please choose a different password. (Ref: AUTH-weak_password)", code: "weak_password" }, 400);
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
