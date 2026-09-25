// send-whatsapp — sends a WhatsApp message through the **Meta WhatsApp Cloud API**
// (graph.facebook.com). Called by the app in LIVE mode via callFn("send-whatsapp", …).
// All Meta credentials live ONLY here as secret env vars — never in the frontend.
//
// Secrets (supabase secrets set …):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (provided automatically in most setups)
//   WHATSAPP_TOKEN            — permanent access token of the Meta system user
//   WHATSAPP_PHONE_ID         — the WhatsApp Business phone number ID (numeric)
//   WHATSAPP_API_VERSION      — optional, defaults to "v21.0"
//
// Requests:
//   { "ping": true }
//        → GET the phone number (credential/connection check, no send)
//   { "number": "<phone>", "text": "<message>" }
//        → session text message (only valid inside the 24h customer-service window)
//   { "number": "<phone>", "template": "<name>", "lang": "en_US",
//     "params": ["v1","v2", …] }
//        → business-initiated TEMPLATE message (required to OPEN a conversation)
//
// NOTE: Meta only allows free-form text within 24h of the customer's last inbound
// message. To start a conversation you MUST use an approved template.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cors, json } from "../_shared/cors.ts";

const TOKEN = Deno.env.get("WHATSAPP_TOKEN") || "";
const PHONE_ID = Deno.env.get("WHATSAPP_PHONE_ID") || "";
const VER = Deno.env.get("WHATSAPP_API_VERSION") || "v21.0";
const GRAPH = "https://graph.facebook.com";

function authHeaders() {
  return { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!TOKEN || !PHONE_ID) {
      return json({ error: "WhatsApp Cloud API not configured (set WHATSAPP_TOKEN / WHATSAPP_PHONE_ID)" }, 500);
    }
    const body = await req.json().catch(() => ({}));

    // ---- credential / connection check (no message sent) ----
    if (body && body.ping) {
      const r = await fetch(`${GRAPH}/${VER}/${encodeURIComponent(PHONE_ID)}?fields=verified_name,display_phone_number,quality_rating`, {
        headers: authHeaders(),
      });
      const t = await r.text();
      if (!r.ok) return json({ error: "meta error: " + t.slice(0, 300) }, 502);
      let state = t; try { state = JSON.parse(t); } catch (_) { /* keep raw */ }
      return json({ ok: true, state });
    }

    // ---- normalise recipient (E.164 digits, no +) ----
    const number = String(body.number || "").replace(/[^0-9]/g, "");
    if (number.length < 8) return json({ error: "invalid number" }, 400);

    // ---- build the message payload: template (business-initiated) or text ----
    let payload: Record<string, unknown>;
    if (body.template) {
      const params = Array.isArray(body.params) ? body.params : [];
      payload = {
        messaging_product: "whatsapp",
        to: number,
        type: "template",
        template: {
          name: String(body.template),
          language: { code: String(body.lang || "en_US") },
          ...(params.length
            ? { components: [{ type: "body", parameters: params.map((p: unknown) => ({ type: "text", text: String(p) })) }] }
            : {}),
        },
      };
    } else {
      const text = String(body.text || "").trim();
      if (!text) return json({ error: "text or template is required" }, 400);
      payload = { messaging_product: "whatsapp", to: number, type: "text", text: { preview_url: false, body: text } };
    }

    const r = await fetch(`${GRAPH}/${VER}/${encodeURIComponent(PHONE_ID)}/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(payload),
    });
    const out = await r.text();
    if (!r.ok) return json({ error: "whatsapp send failed: " + out.slice(0, 300) }, 502);

    // best-effort log to the notifications outbox (non-fatal)
    try {
      const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await admin.from("notifications").insert({
        quote_id: body.quote_id || null, channel: "whatsapp", recipient: number,
        kind: body.kind || (body.template ? "template" : "message"), status: "sent",
      });
    } catch (_) { /* logging is best-effort */ }

    let data = out; try { data = JSON.parse(out); } catch (_) { /* keep raw */ }
    return json({ sent: true, data });
  } catch (e) {
    return json({ error: (e as Error).message || "error" }, 500);
  }
});
