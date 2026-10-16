// comms-dispatch - delivers the messages queued by migration 0078 (comms_outbox):
//   * pay_reminder  client payment reminders (automatic + "Send reminder now")  e-mail / WhatsApp
//   * follow_up     polite client follow-ups after the booklet / quote was opened e-mail / WhatsApp
//   * trial reminders (0120) the studio's own 8-day free-trial reminders (day 5 / 7 / 8), e-mail only,
//                   claimed from trial_reminders via trial_reminder_email_claim (re-checked there)
//   * wa_forward    WhatsApp copies of a member's bell notifications (+ studio announcements),
//                   each with a short deep link that opens the exact page in Helm.
// AUTO-ON: runs whenever it is called with the shared secret; each channel switches itself on
// when its secrets exist (e-mail: RESEND_API_KEY; WhatsApp: WHATSAPP_TOKEN + WHATSAPP_PHONE_ID).
// Kill switch: HELM_COMMS_ENABLED="false" -> every request is a no-op 200 and nothing is
// claimed (rows stay queued). Invoked ONLY by a cron / service caller presenting a
// shared secret. The database decides WHAT is due (comms_tick, pg_cron) and re-checks every row
// at claim time (paid / approved / opted out -> skipped).
//
// Secrets / env:
//   HELM_COMMS_ENABLED="false"        kill switch (unset / anything else -> on)
//   HELM_COMMS_SECRET                 shared secret in the `x-helm-cron-secret` header; unset -> 401
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected)
//   RESEND_API_KEY, RESEND_FROM       unset key -> e-mail rows are marked "skipped"
//   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_API_VERSION (default v21.0)
//   WHATSAPP_TPL_TASK_ASSIGNED        approved template for "you've been assigned" (e.g. helm_task_assigned)
//   WHATSAPP_TPL_EVENT_REMINDER       approved template for event reminders  (e.g. helm_event_reminder)
//   COMMS_WHATSAPP_TEMPLATE           approved template for everything else; each template has ONE
//                                     body parameter {{1}} (the text). WHATSAPP_TPL_LANG (default en).
//                                     No template for a kind -> session text when WHATSAPP_ALLOW_TEXT=1,
//                                     else skipped
//   APP_URL                           site origin for deep links (default https://www.helm.events)
//   COMMS_BATCH                       rows per run, 1..100 (default 25)
//
// Idempotent: the database hands each row out once (claim + mark, UNIQUE dedupe key) and the
// row id is sent as the e-mail provider idempotency key. Logs carry only counts and status
// codes - never an address, a phone number, a name or message text. Outbound HTTP goes only
// to a FIXED host allowlist; no URL is ever taken from the database (deep links are built
// from ids by the same rule as the in-app bell and joined to APP_URL).
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { errTag, escHtml } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readBodyCapped } from "../_shared/limits.ts";
import { absoluteLink } from "./deeplink.js";
import { trialReminderEmail } from "./trial-reminders.mjs";

const enc = new TextEncoder();
const ALLOWED_HOSTS = new Set(["api.resend.com", "graph.facebook.com"]);
const EMAIL = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
const PHONE = /^[0-9]{8,15}$/;
const UUIDISH = /^[0-9a-f-]{36}$/i;

export async function secretMatches(given: string, expected: string): Promise<boolean> {
  if (!expected || !given) return false;
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
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

type Res = "sent" | "skipped" | "failed";

function appOrigin(): string {
  const v = (Deno.env.get("APP_URL") || "https://www.helm.events").trim();
  return /^https:\/\/[A-Za-z0-9.-]{1,190}(:[0-9]{1,5})?\/?$/.test(v) ? v.replace(/\/+$/, "") : "https://www.helm.events";
}

async function sendEmail(id: string, to: string, subject: string, text: string, studio: string): Promise<Res> {
  const key = Deno.env.get("RESEND_API_KEY") || "";
  if (!key || !EMAIL.test(to) || !text) return "skipped";
  const conf = Deno.env.get("RESEND_FROM") || "onboarding@resend.dev";
  const m = conf.match(/<([^>]+)>/);
  const name = (studio || "Helm").replace(/["<>\r\n]/g, "").slice(0, 60) || "Helm";
  const from = `"${name}" <${(m ? m[1] : conf).trim()}>`;
  const html = `<p>${escHtml(text).replace(/\n/g, "<br>")}</p>`;
  try {
    const r = await safeFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json", "Idempotency-Key": "comms-" + id },
      body: JSON.stringify({ from, to: [to], subject: subject.slice(0, 150), html, text }),
    });
    await r.text();
    if (!r.ok) console.error("comms-dispatch: email status", r.status);
    return r.ok ? "sent" : "failed";
  } catch (e) { console.error("comms-dispatch: email error", errTag(e)); return "failed"; }
}

// kill switch only: anything but an explicit "false" keeps the dispatcher on
export function commsOn(v: string | undefined): boolean {
  return String(v ?? "").trim().toLowerCase() !== "false";
}

export type WaKind = "task_assigned" | "event_reminder" | "general";
const TPL_ENV: Record<WaKind, string> = {
  task_assigned: "WHATSAPP_TPL_TASK_ASSIGNED", event_reminder: "WHATSAPP_TPL_EVENT_REMINDER", general: "COMMS_WHATSAPP_TEMPLATE",
};
const TPL_NAME = /^[a-z0-9_]{1,64}$/;
// the approved template for this kind (falls back to the general one), or "" for none
export function templateFor(kind: WaKind, env: (k: string) => string | undefined): string {
  const own = String(env(TPL_ENV[kind]) || "").trim();
  if (TPL_NAME.test(own)) return own;
  const gen = String(env(TPL_ENV.general) || "").trim();
  return TPL_NAME.test(gen) ? gen : "";
}
// Meta's template text parameter may not contain newlines / tabs / 4+ spaces in a row
export function tplParam(text: string): string {
  return String(text || "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim().slice(0, 1000);
}
export function waContent(kind: WaKind, text: string, env: (k: string) => string | undefined): Record<string, unknown> | null {
  const tpl = templateFor(kind, env);
  if (tpl) {
    const lang = /^[a-z]{2}(_[A-Z]{2})?$/.test(String(env("WHATSAPP_TPL_LANG") || "")) ? String(env("WHATSAPP_TPL_LANG")) : "en";
    return { type: "template", template: { name: tpl, language: { code: lang }, components: [{ type: "body", parameters: [{ type: "text", text: tplParam(text) }] }] } };
  }
  if (env("WHATSAPP_ALLOW_TEXT") === "1") return { type: "text", text: { preview_url: false, body: text.slice(0, 1000) } };
  return null;
}

async function sendWhatsApp(to: string, text: string, kind: WaKind = "general"): Promise<Res> {
  const token = Deno.env.get("WHATSAPP_TOKEN") || "", phoneId = Deno.env.get("WHATSAPP_PHONE_ID") || "";
  if (!token || !/^[0-9]{5,20}$/.test(phoneId) || !PHONE.test(to) || !text) return "skipped";
  const ver = /^v[0-9]{1,2}\.[0-9]$/.test(Deno.env.get("WHATSAPP_API_VERSION") || "") ? Deno.env.get("WHATSAPP_API_VERSION")! : "v21.0";
  const content = waContent(kind, text, (k) => Deno.env.get(k));
  if (!content) return "skipped";
  try {
    const r = await safeFetch(`https://graph.facebook.com/${ver}/${encodeURIComponent(phoneId)}/messages`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, ...content }),
    });
    await r.text();
    if (!r.ok) console.error("comms-dispatch: whatsapp status", r.status);
    return r.ok ? "sent" : "failed";
  } catch (e) { console.error("comms-dispatch: whatsapp error", errTag(e)); return "failed"; }
}

// 0132: assignment text from the database + the person's own task link (path is validated
// against the one shape the database writes; the host is always APP_URL, never the database)
const ASSIGN_LINK = /^work\.html\?token=[0-9a-f-]{36}$/;
export function assignMessage(text: string, linkPath: string, origin: string): string {
  const t = String(text || "").slice(0, 880).trim();
  if (!t) return "";
  return ASSIGN_LINK.test(linkPath) ? t + " " + origin + "/" + linkPath : t;
}

// the message for one claimed row (text from the database + the deep link for forwards)
export function messageFor(purpose: string, payload: Record<string, unknown>, origin: string): { subject: string; text: string } {
  const text = String(payload?.text ?? "").slice(0, 900);
  if (purpose === "wa_forward") {
    const link = absoluteLink(origin, payload);
    return { subject: "", text: link ? text + "\n" + link : text };
  }
  return { subject: String(payload?.subject ?? "A message from your planner"), text };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  try {
    if (!commsOn(Deno.env.get("HELM_COMMS_ENABLED"))) return json({ status: "dormant" });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const wait = await checkLimits([["comms:ip:" + clientIp(req), 30, 60_000]]);
    if (wait) return new Response(JSON.stringify({ error: "too many requests" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(wait) } });
    await readBodyCapped(req);
    const ok = await secretMatches(req.headers.get("x-helm-cron-secret") || "", Deno.env.get("HELM_COMMS_SECRET") || "");
    if (!ok) return json({ error: "unauthorized" }, 401);

    const batch = Math.min(100, Math.max(1, Number(Deno.env.get("COMMS_BATCH")) || 25));
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: rows, error } = await admin.rpc("comms_outbox_claim", { p_limit: batch });
    if (error) { console.error("comms-dispatch: claim failed", errTag(error)); return json({ error: "internal error" }, 500); }

    const origin = appOrigin();
    const counts = { sent: 0, skipped: 0, failed: 0, invalid: 0 };
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const id = String(r?.id ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const purpose = String(r?.purpose ?? ""), channel = String(r?.channel ?? ""), to = String(r?.to ?? "");
      const payload = (r?.payload && typeof r.payload === "object") ? r.payload : {};
      const msg = messageFor(purpose, payload, origin);
      let res: Res = "skipped";
      if (channel === "email" && purpose !== "wa_forward") res = await sendEmail(id, to, msg.subject, msg.text, String(payload.studio ?? ""));
      else if (channel === "whatsapp") res = await sendWhatsApp(to, msg.text, purpose === "wa_forward" && String(payload.type ?? "") === "event_reminder" ? "event_reminder" : "general");
      const { error: mErr } = await admin.rpc("comms_outbox_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { console.error("comms-dispatch: mark failed", errTag(mErr)); counts.failed++; continue; }
      counts[res]++;
    }
    // 0120: free-trial reminder e-mails (a database without 0120 just has nothing to claim)
    const { data: trows, error: tErr } = await admin.rpc("trial_reminder_email_claim", { p_limit: batch });
    if (tErr) console.error("comms-dispatch: trial claim skipped", errTag(tErr));
    for (const r of (Array.isArray(trows) ? trows : [])) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const msg = trialReminderEmail(String(r?.milestone ?? ""), String(r?.studio ?? ""), String(r?.ends_at ?? ""), String(r?.timezone ?? ""), origin);
      const res: Res = msg ? await sendEmail(id, to, msg.subject, msg.text, "Helm") : "skipped";
      const { error: mErr } = await admin.rpc("trial_reminder_email_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { console.error("comms-dispatch: trial mark failed", errTag(mErr)); counts.failed++; continue; }
      counts[res]++;
    }
    // 0132: "you've been assigned ..." WhatsApp to staff (a database without 0132 has nothing to claim)
    const { data: arows, error: aErr } = await admin.rpc("assign_notify_claim", { p_limit: batch });
    if (aErr) console.error("comms-dispatch: assign claim skipped", errTag(aErr));
    for (const r of (Array.isArray(arows) ? arows : [])) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const text = assignMessage(String(r?.text ?? ""), String(r?.link_path ?? ""), origin);
      const res: Res = text ? await sendWhatsApp(to, text, "task_assigned") : "skipped";
      const { error: mErr } = await admin.rpc("assign_notify_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { console.error("comms-dispatch: assign mark failed", errTag(mErr)); counts.failed++; continue; }
      counts[res]++;
    }
    console.log("comms-dispatch: run", JSON.stringify(counts));
    return json({ status: "ok", ...counts });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    console.error("comms-dispatch error", errTag(e));
    return json({ error: "internal error" }, 500);
  }
});
