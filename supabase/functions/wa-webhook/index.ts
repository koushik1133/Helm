// wa-webhook — Meta WhatsApp Cloud API inbound webhook (0117). DORMANT: answers 404 to
// everything until BOTH secrets below are set. Deploy with --no-verify-jwt (Meta calls it).
//
// Secrets / env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   WHATSAPP_WEBHOOK_VERIFY_TOKEN   — the "Verify token" typed in Meta app -> WhatsApp -> Configuration
//   WHATSAPP_APP_SECRET             — Meta app secret; signs every POST (X-Hub-Signature-256)
//
// GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…  -> echoes the challenge
//      only when the token matches (constant-time).
// POST verifies X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body) BEFORE
//      parsing, then records (idempotently, unique per provider event id):
//        * statuses[]  sent / delivered / read / failed           -> wa_record_event
//        * messages[]  text "STOP"/"UNSUBSCRIBE" -> opt-out, "START" -> opt back in
//                      (wa_set_opt_out); message bodies are NEVER stored
//        * message_template_status_update / phone_number_quality_update -> wa_record_event
//      Always 200 after a valid signature (Meta retries non-2xx for days); DB errors -> 500.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { errTag } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readBodyCapped, WEBHOOK_BODY_LIMIT } from "../_shared/limits.ts";

const enc = new TextEncoder();
async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const STOP = /^\s*(stop|unsubscribe|stop all|opt out|optout|cancel)\s*[.!]?\s*$/i;
const START = /^\s*(start|unstop|subscribe|opt in|optin)\s*[.!]?\s*$/i;
const ID = (v: unknown, re = /^[A-Za-z0-9_.:=+\/-]{1,160}$/) => re.test(String(v ?? "")) ? String(v) : null;

// deno-lint-ignore no-explicit-any
export type Action = { kind: "event"; args: Record<string, unknown> } | { kind: "optout"; args: Record<string, unknown> };
// Pure: Meta payload -> list of RPC calls (exported for tests).
// deno-lint-ignore no-explicit-any
export function planActions(evt: any): Action[] {
  const out: Action[] = [];
  if (evt?.object !== "whatsapp_business_account" || !Array.isArray(evt.entry)) return out;
  for (const entry of evt.entry.slice(0, 50)) {
    for (const ch of (Array.isArray(entry?.changes) ? entry.changes : []).slice(0, 50)) {
      const v = ch?.value || {};
      const field = String(ch?.field || "");
      const phoneId = ID(v.metadata?.phone_number_id, /^[0-9]{5,30}$/);
      if (field === "messages") {
        for (const st of (Array.isArray(v.statuses) ? v.statuses : []).slice(0, 200)) {
          const wamid = ID(st?.id); const status = ID(st?.status, /^[a-z_]{1,30}$/);
          if (!wamid || !status) continue;
          const err = Array.isArray(st.errors) && st.errors[0] ? { error_code: Number(st.errors[0].code) || null } : {};
          out.push({ kind: "event", args: { p_event_id: `status:${wamid}:${status}`, p_phone_number_id: phoneId, p_type: "message_status",
            p_ref: wamid, p_status: status, p_recipient: String(st.recipient_id || ""), p_detail: err } });
        }
        for (const m of (Array.isArray(v.messages) ? v.messages : []).slice(0, 200)) {
          const body = m?.type === "text" ? String(m.text?.body || "") : m?.type === "button" ? String(m.button?.text || m.button?.payload || "") : "";
          const optOut = STOP.test(body) ? true : START.test(body) ? false : null;
          if (optOut === null) continue;            // ordinary replies are not stored
          out.push({ kind: "optout", args: { p_phone_number_id: phoneId, p_phone: String(m.from || ""), p_opted_out: optOut } });
          const mid = ID(m.id);
          if (mid) out.push({ kind: "event", args: { p_event_id: `optout:${mid}`, p_phone_number_id: phoneId, p_type: optOut ? "opt_out" : "opt_in",
            p_ref: mid, p_status: optOut ? "opted_out" : "opted_in", p_recipient: String(m.from || ""), p_detail: {} } });
        }
      } else if (field === "message_template_status_update" || field === "phone_number_quality_update") {
        const ref = ID(v.message_template_name || v.display_phone_number || v.message_template_id) || "unknown";
        const status = ID(v.event || v.current_limit || v.new_quality_score, /^[A-Za-z0-9_]{1,40}$/) || "unknown";
        out.push({ kind: "event", args: { p_event_id: `${field}:${ID(entry?.id) || "x"}:${ref}:${status}:${Number(entry?.time) || 0}`,
          p_phone_number_id: phoneId, p_type: field, p_ref: ref, p_status: status, p_recipient: "", p_detail: {} } });
      }
    }
  }
  return out;
}

Deno.serve(async (req) => {
  try {
    const verifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN") || "";
    const appSecret = Deno.env.get("WHATSAPP_APP_SECRET") || "";
    if (!verifyToken || !appSecret) return new Response("not found", { status: 404 });   // dormant
    const wait = await checkLimits([["wa:ip:" + clientIp(req), 600, 60_000]]);
    if (wait) return new Response("too many requests", { status: 429, headers: { "Retry-After": String(wait) } });

    if (req.method === "GET") {
      const u = new URL(req.url);
      const mode = u.searchParams.get("hub.mode"), tok = u.searchParams.get("hub.verify_token") || "", ch = u.searchParams.get("hub.challenge") || "";
      if (mode === "subscribe" && timingSafeEqual(tok, verifyToken) && /^[A-Za-z0-9_-]{1,200}$/.test(ch)) {
        return new Response(ch, { status: 200, headers: { "Content-Type": "text/plain" } });
      }
      return new Response("forbidden", { status: 403 });
    }
    if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

    const raw = await readBodyCapped(req, WEBHOOK_BODY_LIMIT);
    const sig = req.headers.get("x-hub-signature-256") || "";
    if (!timingSafeEqual("sha256=" + await hmacHex(appSecret, raw), sig)) return new Response("invalid signature", { status: 401 });

    let evt: unknown;
    try { evt = JSON.parse(raw); } catch (_) { return new Response("bad payload", { status: 200 }); }
    const actions = planActions(evt);
    if (!actions.length) return new Response("ignored", { status: 200 });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    for (const a of actions) {
      const { error } = await admin.rpc(a.kind === "optout" ? "wa_set_opt_out" : "wa_record_event", a.args);
      if (error) { console.error("wa-webhook record failed", errTag(error)); return new Response("error", { status: 500 }); }
    }
    return new Response("ok", { status: 200 });
  } catch (e) {
    if (e instanceof BodyTooLarge) return new Response("payload too large", { status: 413 });
    console.error("wa-webhook error", errTag(e));
    return new Response("error", { status: 500 });
  }
});
