// comms-dispatch - delivers the messages queued by migration 0078 (comms_outbox):
//   * pay_reminder  client payment reminders (automatic + "Send reminder now")  e-mail / WhatsApp
//   * follow_up     polite client follow-ups after the booklet / quote was opened e-mail / WhatsApp
//   * trial reminders (0120) the studio's own 8-day free-trial reminders (day 5 / 7 / 8), e-mail only,
//                   claimed from trial_reminders via trial_reminder_email_claim (re-checked there)
//   * post-trial (0184) the studio owner's "trial ended 7 days ago" reminder + the deletion warnings
//                   30 / 7 / 1 day before the trial data is deleted, claimed via trial_retention_email_claim
//                   (re-checked there; warnings only while the owner switch helm_trial_retention.delete_enabled is on)
//   * wa_forward    WhatsApp copies of a member's bell notifications (+ studio announcements),
//                   each with a short deep link that opens the exact page in Helm.
//   * invite_site   (0195) "Send to client" on the Invitation Studio: the published invitation
//                   website link, e-mail / WhatsApp (invite-site.mjs; host = APP_URL, path from the row)
//   * delivery reminders (0241) the vendor / staff member responsible for a delivery or arrival, at the reminder
//                   times set on the assignment (e.g. 60 / 30 / 0 min before), e-mail only, each with a fresh
//                   one-click status link APP_URL/delivery?t=<token>; claimed via delivery_reminder_claim (re-checked
//                   there: answered / cancelled / switched off / ended trial -> skipped). Free trial: the database
//                   applies the 0212 caps when it queues them.
//   * vendor requests (0256) a vendor asked to take part in an event (+ reminders 24 h / 48 h later while unanswered),
//                   e-mail only, each with a fresh link APP_URL/vendor-request?t=<token> (accept / decline / invoice);
//                   claimed via vendor_request_claim(limit, 'email') (re-checked there; trials / samples never queue)
//   * run-sheet reminders (0269) the owner of a run-sheet line (team member / staff / vendor with an e-mail), at the
//                   line's reminder times (studio default 15 / 0 min before), e-mail only (WhatsApp goes through the 0132
//                   lane above); claimed via runsheet_reminder_claim (re-checked there; trials / samples never queue)
//   * enquiry replies (0269) the instant thank-you to someone who used a studio's public enquiry form (/<studio>/enquiry),
//                   the studio's own words; claimed via enquiry_reply_claim (re-checked there; trials never queue)
//   * Helm notices (0244) a studio's plan request -> sales@helm.events, and "Ask my admin to upgrade" -> the
//                   studio's admins, claimed from helm_notice_outbox (helm-notices.mjs; transactional footer)
//   * booklet_link  (0200) "Send to client" in the Share booklet dialog: the live client booklet
//                   link (booklet-link.mjs; host = APP_URL, path added by the claim - no token in the row)
//   * quote_expiry  (0262) "your quote is valid until dd/mm/yyyy" reminder before the date (quote-expiry.mjs; the
//                   approval link path is added by the claim - no token in the row; re-checked there)
// FREE TRIAL (0212): the database queues and hands out a free-trial studio's row ONLY for the invitation /
//   booklet link by e-mail of an ACTIVE trial, under caps (30 a day per studio, 5 a day per address); such a
//   row carries payload.trial_email = true. Checked once more here: a trial-marked row that is not exactly that
//   (any WhatsApp row, any other purpose) is marked skipped and never sent (trial-row.mjs).
// AUTO-ON: runs whenever it is called with the shared secret; each channel switches itself on
// when its secrets exist (e-mail: SMTP_HOST + SMTP_USER + SMTP_PASS, or RESEND_API_KEY;
// WhatsApp: WHATSAPP_TOKEN + WHATSAPP_PHONE_ID).
// E-MAIL TRANSPORT (release 1018): SMTP first - the same shared mailer (_shared/mailer.ts + smtp.ts)
// as client-mailer / invite-mailer / welcome-mailer, e.g. Gmail smtp.gmail.com:465 + an App Password.
// Resend only when SMTP is NOT set and RESEND_API_KEY is. Neither -> e-mail rows are "skipped".
// Both transports get the identical body + compliance footer + List-Unsubscribe headers (0165).
// Kill switch: HELM_COMMS_ENABLED="false" -> every request is a no-op 200 and nothing is
// claimed (rows stay queued). Invoked ONLY by a cron / service caller presenting a
// shared secret. The database decides WHAT is due (comms_tick, pg_cron) and re-checks every row
// at claim time (paid / approved / member opt-in withdrawn -> skipped). WhatsApp STOP replies
// (whatsapp_opt_outs, recorded by wa-webhook) are skipped by the claim since 0155, and checked
// once more right before each WhatsApp send (wa_recipient_opted_out; a failed check -> retry later).
//
// Secrets / env:
//   HELM_COMMS_ENABLED="false"        kill switch (unset / anything else -> on)
//   HELM_COMMS_SECRET                 shared secret in the `x-helm-cron-secret` header; unset -> 401
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected)
//   SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_PORT (default 465), SMTP_FROM (default SMTP_USER)
//                                     preferred e-mail transport (shared mailer). Display name:
//                                     EMAIL_BRAND_MODE "helm" (default) -> "Helm Events"; "studio" ->
//                                     the studio's sender name (0150) or "<Studio> via Helm".
//   RESEND_API_KEY, RESEND_FROM       fallback transport, used only when SMTP is not set; the display
//                                     name comes from the studio's Integrations page (0150).
//   Neither set -> e-mail rows are marked "skipped". Reply-To = the studio's reply-to (0150), both.
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
import { trialReminderEmail, trialRetentionEmail, RETENTION_NOTICE_KINDS, RETENTION_TX_REASON } from "./trial-reminders.mjs";
import { inviteSiteMessage } from "./invite-site.mjs";
import { trialRowAllowed } from "./trial-row.mjs";   // 0212: free trial = link e-mails only
import { bookletMessage } from "./booklet-link.mjs";
import { quoteExpiryMessage } from "./quote-expiry.mjs";
import { deliveryMessage } from "./delivery-reminder.mjs";   // 0241: delivery / arrival reminders
import { vendorRequestMessage, VENDOR_TX_REASON } from "./vendor-request.mjs";   // 0256: vendor requests + reminders
import { helmNoticeEmail, NOTICE_TX_REASON } from "./helm-notices.mjs";   // 0244: sales requests + "ask my admin"
import { runsheetReminderMessage, enquiryReplyMessage, RUNSHEET_TX_REASON, ENQUIRY_TX_REASON } from "./r24-automation.mjs";   // 0269: run-sheet reminders + enquiry replies
import { fromHeader, replyToOf } from "../integrations-test/logic.mjs";
import { listUnsubHeaders, mktFooter, postalAddress, txFooter, unsubLinks, withFooter } from "../_shared/email-compliance.mjs";
import { brandMode, sendMail, type SmtpSend } from "../_shared/mailer.ts";

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

// 0150: the studio's own sender name / reply-to (Integrations page), when set
export type Identity = { from_name?: string | null; reply_to?: string | null };
// Compliance (docs/ops/EMAIL-COMPLIANCE.md): every e-mail carries a footer; non-transactional
// mail (follow-ups, trial nudges) also carries a visible Unsubscribe link + RFC 8058 headers.
export type Extra = { footer: { text: string; html: string }; headers?: Record<string, string> };
// which e-mail transport this run uses: SMTP when its three secrets are set, else Resend when
// RESEND_API_KEY is set, else none (rows skipped)
export function emailTransport(e: (k: string) => string | undefined = (k) => Deno.env.get(k)): "smtp" | "resend" | null {
  if (e("SMTP_HOST") && e("SMTP_USER") && e("SMTP_PASS")) return "smtp";
  return e("RESEND_API_KEY") ? "resend" : null;
}
// SMTP path through the shared mailer. `extra.footer` is the footer (transactional or marketing
// with Unsubscribe); `extra.headers` the RFC 8058 List-Unsubscribe headers - passed through as is.
// Helm's own mails (trial / retention, studio "Helm") always go out as "Helm Events".
export async function sendEmailSmtp(to: string, subject: string, text: string, studio: string, ident: Identity, extra: Extra,
  opts: { env?: (k: string) => string | undefined; smtp?: SmtpSend } = {}): Promise<Res> {
  const e = opts.env || ((k: string) => Deno.env.get(k));
  const own = studio === "Helm";
  const fromName = !own && brandMode(e) === "studio" ? (String(ident.from_name ?? "").trim() || null) : null;
  const r = await sendMail({ to, subject: subject.slice(0, 150), text, html: `<p>${escHtml(text).replace(/\n/g, "<br>")}</p>`,
    studio: own ? null : studio, fromName, replyTo: replyToOf(ident.reply_to) || null, footer: extra.footer,
    ...(extra.headers && Object.keys(extra.headers).length ? { headers: extra.headers } : {}) },
    { env: e, prefer: "smtp", ...(opts.smtp ? { smtp: opts.smtp } : {}) });
  if (r.status === "sent") return "sent";
  if (r.status === "not_configured") return "skipped";
  console.error("comms-dispatch: email smtp failed");
  return "failed";
}
async function sendEmail(id: string, to: string, subject: string, text: string, studio: string, ident: Identity = {}, extra?: Extra): Promise<Res> {
  const via = emailTransport();
  if (!via || !EMAIL.test(to) || !text || !extra) return "skipped";
  if (via === "smtp") return await sendEmailSmtp(to, subject, text, studio, ident, extra);
  const key = Deno.env.get("RESEND_API_KEY") || "";
  const from = fromHeader(Deno.env.get("RESEND_FROM"), ident.from_name, studio);
  const replyTo = replyToOf(ident.reply_to);
  const body = withFooter({ text, html: `<p>${escHtml(text).replace(/\n/g, "<br>")}</p>` }, extra.footer);
  const headers = extra.headers && Object.keys(extra.headers).length ? { headers: extra.headers } : {};
  try {
    const r = await safeFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json", "Idempotency-Key": "comms-" + id },
      body: JSON.stringify({ from, to: [to], subject: subject.slice(0, 150), html: body.html, text: body.text, ...headers, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    await r.text();
    if (!r.ok) console.error("comms-dispatch: email status", r.status);
    return r.ok ? "sent" : "failed";
  } catch (e) { console.error("comms-dispatch: email error", errTag(e)); return "failed"; }
}

// purposes that are NOT transactional (need consent + unsubscribe); pay_reminder is transactional
export const NON_TRANSACTIONAL = new Set(["follow_up"]);
const env = (k: string) => Deno.env.get(k);
// footer + headers for a non-transactional e-mail, or null (= do not send: opted out, or no token
// because 0165 is not applied yet - fail closed, never send marketing mail without an unsubscribe)
export function marketingExtra(u: any, sender: string, reason: string, app: string, e: (k: string) => string | undefined = env): Extra | null {
  if (!u || u.ok !== true || u.opted_out === true) return null;
  const links = unsubLinks(String(u.token ?? ""), { app, functionsUrl: String(e("SUPABASE_URL") || "").replace(/\/+$/, "") + "/functions/v1" });
  if (!links) return null;
  return { footer: mktFooter(links.page, { app, address: postalAddress(e), sender, reason }),
           headers: listUnsubHeaders(links.oneClick, e("UNSUB_MAILTO")) };
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

// 0155: last STOP check right before a WhatsApp send. "skipped" = the number replied STOP,
// "failed" = could not check (the row is retried later), null = OK to send.
// deno-lint-ignore no-explicit-any
async function waStopped(admin: any, to: string): Promise<Res | null> {
  try {
    const { data, error } = await admin.rpc("wa_recipient_opted_out", { p_phone: to });
    if (error) { console.error("comms-dispatch: stop check failed", errTag(error)); return "failed"; }
    return data === true ? "skipped" : null;
  } catch (e) { console.error("comms-dispatch: stop check error", errTag(e)); return "failed"; }
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
  if (purpose === "invite_site") return inviteSiteMessage(payload, origin);   // 0195: no link / bad row -> "" -> skipped
  if (purpose === "booklet_link") return bookletMessage(payload, origin);     // 0200: same rule
  if (purpose === "quote_expiry") return quoteExpiryMessage(payload, origin); // 0262: same rule
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
      if (!trialRowAllowed(purpose, channel, payload)) res = "skipped";   // 0212: free trial = link e-mails only
      else if (channel === "email" && purpose !== "wa_forward") {
        // 0150: sender name / reply-to of the row's studio (a database without 0150 -> defaults)
        let ident: Identity = {};
        try { const { data } = await admin.rpc("comms_outbox_email_identity", { p_id: id }); if (data && typeof data === "object") ident = data as Identity; } catch (_) { /* defaults */ }
        let extra: Extra | null = { footer: txFooter(purpose === "invite_site" || purpose === "booklet_link" ? "client_link" : "pay_reminder", { app: origin, address: postalAddress(env) }) };
        if (purpose === "quote_expiry") extra = { footer: txFooter("client_link", { app: origin, address: postalAddress(env) }) };   // 0262: a client-link reminder
        if (NON_TRANSACTIONAL.has(purpose)) {
          let u: any = null;
          try { const { data } = await admin.rpc("comms_outbox_unsub", { p_id: id }); u = data; } catch (_) { u = null; }
          extra = marketingExtra(u, String(payload.studio ?? "") || "your event planner", "you asked " + (String(payload.studio ?? "") || "this planner") + " about an event", origin);
        }
        res = extra ? await sendEmail(id, to, msg.subject, msg.text, String(payload.studio ?? ""), ident, extra) : "skipped";
      }
      else if (channel === "whatsapp") res = (await waStopped(admin, to)) ?? await sendWhatsApp(to, msg.text, purpose === "wa_forward" && String(payload.type ?? "") === "event_reminder" ? "event_reminder" : "general");
      const { error: mErr } = await admin.rpc("comms_outbox_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { console.error("comms-dispatch: mark failed", errTag(mErr)); counts.failed++; continue; }
      counts[res]++;
    }
    // 0184: retention settings once per run, so the day 5 / 7 / 8 copy can say how long data is kept
    // (a database without 0184, or the switch off -> null / off -> the original "nothing is deleted" copy)
    let retention: { delete_enabled?: boolean; retention_days?: number } | null = null;
    try { const { data, error } = await admin.rpc("trial_retention_mail_settings"); if (!error && data && typeof data === "object") retention = data; } catch (_) { retention = null; }
    // 0120: free-trial reminder e-mails (a database without 0120 just has nothing to claim)
    const { data: trows, error: tErr } = await admin.rpc("trial_reminder_email_claim", { p_limit: batch });
    if (tErr) console.error("comms-dispatch: trial claim skipped", errTag(tErr));
    for (const r of (Array.isArray(trows) ? trows : [])) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const msg = trialReminderEmail(String(r?.milestone ?? ""), String(r?.studio ?? ""), String(r?.ends_at ?? ""), String(r?.timezone ?? ""), origin, retention);
      // trial nudges are Helm's own non-transactional mail: unsubscribe is per address for Helm (org null)
      let u: any = null;
      if (msg) {
        try {
          const [o, t] = await Promise.all([admin.rpc("email_is_opted_out", { p_org: null, p_email: to }), admin.rpc("email_unsub_token", { p_org: null, p_email: to })]);
          if (!o.error && !t.error) u = { ok: true, opted_out: o.data === true, token: t.data };
        } catch (_) { u = null; }
      }
      const extra = msg ? marketingExtra(u, "Helm", "you started a free trial of Helm", origin) : null;
      const res: Res = msg && extra ? await sendEmail(id, to, msg.subject, msg.text, "Helm", {}, extra) : "skipped";
      const { error: mErr } = await admin.rpc("trial_reminder_email_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { console.error("comms-dispatch: trial mark failed", errTag(mErr)); counts.failed++; continue; }
      counts[res]++;
    }
    // 0184: post-trial mails to the studio owner (a database without 0184 just has nothing to claim).
    // Deletion warnings are service notices (transactional footer); the +7 reminder is a nudge (Helm unsubscribe).
    const { data: rrows, error: rErr } = await admin.rpc("trial_retention_email_claim", { p_limit: batch });
    if (rErr) console.error("comms-dispatch: retention claim skipped", errTag(rErr));
    for (const r of (Array.isArray(rrows) ? rrows : [])) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? ""), kind = String(r?.kind ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const msg = trialRetentionEmail(kind, String(r?.studio ?? ""), { deleteOn: String(r?.delete_on ?? ""), expiredAt: String(r?.expired_at ?? ""),
        timeZone: String(r?.timezone ?? ""), retentionDays: Number(r?.retention_days) }, origin);
      let extra: Extra | null = null;
      if (msg && RETENTION_NOTICE_KINDS.includes(kind)) extra = { footer: txFooter(RETENTION_TX_REASON, { app: origin, address: postalAddress(env) }) };
      else if (msg) {
        let u: any = null;
        try {
          const [o, t] = await Promise.all([admin.rpc("email_is_opted_out", { p_org: null, p_email: to }), admin.rpc("email_unsub_token", { p_org: null, p_email: to })]);
          if (!o.error && !t.error) u = { ok: true, opted_out: o.data === true, token: t.data };
        } catch (_) { u = null; }
        extra = marketingExtra(u, "Helm", "you started a free trial of Helm", origin);
      }
      const res: Res = msg && extra ? await sendEmail(id, to, msg.subject, msg.text, "Helm", {}, extra) : "skipped";
      const { error: mErr } = await admin.rpc("trial_retention_email_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { console.error("comms-dispatch: retention mark failed", errTag(mErr)); counts.failed++; continue; }
      counts[res]++;
    }
    // 0132: "you've been assigned ..." WhatsApp to staff (a database without 0132 has nothing to claim)
    const { data: arows, error: aErr } = await admin.rpc("assign_notify_claim", { p_limit: batch });
    if (aErr) console.error("comms-dispatch: assign claim skipped", errTag(aErr));
    for (const r of (Array.isArray(arows) ? arows : [])) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const text = assignMessage(String(r?.text ?? ""), String(r?.link_path ?? ""), origin);
      const res: Res = text ? ((await waStopped(admin, to)) ?? await sendWhatsApp(to, text, "task_assigned")) : "skipped";
      const { error: mErr } = await admin.rpc("assign_notify_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { console.error("comms-dispatch: assign mark failed", errTag(mErr)); counts.failed++; continue; }
      counts[res]++;
    }
    // 0241: delivery / arrival reminders (a database without 0241 just has nothing to claim). E-mail only.
    const { data: drows, error: dErr } = await admin.rpc("delivery_reminder_claim", { p_limit: batch });
    if (dErr) console.error("comms-dispatch: delivery claim skipped", errTag(dErr));
    for (const r of (Array.isArray(drows) ? drows : [])) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const msg = deliveryMessage(r, origin);
      const ident: Identity = (r?.identity && typeof r.identity === "object") ? r.identity as Identity : {};
      const extra: Extra = { footer: txFooter("delivery", { app: origin, address: postalAddress(env) }) };
      const res: Res = msg.text ? await sendEmail(id, to, msg.subject, msg.text, String(r?.studio ?? ""), ident, extra) : "skipped";
      const { error: mErr } = await admin.rpc("delivery_reminder_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { console.error("comms-dispatch: delivery mark failed", errTag(mErr)); counts.failed++; continue; }
      counts[res]++;
    }
    // 0256: vendor requests + "still waiting" reminders (e-mail lane only; WhatsApp rows stay queued for a future
    // lane; a database without 0256 just has nothing to claim). The claim re-checks each row and mints a fresh link.
    const { data: vrows, error: vErr } = await admin.rpc("vendor_request_claim", { p_limit: batch, p_channel: "email" });
    if (vErr) console.error("comms-dispatch: vendor request claim skipped", errTag(vErr));
    for (const r of (Array.isArray(vrows) ? vrows : [])) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const msg = vendorRequestMessage(r, origin);
      const ident: Identity = (r?.identity && typeof r.identity === "object") ? r.identity as Identity : {};
      const extra: Extra = { footer: txFooter(VENDOR_TX_REASON, { app: origin, address: postalAddress(env) }) };
      const res: Res = msg.text ? await sendEmail(id, to, msg.subject, msg.text, String(r?.studio ?? ""), ident, extra) : "skipped";
      const { error: mErr } = await admin.rpc("vendor_request_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { console.error("comms-dispatch: vendor request mark failed", errTag(mErr)); counts.failed++; continue; }
      counts[res]++;
    }
    // 0269: run-sheet reminders (e-mail lane; a database without 0269 just has nothing to claim)
    const { data: rsrows, error: rsErr } = await admin.rpc("runsheet_reminder_claim", { p_limit: batch });
    if (rsErr) console.error("comms-dispatch: run-sheet claim skipped", errTag(rsErr));
    for (const r of (Array.isArray(rsrows) ? rsrows : [])) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const msg = runsheetReminderMessage(r, origin);
      const ident: Identity = (r?.identity && typeof r.identity === "object") ? r.identity as Identity : {};
      const extra: Extra = { footer: txFooter(RUNSHEET_TX_REASON, { app: origin, address: postalAddress(env) }) };
      const res: Res = msg.text && EMAIL.test(to) ? await sendEmail(id, to, msg.subject, msg.text, String(r?.studio ?? ""), ident, extra) : "skipped";
      const { error: mErr } = await admin.rpc("runsheet_reminder_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { console.error("comms-dispatch: run-sheet mark failed", errTag(mErr)); counts.failed++; continue; }
      counts[res]++;
    }
    // 0269: instant replies to the public enquiry form (a database without 0269 has nothing to claim)
    const { data: eqrows, error: eqErr } = await admin.rpc("enquiry_reply_claim", { p_limit: batch });
    if (eqErr) console.error("comms-dispatch: enquiry reply claim skipped", errTag(eqErr));
    for (const r of (Array.isArray(eqrows) ? eqrows : [])) {
      const id = String(r?.id ?? ""), to = String(r?.to ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const msg = enquiryReplyMessage(r);
      const ident: Identity = (r?.identity && typeof r.identity === "object") ? r.identity as Identity : {};
      const extra: Extra = { footer: txFooter(ENQUIRY_TX_REASON, { app: origin, address: postalAddress(env) }) };
      const res: Res = msg.text && EMAIL.test(to) ? await sendEmail(id, to, msg.subject, msg.text, String(r?.studio ?? ""), ident, extra) : "skipped";
      const { error: mErr } = await admin.rpc("enquiry_reply_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { console.error("comms-dispatch: enquiry reply mark failed", errTag(mErr)); counts.failed++; continue; }
      counts[res]++;
    }
    // 0244: Helm's own notices - a plan request to sales@helm.events, "Ask my admin to upgrade" to the studio's
    // admins (recipients resolved by the claim, never from the row; a database without 0244 has nothing to claim)
    const { data: hrows, error: hErr } = await admin.rpc("helm_notice_outbox_claim", { p_limit: batch });
    if (hErr) console.error("comms-dispatch: notice claim skipped", errTag(hErr));
    for (const r of (Array.isArray(hrows) ? hrows : [])) {
      const id = String(r?.id ?? ""), kind = String(r?.kind ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const data = (r?.data && typeof r.data === "object") ? r.data : {};
      const msg = helmNoticeEmail(kind, data, origin);
      const tos = (Array.isArray(r?.to) ? r.to : []).map((x: unknown) => String(x ?? "")).filter((x: string) => EMAIL.test(x)).slice(0, 20);
      let res: Res = "skipped";
      if (msg && tos.length) {
        const extra: Extra = { footer: txFooter((NOTICE_TX_REASON as Record<string, string>)[kind] || "you use Helm", { app: origin, address: postalAddress(env) }) };
        // a sales request: replying goes straight to the studio that asked
        const ident: Identity = kind === "sales_request" ? { reply_to: String(data.email ?? "") || null } : {};
        const outs: Res[] = [];
        for (let i = 0; i < tos.length; i++) outs.push(await sendEmail(id + "-" + i, tos[i], msg.subject, msg.text, "Helm", ident, extra));
        res = outs.includes("sent") ? "sent" : outs.includes("failed") ? "failed" : "skipped";
      }
      const { error: mErr } = await admin.rpc("helm_notice_outbox_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { console.error("comms-dispatch: notice mark failed", errTag(mErr)); counts.failed++; continue; }
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
