// invite-mailer — e-mails staff invitations queued by migration 0131 (invite_email_outbox):
// "<Admin> invited you to join <Studio> on Helm as <Role>" with a Join button to
// <APP_URL>/login?invite=<token> and the expiry date.
// ON BY DEFAULT: kill switch HELM_INVITE_EMAILS_ENABLED="false" → every request is a
// no-op 200 {status:"dormant"}.
// Delivery (0201: ONE invitation for every invitee - brand-new address, existing account,
// re-invite / resend, bulk invite, Staff "Invite to log in", Control Center "Users & invites"):
//   * an e-mail provider is set for the edge functions (RESEND_API_KEY + RESEND_FROM, else
//     SMTP_HOST / SMTP_USER / SMTP_PASS [/ SMTP_PORT / SMTP_FROM] - _shared/mailer.ts, the same
//     secrets client-mailer uses) → the branded templates.ts invitation "Join <Studio> on Helm -
//     <Inviter> invited you as <Role>" [Accept invitation] → <APP_URL>/login?invite=<token>.
//     Supabase creates NO login up front; the join page makes it (invite-signup) or signs in.
//   * neither set → Supabase Auth's own e-mail: a brand-new address gets the "Invite user" e-mail,
//     an existing account the "Magic Link" e-mail - after its login's studio / role / inviter
//     metadata is refreshed (invite_auth_user_id, 0201), so both templates
//     (docs/ops/email-templates) read as the same "Join <Studio>" invitation and land on
//     <APP_URL>/login?invite=… signed in; login.html accepts the invitation automatically.
//
// Two ways to call it:
//   * cron / service caller: header `x-helm-cron-secret: <HELM_INVITE_EMAIL_SECRET>` → flushes
//     every studio's queue (same as welcome-mailer / security-alert-mailer).
//   * a signed-in studio ADMIN right after creating / re-sending an invite (Staff page):
//     `Authorization: Bearer <their access token>` → flushes ONLY that admin's studio
//     (decided by the DB via invite_email_kick_org(), never by the request body).
//
// Secrets / env:
//   HELM_INVITE_EMAILS_ENABLED="false"  kill switch (unset / anything else → on)
//   HELM_INVITE_EMAIL_SECRET            cron shared secret. Unset → cron calls 401.
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY (injected)
//   RESEND_API_KEY + RESEND_FROM, or SMTP_HOST / SMTP_USER / SMTP_PASS (+ SMTP_PORT, SMTP_FROM)
//                                        neither → Supabase Auth e-mail fallback
//   APP_URL                              base of the Join link (default https://www.helm.events)
//   INVITE_EMAIL_BATCH                   rows per run, 1..100 (default 25)
//
// Logs carry only counts, SQLSTATE codes and HTTP status — never an address, a name or a token.
// Outbound HTTP goes only to a FIXED host allowlist (no URL is ever taken from input).
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { bearer, errTag, responders } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readBodyCapped, tooMany } from "../_shared/limits.ts";
import { inviteEmail, joinLink, roleLabel } from "./templates.ts";
import { mailConfig, sendMail } from "../_shared/mailer.ts";

const enc = new TextEncoder();
const EMAIL = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const UUIDISH = /^[0-9a-f-]{36}$/i;

export async function secretMatches(given: string, expected: string): Promise<boolean> {
  if (!expected || !given) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

type SendResult = "sent" | "skipped" | "failed";

// kill switch only: anything but an explicit "false" keeps invite e-mails on
export function inviteEmailsOn(v: string | undefined): boolean {
  return String(v ?? "").trim().toLowerCase() !== "false";
}

// No e-mail provider: send through Supabase Auth's own mailer (project SMTP / built-in).
// New address → inviteUserByEmail ("Invite user" template); already has an account →
// its studio / role / inviter metadata is refreshed first (same keys as the invite e-mail, so the
// "Magic Link" template reads as the same invitation), then signInWithOtp (never creates a user).
// deno-lint-ignore no-explicit-any
async function sendViaSupabaseAuth(admin: any, to: string, token: string, meta: Record<string, string>): Promise<SendResult> {
  const link = joinLink(token);
  if (!link || !EMAIL.test(to)) return "skipped";
  try {
    const { error } = await admin.auth.admin.inviteUserByEmail(to, { redirectTo: link, data: meta });
    if (!error) return "sent";
    const already = /already|registered|exists/i.test(String(error.message || "") + " " + String(error.code || "")) || error.status === 422;
    if (!already) { console.error("invite-mailer: auth invite status", error.status ?? "?"); return "failed"; }
    // best effort: only the invitation keys of THIS invitation's own login (0201); never blocks the send
    try {
      const { data: uid } = await admin.rpc("invite_auth_user_id", { p_token: token });
      if (typeof uid === "string" && UUIDISH.test(uid)) {
        const { error: uErr } = await admin.auth.admin.updateUserById(uid, { user_metadata: meta });
        if (uErr) console.error("invite-mailer: invite details not refreshed", uErr.status ?? "?");
      }
    } catch (_) { /* 0201 not applied yet: the magic link shows the plain sign-in text */ }
    const { error: oErr } = await admin.auth.signInWithOtp({ email: to, options: { shouldCreateUser: false, emailRedirectTo: link } });
    if (oErr) { console.error("invite-mailer: auth magic-link status", oErr.status ?? "?"); return "failed"; }
    return "sent";
  } catch (e) {
    console.error("invite-mailer: auth mail error", errTag(e));
    return "failed";
  }
}

// branded invitation through the shared provider (Resend, else SMTP) - transactional footer added there
async function sendBranded(to: string, mail: { subject: string; html: string; text: string }, studio: string): Promise<SendResult> {
  if (!EMAIL.test(to)) return "skipped";
  const r = await sendMail({ to, subject: mail.subject, html: mail.html, text: mail.text, studio, txReason: "invite" });
  return r.status === "sent" ? "sent" : r.status === "failed" ? "failed" : "skipped";
}

Deno.serve(async (req) => {
  const { cors, json } = responders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!inviteEmailsOn(Deno.env.get("HELM_INVITE_EMAILS_ENABLED"))) return json({ status: "dormant" });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const wait = await checkLimits([["invite:ip:" + clientIp(req), 30, 60_000]]);
    if (wait) return tooMany(json, wait);
    await readBodyCapped(req);   // body unused; drained under the 16 KB cap (413 above it)

    const url = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    // who is calling? cron secret → all studios; signed-in admin → their own studio only
    let org: string | null = null;
    const cronHeader = req.headers.get("x-helm-cron-secret") || "";
    if (cronHeader) {
      const ok = await secretMatches(cronHeader, Deno.env.get("HELM_INVITE_EMAIL_SECRET") || "");
      if (!ok) return json({ error: "unauthorized" }, 401);
    } else {
      const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
      const jwt = bearer(req);
      if (!jwt || !anonKey || jwt === anonKey) return json({ error: "unauthorized" }, 401);
      const asCaller = createClient(url, anonKey, {
        global: { headers: { Authorization: "Bearer " + jwt } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: { user } } = await asCaller.auth.getUser(jwt);
      if (!user) return json({ error: "unauthorized" }, 401);
      const userWait = await checkLimits([["invite:user:" + user.id, 10, 60_000]]);
      if (userWait) return tooMany(json, userWait);
      const { data: kOrg, error: kErr } = await asCaller.rpc("invite_email_kick_org");
      if (kErr) { console.error("invite-mailer: kick check failed", errTag(kErr)); return json({ error: "internal error" }, 500); }
      if (typeof kOrg !== "string" || !UUIDISH.test(kOrg)) return json({ error: "forbidden" }, 403);
      org = kOrg;
    }

    const batch = Math.min(100, Math.max(1, Number(Deno.env.get("INVITE_EMAIL_BATCH")) || 25));
    const { data: rows, error } = await admin.rpc("invite_email_outbox_claim", { p_limit: batch, p_org: org });
    if (error) { console.error("invite-mailer: claim failed", errTag(error)); return json({ error: "internal error" }, 500); }

    const counts = { sent: 0, skipped: 0, failed: 0, invalid: 0 };
    const branded = !!mailConfig().provider;   // one provider decision per run (same e-mail for every row)
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const id = String(r?.id ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const mail = inviteEmail({ token: r?.token, inviter: r?.inviter, studio: r?.studio, role: r?.role, expires_at: r?.expires_at });
      const to = String(r?.to ?? "");
      let res: SendResult = "skipped";
      if (mail && branded) res = await sendBranded(to, mail, String(r?.studio ?? "").slice(0, 120));
      else if (mail) res = await sendViaSupabaseAuth(admin, to, String(r?.token ?? ""), {
        studio: String(r?.studio ?? "").slice(0, 120), role: roleLabel(r?.role).slice(0, 60), invited_by: String(r?.inviter ?? "").slice(0, 120),
      });
      const { error: mErr } = await admin.rpc("invite_email_outbox_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { console.error("invite-mailer: mark failed", errTag(mErr)); counts.failed++; continue; }
      counts[res]++;
    }
    console.log("invite-mailer: run", JSON.stringify({ scope: org ? "one" : "all", ...counts }));
    return json({ status: "ok", ...counts });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    console.error("invite-mailer error", errTag(e));
    return json({ error: "internal error" }, 500);
  }
});
