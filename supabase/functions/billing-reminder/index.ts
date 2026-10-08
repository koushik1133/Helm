// billing-reminder — sends Helm subscription "due soon" / "past due" e-mails to studios.
// DORMANT BY DEFAULT: unless HELM_BILLING_REMINDERS_ENABLED === "true" every request is a
// no-op 200. Invoked ONLY by a cron / service caller presenting a shared secret.
//
// Secrets / env:
//   HELM_BILLING_REMINDERS_ENABLED="true"   turn it on (anything else → dormant no-op)
//   HELM_BILLING_CRON_SECRET                shared secret; caller sends it in the
//                                           `x-helm-cron-secret` header. Unset → every call 401.
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected)
//   RESEND_API_KEY, RESEND_FROM             unset key → reminders are marked "skipped"
//   APP_URL                                 link in the e-mail (default https://www.helm.events)
//   BILLING_REMINDER_BATCH                  rows per run, 1..200 (default 50)
//
// ASSUMED SCHEMA (migration 0045, NOT FINAL — read defensively):
//   billing_reminders(id uuid, org_id uuid, kind 'due_soon'|'past_due', period_end date,
//                     sent_at timestamptz null, channel text null)
//   organizations(id, name, business_email)
// A row is "unsent" while sent_at IS NULL. Marking is idempotent: UPDATE … WHERE id = $1
// AND sent_at IS NULL, so two overlapping cron runs can never double-mark; a row whose
// e-mail failed stays unsent and is retried on the next run.
//   channel = 'email'   sent through the provider
//   channel = 'skipped' no provider configured / no valid studio address (not retried)
//
// Logs carry only counts, SQLSTATE codes and HTTP status — never addresses or names.
// Outbound HTTP goes only to a FIXED host allowlist (no URL is ever taken from input).
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { errTag, escHtml } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, rateLimit, readBodyCapped } from "../_shared/limits.ts";

const enc = new TextEncoder();
const ALLOWED_HOSTS = new Set(["api.resend.com"]);
const EMAIL = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const UUIDISH = /^[0-9a-f-]{36}$/i;

// constant-time compare of two secrets of any length (compare their SHA-256 digests)
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

// Provider abstraction: today Resend or nothing.
async function sendEmail(to: string, subject: string, html: string): Promise<SendResult> {
  const key = Deno.env.get("RESEND_API_KEY") || "";
  if (!key) return "skipped";
  if (!EMAIL.test(to)) return "skipped";
  const conf = Deno.env.get("RESEND_FROM") || "onboarding@resend.dev";
  const m = conf.match(/<([^>]+)>/);
  const from = `"Helm Billing" <${(m ? m[1] : conf).trim()}>`;
  try {
    const r = await safeFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html }),
    });
    await r.text();
    if (!r.ok) console.error("billing-reminder: provider status", r.status);
    return r.ok ? "sent" : "failed";
  } catch (e) {
    console.error("billing-reminder: provider error", errTag(e));
    return "failed";
  }
}

function message(kind: string, studio: string, periodEnd: string) {
  const app = (Deno.env.get("APP_URL") || "https://www.helm.events").replace(/\/+$/, "");
  const date = /^\d{4}-\d{2}-\d{2}/.test(periodEnd) ? periodEnd.slice(0, 10) : "";
  if (kind === "past_due") {
    return {
      subject: "Your Helm subscription payment is past due",
      html: `<p>Hi ${escHtml(studio)},</p><p>Your Helm subscription period${date ? " ended on <b>" + escHtml(date) + "</b>" : " has ended"} and payment has not been received yet. Please renew to keep your studio active.</p><p><a href="${escHtml(app)}/settings.html">Open billing</a></p>`,
    };
  }
  return {
    subject: "Your Helm subscription renews soon",
    html: `<p>Hi ${escHtml(studio)},</p><p>Your Helm subscription period ends${date ? " on <b>" + escHtml(date) + "</b>" : " soon"}. Renew before then to avoid interruption.</p><p><a href="${escHtml(app)}/settings.html">Open billing</a></p>`,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  try {
    if (Deno.env.get("HELM_BILLING_REMINDERS_ENABLED") !== "true") return json({ status: "dormant" });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const wait = await rateLimit("bill:ip:" + clientIp(req), 30, 60_000);
    if (wait) return new Response(JSON.stringify({ error: "too many requests" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(wait) } });
    await readBodyCapped(req);   // body unused; drained under the 16 KB cap (413 above it)
    const ok = await secretMatches(req.headers.get("x-helm-cron-secret") || "", Deno.env.get("HELM_BILLING_CRON_SECRET") || "");
    if (!ok) return json({ error: "unauthorized" }, 401);

    const batch = Math.min(200, Math.max(1, Number(Deno.env.get("BILLING_REMINDER_BATCH")) || 50));
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    const { data: rows, error } = await admin.from("billing_reminders")
      .select("id, org_id, kind, period_end").is("sent_at", null).order("period_end", { ascending: true }).limit(batch);
    if (error) { console.error("billing-reminder: load failed", errTag(error)); return json({ error: "internal error" }, 500); }

    const counts = { sent: 0, skipped: 0, failed: 0, invalid: 0 };
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const id = String(r?.id ?? ""), kind = String(r?.kind ?? "");
      if (!UUIDISH.test(id) || !["due_soon", "past_due"].includes(kind)) { counts.invalid++; continue; }
      const { data: org, error: oErr } = await admin.from("organizations").select("name, business_email").eq("id", r.org_id).maybeSingle();
      if (oErr) { console.error("billing-reminder: studio load failed", errTag(oErr)); counts.failed++; continue; }
      const msg = message(kind, String(org?.name || "there"), String(r.period_end ?? ""));
      const res = await sendEmail(String(org?.business_email || ""), msg.subject, msg.html);
      if (res === "failed") { counts.failed++; continue; }               // left unsent → retried next run
      const { error: uErr } = await admin.from("billing_reminders")
        .update({ sent_at: new Date().toISOString(), channel: res === "sent" ? "email" : "skipped" })
        .eq("id", id).is("sent_at", null);                                  // idempotent mark
      if (uErr) { console.error("billing-reminder: mark failed", errTag(uErr)); counts.failed++; continue; }
      counts[res]++;
    }
    console.log("billing-reminder: run", JSON.stringify(counts));
    return json({ status: "ok", ...counts });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    console.error("billing-reminder error", errTag(e));
    return json({ error: "internal error" }, 500);
  }
});
