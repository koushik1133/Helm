// send-whatsapp — sends a WhatsApp message through the **Meta WhatsApp Cloud API**
// (graph.facebook.com). Called by the app in LIVE mode via callFn("send-whatsapp", …).
// All Meta credentials live ONLY here as secret env vars — never in the frontend.
//
// Secrets / env (supabase secrets set …):
//   SUPABASE_URL, SUPABASE_ANON_KEY            (provided automatically)
//   SUPABASE_SERVICE_ROLE_KEY                  (provided automatically; used ONLY to log)
//   WHATSAPP_TOKEN            — permanent access token of the Meta system user
//   WHATSAPP_PHONE_ID         — the WhatsApp Business phone number ID (numeric)
//   WHATSAPP_API_VERSION      — optional, defaults to "v21.0"
//   WHATSAPP_TEMPLATES        — comma-separated allowlist of approved template names
//                               (default: the names in DEFAULT_TEMPLATES below)
//   WHATSAPP_ALLOW_TEXT=1     — optional: also allow free-form text (24h session window)
//
// Audit Phase 8 — no open relay on the shared platform number. Every send must:
//   * come from a signed-in user (their JWT, not the anon key),
//   * name the event (quote_id) it is about; the caller's OWN JWT is used (RLS +
//     public.whatsapp_authorize) to prove the event is in their studio, that they have
//     quotes edit rights, that the number belongs to that event (client, crew link,
//     booked vendor) and that the studio is under its hourly WhatsApp limit,
//   * use an allowlisted template (free text only when WHATSAPP_ALLOW_TEXT=1),
//   * be logged to notifications with channel 'whatsapp' (insert error checked).
//
// Requests:
//   { "ping": true }                                     → credential check, no send
//   { "quote_id": "<uuid>", "number": "<phone>", "template": "<name>",
//     "lang": "en_US", "params": ["v1","v2", …], "kind": "<label>" }
//   { "quote_id": "<uuid>", "number": "<phone>", "text": "<message>" }  (if allowed)
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { bearer, errTag, responders, UUID_RE } from "../_shared/cors.ts";

const TOKEN = Deno.env.get("WHATSAPP_TOKEN") || "";
const PHONE_ID = Deno.env.get("WHATSAPP_PHONE_ID") || "";
const VER = Deno.env.get("WHATSAPP_API_VERSION") || "v21.0";
const GRAPH = "https://graph.facebook.com";
const DEFAULT_TEMPLATES = ["event_update", "payment_reminder", "event_reminder", "crew_assignment"];
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const LANG = /^[a-z]{2,3}(_[A-Z]{2})?$/;

function templateAllowlist(): string[] {
  const env = (Deno.env.get("WHATSAPP_TEMPLATES") || "").trim();
  const list = env ? env.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_TEMPLATES;
  return list.filter((n) => TEMPLATE_NAME.test(n));
}

function authHeaders() {
  return { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" };
}

// DB error → [http status, generic message] (never the raw message)
function authzFailure(code: string): [number, string] {
  if (code === "HL429") return [429, "WhatsApp limit reached for your studio — try again later"];
  if (code === "22023") return [400, "invalid number"];
  return [403, "you can't send WhatsApp messages for this event to that number"];
}

Deno.serve(async (req) => {
  const { cors, json, serverError } = responders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    if (!TOKEN || !PHONE_ID) {
      return json({ error: "WhatsApp Cloud API not configured (set WHATSAPP_TOKEN / WHATSAPP_PHONE_ID)" }, 500);
    }
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const jwt = bearer(req);
    if (!jwt || !anonKey || jwt === anonKey) return json({ error: "sign in as a staff user" }, 401);

    // Everything about WHO may send WHAT to WHOM runs as the CALLER (their JWT → RLS).
    const asCaller = createClient(url, anonKey, {
      global: { headers: { Authorization: "Bearer " + jwt } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user } } = await asCaller.auth.getUser(jwt);
    if (!user) return json({ error: "sign in as a staff user" }, 401);

    const body = await req.json().catch(() => ({}));

    // ---- credential / connection check (no message sent) ----
    if (body && body.ping === true) {
      const r = await fetch(`${GRAPH}/${VER}/${encodeURIComponent(PHONE_ID)}?fields=verified_name,display_phone_number,quality_rating`, {
        headers: authHeaders(),
      });
      await r.text();
      if (!r.ok) { console.error("meta ping failed", r.status); return json({ error: "whatsapp connection check failed" }, 502); }
      return json({ ok: true });
    }

    const quoteId = String(body.quote_id || "");
    if (!UUID_RE.test(quoteId)) return json({ error: "quote_id is required" }, 400);

    // ---- message content: allowlisted template, or (opt-in) session text ----
    let content: Record<string, unknown>;
    if (body.template != null) {
      const name = String(body.template);
      if (!templateAllowlist().includes(name)) return json({ error: "template not allowed" }, 400);
      const lang = String(body.lang || "en_US");
      if (!LANG.test(lang)) return json({ error: "invalid language" }, 400);
      const params = Array.isArray(body.params) ? body.params.slice(0, 10) : [];
      content = {
        type: "template",
        template: {
          name,
          language: { code: lang },
          ...(params.length
            ? { components: [{ type: "body", parameters: params.map((p: unknown) => ({ type: "text", text: String(p ?? "").slice(0, 300) })) }] }
            : {}),
        },
      };
    } else {
      if (Deno.env.get("WHATSAPP_ALLOW_TEXT") !== "1") return json({ error: "use an approved template" }, 400);
      const text = String(body.text || "").trim().slice(0, 1000);
      if (!text) return json({ error: "text or template is required" }, 400);
      content = { type: "text", text: { preview_url: false, body: text } };
    }

    // ---- the caller's studio must own the event (RLS) ----
    const { data: q, error: qErr } = await asCaller.from("quotes").select("id").eq("id", quoteId).maybeSingle();
    if (qErr) { console.error("quote lookup failed", errTag(qErr)); return json({ error: "could not check the event" }, 500); }
    if (!q) return json({ error: "you can't send WhatsApp messages for this event to that number" }, 403);

    // ---- area right + number belongs to the event + per-studio rate limit ----
    const { data: ok, error: aErr } = await asCaller.rpc("whatsapp_authorize", { p_quote: quoteId, p_recipient: String(body.number || "") });
    if (aErr || !ok || !ok.to) {
      const [status, msg] = authzFailure(String(aErr?.code || ""));
      return json({ error: msg }, status);
    }
    const to = String(ok.to);

    const r = await fetch(`${GRAPH}/${VER}/${encodeURIComponent(PHONE_ID)}/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ messaging_product: "whatsapp", to, ...content }),
    });
    const out = await r.text();
    const sent = r.ok;
    if (!sent) console.error("whatsapp send failed", r.status);

    // log with the right channel; the service role is used ONLY for this insert
    // (org_id is taken from the quote by the org_from_quote trigger)
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const kind = String(body.kind || (body.template ? "template" : "message")).slice(0, 40);
    const { error: logErr } = await admin.from("notifications").insert({
      quote_id: quoteId, channel: "whatsapp", recipient: to, kind, status: sent ? "sent" : "failed",
    });
    if (logErr) console.error("whatsapp log insert failed", errTag(logErr));

    if (!sent) return json({ error: "whatsapp send failed" }, 502);
    let id: string | null = null;
    try { id = JSON.parse(out)?.messages?.[0]?.id ?? null; } catch (_) { /* keep null */ }
    return json({ sent: true, id });
  } catch (e) {
    return serverError(e);
  }
});
