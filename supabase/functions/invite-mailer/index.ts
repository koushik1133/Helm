// invite-mailer — e-mails staff invitations queued by migration 0131 (invite_email_outbox):
// "<Admin> invited you to join <Studio> on Helm as <Role>" with a Join button to
// <APP_URL>/login?invite=<token> and the expiry date.
// ON BY DEFAULT: kill switch HELM_INVITE_EMAILS_ENABLED="false" → every request is a
// no-op 200 {status:"dormant"}.
// Delivery: RESEND_API_KEY set → Resend (branded e-mail). Unset → Supabase's own Auth
// e-mail (no extra account needed): a brand-new address gets the "Invite user" e-mail,
// an existing account gets the "Magic Link" e-mail; both land on <APP_URL>/login?invite=…
// signed in, and login.html accepts the invitation automatically.
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
//   RESEND_API_KEY, RESEND_FROM          unset key → Supabase Auth e-mail fallback
//   APP_URL                              base of the Join link (default https://www.helm.events)
//   INVITE_EMAIL_BATCH                   rows per run, 1..100 (default 25)
//
// Logs carry only counts, SQLSTATE codes and HTTP status — never an address, a name or a token.
// Outbound HTTP goes only to a FIXED host allowlist (no URL is ever taken from input).
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { bearer, errTag, responders } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readBodyCapped, tooMany } from "../_shared/limits.ts";
import { inviteEmail, joinLink } from "./templates.ts";
import { postalAddress, txFooter, withFooter } from "../_shared/email-compliance.mjs";

const enc = new TextEncoder();
const ALLOWED_HOSTS = new Set(["api.resend.com"]);
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

async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) throw new Error("host not allowed");
  return await fetch(u.toString(), { ...init, redirect: "error" });
}

type SendResult = "sent" | "skipped" | "failed";

// kill switch only: anything but an explicit "false" keeps invite e-mails on
export function inviteEmailsOn(v: string | undefined): boolean {
  return String(v ?? "").trim().toLowerCase() !== "false";
}

// No Resend key: send through Supabase Auth's own mailer (project SMTP / built-in).
// New address → inviteUserByEmail ("Invite user" template); already has an account →
// signInWithOtp magic link ("Magic Link" template, never creates a user).
// deno-lint-ignore no-explicit-any
async function sendViaSupabaseAuth(admin: any, to: string, token: string, meta: Record<string, string>): Promise<SendResult> {
  const link = joinLink(token);
  if (!link || !EMAIL.test(to)) return "skipped";
  try {
    const { error } = await admin.auth.admin.inviteUserByEmail(to, { redirectTo: link, data: meta });
    if (!error) return "sent";
    const already = /already|registered|exists/i.test(String(error.message || "") + " " + String(error.code || "")) || error.status === 422;
    if (!already) { console.error("invite-mailer: auth invite status", error.status ?? "?"); return "failed"; }
    const { error: oErr } = await admin.auth.signInWithOtp({ email: to, options: { shouldCreateUser: false, emailRedirectTo: link } });
    if (oErr) { console.error("invite-mailer: auth magic-link status", oErr.status ?? "?"); return "failed"; }
    return "sent";
  } catch (e) {
    console.error("invite-mailer: auth mail error", errTag(e));
    return "failed";
  }
}

async function sendEmail(to: string, subject: string, html: string, text: string): Promise<SendResult> {
  const key = Deno.env.get("RESEND_API_KEY") || "";
  if (!key) return "skipped";   // caller falls back to Supabase Auth e-mail
  if (!EMAIL.test(to)) return "skipped";
  const conf = Deno.env.get("RESEND_FROM") || "onboarding@resend.dev";
  const m = conf.match(/<([^>]+)>/);
  const from = `"Helm" <${(m ? m[1] : conf).trim()}>`;
  const _f = withFooter({ text: text, html }, txFooter("invite", { app: Deno.env.get("APP_URL"), address: postalAddress((k: string) => Deno.env.get(k)) }));
    try {
    const r = await safeFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html: _f.html, text: _f.text }),
    });
    await r.text();
    if (!r.ok) console.error("invite-mailer: provider status", r.status);
    return r.ok ? "sent" : "failed";
  } catch (e) {
    console.error("invite-mailer: provider error", errTag(e));
    return "failed";
  }
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
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const id = String(r?.id ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const mail = inviteEmail({ token: r?.token, inviter: r?.inviter, studio: r?.studio, role: r?.role, expires_at: r?.expires_at });
      const to = String(r?.to ?? "");
      let res: SendResult = "skipped";
      if (mail && Deno.env.get("RESEND_API_KEY")) res = await sendEmail(to, mail.subject, mail.html, mail.text);
      else if (mail) res = await sendViaSupabaseAuth(admin, to, String(r?.token ?? ""), {
        studio: String(r?.studio ?? "").slice(0, 120), role: String(r?.role ?? "").slice(0, 60), invited_by: String(r?.inviter ?? "").slice(0, 120),
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
