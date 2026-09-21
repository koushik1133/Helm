// send-whatsapp — sends a WhatsApp message through a self-hosted Evolution API
// instance, and (optionally) reports the connection state. Called by the app in
// LIVE mode via callFn("send-whatsapp", ...). The Evolution API key lives ONLY
// here as a secret env var — never in the frontend.
//
// Secrets (supabase secrets set ...):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (provided automatically in most setups)
//   EVOLUTION_API_URL       — base URL of your Evolution API, e.g. https://evo.yourdomain.com  (no trailing slash)
//   EVOLUTION_API_KEY       — the Evolution API key (the one from the deploy dialog)
//   EVOLUTION_INSTANCE      — the instance name you created + linked via QR, e.g. "blueprint"
//
// Requests:
//   { "ping": true }                                  -> returns { state } (connection check, no send)
//   { "number": "<phone>", "text": "<message>" }      -> sends a text; returns { sent:true }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cors, json } from "../_shared/cors.ts";

const BASE = (Deno.env.get("EVOLUTION_API_URL") || "").replace(/\/$/, "");
const KEY = Deno.env.get("EVOLUTION_API_KEY") || "";
const INSTANCE = Deno.env.get("EVOLUTION_INSTANCE") || "";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!BASE || !KEY || !INSTANCE) {
      return json({ error: "Evolution API not configured (set EVOLUTION_API_URL / EVOLUTION_API_KEY / EVOLUTION_INSTANCE)" }, 500);
    }
    const headers = { "apikey": KEY, "Content-Type": "application/json" };

    const body = await req.json().catch(() => ({}));

    // ---- connection state check (no message sent) ----
    if (body && body.ping) {
      const r = await fetch(`${BASE}/instance/connectionState/${encodeURIComponent(INSTANCE)}`, { headers });
      const t = await r.text();
      if (!r.ok) return json({ error: "evolution error: " + t.slice(0, 200) }, 502);
      let state = t; try { state = JSON.parse(t); } catch (_) { /* keep raw */ }
      return json({ ok: true, state });
    }

    // ---- send a text message ----
    const number = String(body.number || "").replace(/[^0-9]/g, "");
    const text = String(body.text || "").trim();
    if (number.length < 8) return json({ error: "invalid number" }, 400);
    if (!text) return json({ error: "text is required" }, 400);

    // Evolution API v2 sendText shape. (v1 used { number, textMessage:{ text } } —
    // if your instance is v1, change the body below accordingly.)
    const r = await fetch(`${BASE}/message/sendText/${encodeURIComponent(INSTANCE)}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ number, text }),
    });
    const out = await r.text();
    if (!r.ok) return json({ error: "evolution send failed: " + out.slice(0, 200) }, 502);

    // best-effort log to the notifications outbox (non-fatal if the table/policy differ)
    try {
      const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await admin.from("notifications").insert({ channel: "whatsapp", recipient: number, kind: body.kind || "message", status: "sent" });
    } catch (_) { /* logging is best-effort */ }

    let data = out; try { data = JSON.parse(out); } catch (_) { /* keep raw */ }
    return json({ sent: true, data });
  } catch (e) {
    return json({ error: (e as Error).message || "error" }, 500);
  }
});
