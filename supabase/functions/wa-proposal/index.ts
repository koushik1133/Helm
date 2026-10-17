// wa-proposal - "Send on WhatsApp" from the studio's proposal share area (0151).
// Model 1: ONE Helm Events WhatsApp number (Meta Cloud API). SIMULATED until the owner sets
// WHATSAPP_TOKEN + WHATSAPP_PHONE_ID: the request is checked and logged exactly the same way,
// nothing is sent, and the answer says { simulated: true }.
//
// Secrets / env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (injected),
//   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_API_VERSION (default v21.0), WHATSAPP_TPL_LANG (default en)
//
// Request (signed-in staff JWT): { quote_id, kind, phone, opt_in, consent_text }
//   kind: proposal_sent | proposal_reminder | proposal_approved_pay | payment_received
// WHO may send WHAT to WHOM is decided in the database as the CALLER (wa_proposal_prepare):
// quotes EDIT, own studio, the number must be the client number ON THE QUOTE, opt-in on
// record, not opted out (STOP), per-studio hourly cap. The service role is used ONLY to record
// the send result (wa_proposal_mark). Logs never carry a number, name or message text.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { bearer, errTag, responders, UUID_RE } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";
import { isLive, KINDS, templateMessage } from "./logic.mjs";

const VER = Deno.env.get("WHATSAPP_API_VERSION") || "v21.0";
const LANG = Deno.env.get("WHATSAPP_TPL_LANG") || "en";

function prepFailure(code: string): [number, string] {
  if (code === "HL429") return [429, "WhatsApp limit reached for your studio - try again later"];
  if (code === "22023") return [400, "check the client mobile number on the quote"];
  if (code === "P0001") return [409, "tick the opt-in box and create the approval link first"];
  return [403, "you can't send WhatsApp messages for this event"];
}

Deno.serve(async (req) => {
  const { cors, json, serverError } = responders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const ipWait = await checkLimits([["wap:ip:" + clientIp(req), 30, 60_000]]);
    if (ipWait) return tooMany(json, ipWait);
    const body: any = await readJsonCapped(req);
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const jwt = bearer(req);
    if (!jwt || !anonKey || jwt === anonKey) return json({ error: "sign in as a staff user" }, 401);
    const asCaller = createClient(url, anonKey, {
      global: { headers: { Authorization: "Bearer " + jwt } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user } } = await asCaller.auth.getUser(jwt);
    if (!user) return json({ error: "sign in as a staff user" }, 401);
    const userWait = await checkLimits([["wap:user:" + user.id, 20, 60_000]]);
    if (userWait) return tooMany(json, userWait);

    const quoteId = String(body.quote_id || "");
    const kind = String(body.kind || "proposal_sent");
    if (!UUID_RE.test(quoteId)) return json({ error: "quote_id is required" }, 400);
    if (!KINDS.includes(kind)) return json({ error: "unknown message" }, 400);
    const live = isLive({ WHATSAPP_TOKEN: Deno.env.get("WHATSAPP_TOKEN"), WHATSAPP_PHONE_ID: Deno.env.get("WHATSAPP_PHONE_ID") });

    const { data: prep, error: pErr } = await asCaller.rpc("wa_proposal_prepare", {
      p_quote: quoteId, p_kind: kind, p_phone: String(body.phone || "").slice(0, 32),
      p_opt_in: body.opt_in === true, p_consent_text: body.opt_in === true ? String(body.consent_text || "").slice(0, 500) : null,
      p_simulate: !live,
    });
    if (pErr || !prep || !prep.audit_id) {
      const [status, msg] = prepFailure(String(pErr?.code || ""));
      return json({ error: msg }, status);
    }
    if (!live) { console.log("wa-proposal: simulated", kind); return json({ simulated: true, status: "simulated" }); }

    let msg: unknown;
    try { msg = templateMessage(prep.to, kind, prep.vars, prep.token, LANG); }
    catch (_) { return json({ error: "could not build the message" }, 400); }
    const r = await fetch(`https://graph.facebook.com/${VER}/${encodeURIComponent(Deno.env.get("WHATSAPP_PHONE_ID")!)}/messages`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + Deno.env.get("WHATSAPP_TOKEN"), "Content-Type": "application/json" },
      body: JSON.stringify(msg),
    });
    const out = await r.text();
    let wamid: string | null = null;
    try { wamid = JSON.parse(out)?.messages?.[0]?.id ?? null; } catch (_) { /* keep null */ }
    if (!r.ok) console.error("wa-proposal: meta status", r.status);
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { error: mErr } = await admin.rpc("wa_proposal_mark", { p_audit_id: prep.audit_id, p_status: r.ok ? "sent" : "failed", p_wamid: wamid });
    if (mErr) console.error("wa-proposal: mark failed", errTag(mErr));
    const { error: lErr } = await admin.from("notifications").insert({
      quote_id: quoteId, channel: "whatsapp", recipient: String(prep.to), kind, status: r.ok ? "sent" : "failed",
    });
    if (lErr) console.error("wa-proposal: log failed", errTag(lErr));
    if (!r.ok) return json({ error: "whatsapp send failed", status: "failed" }, 502);
    return json({ sent: true, status: "sent", id: wamid });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    return serverError(e);
  }
});
