// welcome-mailer — e-mails the welcomes queued by migration 0057 (welcome_email_outbox):
// "Welcome to Helm" for a new studio's owner, "You've joined <studio>" for an invited member.
// DORMANT BY DEFAULT: unless HELM_WELCOME_EMAILS_ENABLED === "true" every request is a
// no-op 200. Invoked ONLY by a cron / service caller presenting a shared secret.
//
// Secrets / env:
//   HELM_WELCOME_EMAILS_ENABLED="true"   turn it on (anything else → dormant no-op)
//   HELM_WELCOME_EMAIL_SECRET            shared secret; caller sends it in the
//                                        `x-helm-cron-secret` header. Unset → every call 401.
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected)
//   RESEND_API_KEY, RESEND_FROM          unset key → rows are marked "skipped"
//   WELCOME_EMAIL_BATCH                  rows per run, 1..100 (default 25)
//
// The database decides WHO gets mail (one row per person per kind, queued by triggers).
// Logs carry only counts, SQLSTATE codes and HTTP status — never an address or a name.
// Outbound HTTP goes only to a FIXED host allowlist (no URL is ever taken from input).
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { errTag } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readBodyCapped } from "../_shared/limits.ts";
import { render } from "./templates.ts";

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

// Provider abstraction: today Resend or nothing.
async function sendEmail(to: string, subject: string, html: string, text: string): Promise<SendResult> {
  const key = Deno.env.get("RESEND_API_KEY") || "";
  if (!key) return "skipped";
  if (!EMAIL.test(to)) return "skipped";
  const conf = Deno.env.get("RESEND_FROM") || "onboarding@resend.dev";
  const m = conf.match(/<([^>]+)>/);
  const from = `"Helm" <${(m ? m[1] : conf).trim()}>`;
  try {
    const r = await safeFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
    await r.text();
    if (!r.ok) console.error("welcome-mailer: provider status", r.status);
    return r.ok ? "sent" : "failed";
  } catch (e) {
    console.error("welcome-mailer: provider error", errTag(e));
    return "failed";
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  try {
    if (Deno.env.get("HELM_WELCOME_EMAILS_ENABLED") !== "true") return json({ status: "dormant" });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const wait = await checkLimits([["welcome:ip:" + clientIp(req), 30, 60_000]]);
    if (wait) return new Response(JSON.stringify({ error: "too many requests" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(wait) } });
    await readBodyCapped(req);   // body unused; drained under the 16 KB cap (413 above it)
    const ok = await secretMatches(req.headers.get("x-helm-cron-secret") || "", Deno.env.get("HELM_WELCOME_EMAIL_SECRET") || "");
    if (!ok) return json({ error: "unauthorized" }, 401);

    const batch = Math.min(100, Math.max(1, Number(Deno.env.get("WELCOME_EMAIL_BATCH")) || 25));
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    const { data: rows, error } = await admin.rpc("welcome_email_outbox_claim", { p_limit: batch });
    if (error) { console.error("welcome-mailer: claim failed", errTag(error)); return json({ error: "internal error" }, 500); }

    const counts = { sent: 0, skipped: 0, failed: 0, invalid: 0 };
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const id = String(r?.id ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const mail = render(String(r?.kind ?? ""), { name: r?.name, studio: r?.studio });
      const res: SendResult = mail ? await sendEmail(String(r?.to ?? ""), mail.subject, mail.html, mail.text) : "skipped";
      const { error: mErr } = await admin.rpc("welcome_email_outbox_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { console.error("welcome-mailer: mark failed", errTag(mErr)); counts.failed++; continue; }
      counts[res]++;
    }
    console.log("welcome-mailer: run", JSON.stringify(counts));
    return json({ status: "ok", ...counts });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    console.error("welcome-mailer error", errTag(e));
    return json({ error: "internal error" }, 500);
  }
});
