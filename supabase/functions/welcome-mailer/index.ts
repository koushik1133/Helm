// welcome-mailer — e-mails the welcomes queued by migration 0057 (welcome_email_outbox):
// "Welcome to Helm" for a new studio's owner, "You've joined <studio>" for an invited member.
// R119 (0327): a studio on its FREE TRIAL gets the trial welcome (8 days, sample data, simulation, limits, what is
// locked, read-only after) and a trial member a short "nothing is sent to clients" note. Sent through the SHARED
// mailer (_shared/mailer.ts: SMTP first when set up, else Resend) - the same path as invitations and trial reminders.
// comms-dispatch sends the same welcomes on its own schedule (welcome-mailer/send.ts), so this function is OPTIONAL:
// deploy it only if you want a separate welcome cron.
// DORMANT BY DEFAULT: unless HELM_WELCOME_EMAILS_ENABLED === "true" every request is a no-op 200. Even when it is on,
// NOTHING is claimed until the database switch is on (helm_welcome_mail_settings.enabled, 0327, default off) and the
// 0327 claim only hands out rows queued in the last 48 hours (older ones are closed, never sent late).
// Invoked ONLY by a cron / service caller presenting a shared secret.
//
// Secrets / env:
//   HELM_WELCOME_EMAILS_ENABLED="true"   turn this function on (anything else → dormant no-op)
//   HELM_WELCOME_EMAIL_SECRET            shared secret; caller sends it in the
//                                        `x-helm-cron-secret` header. Unset → every call 401.
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected)
//   SMTP_HOST / SMTP_USER / SMTP_PASS (+ SMTP_PORT, SMTP_FROM) or RESEND_API_KEY + RESEND_FROM - the shared mailer;
//                                        neither set → rows are marked "skipped"
//   WELCOME_EMAIL_BATCH                  rows per run, 1..100 (default 25)
//
// The database decides WHO gets mail (one row per person per kind, queued by triggers, re-checked at claim).
// Logs carry only counts, SQLSTATE codes and HTTP status — never an address or a name.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { errTag } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readBodyCapped } from "../_shared/limits.ts";
import { runWelcomeBatch } from "./send.ts";

const enc = new TextEncoder();

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

    const w = await runWelcomeBatch(admin, batch);
    if (w.error) { console.error("welcome-mailer: claim failed", errTag(w.error)); return json({ error: "internal error" }, 500); }
    if (w.off) return json({ status: "switched_off" });   // 0327 switch off: nothing claimed
    const counts = w.counts;
    console.log("welcome-mailer: run", JSON.stringify(counts));
    return json({ status: "ok", ...counts });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    console.error("welcome-mailer error", errTag(e));
    return json({ error: "internal error" }, 500);
  }
});
