// pkg-client-notify - delivers the messages queued by migration 0069 (pkg_outbox):
// client e-mail (Resend) / WhatsApp (Meta Cloud API) for an accepted or declined package
// choice and the booklet confirmation code, and staff WhatsApp for "client picked a
// package" / "package payment received".
// DORMANT BY DEFAULT: unless HELM_PKG_NOTIFY_ENABLED === "true" every request is a no-op 200.
// Invoked ONLY by a cron / service caller presenting a shared secret.
//
// Secrets / env:
//   HELM_PKG_NOTIFY_ENABLED="true"    turn it on (anything else -> dormant no-op)
//   HELM_PKG_NOTIFY_SECRET            shared secret in the `x-helm-cron-secret` header; unset -> 401
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected)
//   RESEND_API_KEY, RESEND_FROM       unset key -> e-mail rows are marked "skipped"
//   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_API_VERSION (default v21.0)
//   PKG_WHATSAPP_TEMPLATE             approved template name (one body parameter = the text);
//                                     unset -> free text only when WHATSAPP_ALLOW_TEXT=1, else skipped
//   PKG_NOTIFY_BATCH                  rows per run, 1..100 (default 25)
//
// Idempotent: the database hands each row out once (claim + mark, unique dedupe key) and
// the row id is sent as the provider idempotency key. Logs carry only counts and status
// codes - never an address, a phone number, a name or a code. Outbound HTTP goes only to a
// FIXED host allowlist; no URL is ever taken from the database except the approval path,
// which must match /approve?token=<uuid> and is joined to the fixed site origin.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { errTag } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readBodyCapped } from "../_shared/limits.ts";
import { render } from "./templates.ts";

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

async function sendEmail(id: string, to: string, subject: string, html: string, text: string): Promise<Res> {
  const key = Deno.env.get("RESEND_API_KEY") || "";
  if (!key || !EMAIL.test(to) || !html) return "skipped";
  const conf = Deno.env.get("RESEND_FROM") || "onboarding@resend.dev";
  const m = conf.match(/<([^>]+)>/);
  const from = `"Helm" <${(m ? m[1] : conf).trim()}>`;
  try {
    const r = await safeFetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json", "Idempotency-Key": "pkg-" + id },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
    await r.text();
    if (!r.ok) console.error("pkg-client-notify: email status", r.status);
    return r.ok ? "sent" : "failed";
  } catch (e) { console.error("pkg-client-notify: email error", errTag(e)); return "failed"; }
}

async function sendWhatsApp(to: string, text: string): Promise<Res> {
  const token = Deno.env.get("WHATSAPP_TOKEN") || "", phoneId = Deno.env.get("WHATSAPP_PHONE_ID") || "";
  if (!token || !/^[0-9]{5,20}$/.test(phoneId) || !PHONE.test(to) || !text) return "skipped";
  const ver = /^v[0-9]{1,2}\.[0-9]$/.test(Deno.env.get("WHATSAPP_API_VERSION") || "") ? Deno.env.get("WHATSAPP_API_VERSION")! : "v21.0";
  const tpl = (Deno.env.get("PKG_WHATSAPP_TEMPLATE") || "").trim();
  let content: Record<string, unknown>;
  if (/^[a-z0-9_]{1,64}$/.test(tpl)) {
    content = { type: "template", template: { name: tpl, language: { code: "en" }, components: [{ type: "body", parameters: [{ type: "text", text: text.slice(0, 1000) }] }] } };
  } else if (Deno.env.get("WHATSAPP_ALLOW_TEXT") === "1") {
    content = { type: "text", text: { body: text.slice(0, 1000) } };
  } else return "skipped";
  try {
    const r = await safeFetch(`https://graph.facebook.com/${ver}/${encodeURIComponent(phoneId)}/messages`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, ...content }),
    });
    await r.text();
    if (!r.ok) console.error("pkg-client-notify: whatsapp status", r.status);
    return r.ok ? "sent" : "failed";
  } catch (e) { console.error("pkg-client-notify: whatsapp error", errTag(e)); return "failed"; }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  try {
    if (Deno.env.get("HELM_PKG_NOTIFY_ENABLED") !== "true") return json({ status: "dormant" });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const wait = await checkLimits([["pkgnotify:ip:" + clientIp(req), 30, 60_000]]);
    if (wait) return new Response(JSON.stringify({ error: "too many requests" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(wait) } });
    await readBodyCapped(req);
    const ok = await secretMatches(req.headers.get("x-helm-cron-secret") || "", Deno.env.get("HELM_PKG_NOTIFY_SECRET") || "");
    if (!ok) return json({ error: "unauthorized" }, 401);

    const batch = Math.min(100, Math.max(1, Number(Deno.env.get("PKG_NOTIFY_BATCH")) || 25));
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: rows, error } = await admin.rpc("pkg_outbox_claim", { p_limit: batch });
    if (error) { console.error("pkg-client-notify: claim failed", errTag(error)); return json({ error: "internal error" }, 500); }

    const counts = { sent: 0, skipped: 0, failed: 0, invalid: 0 };
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const id = String(r?.id ?? "");
      if (!UUIDISH.test(id)) { counts.invalid++; continue; }
      const kind = String(r?.kind ?? ""), channel = String(r?.channel ?? ""), to = String(r?.to ?? "");
      const msg = render(kind, (r?.payload && typeof r.payload === "object") ? r.payload : {});
      let res: Res = "skipped";
      if (msg && channel === "email" && r?.audience === "client") res = await sendEmail(id, to, msg.subject, msg.html, msg.text);
      else if (msg && channel === "whatsapp") res = await sendWhatsApp(to, msg.text);
      const { error: mErr } = await admin.rpc("pkg_outbox_mark", { p_id: id, p_status: res === "failed" ? "retry" : res });
      if (mErr) { console.error("pkg-client-notify: mark failed", errTag(mErr)); counts.failed++; continue; }
      counts[res]++;
    }
    console.log("pkg-client-notify: run", JSON.stringify(counts));
    return json({ status: "ok", ...counts });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    console.error("pkg-client-notify error", errTag(e));
    return json({ error: "internal error" }, 500);
  }
});
