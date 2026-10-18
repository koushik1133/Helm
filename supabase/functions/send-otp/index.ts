// send-otp — generates a 6-digit OTP, stores its bcrypt hash (via admin_store_otp),
// and sends it to the client's phone through MSG91. Called by the approval page in LIVE mode.
//
// Secrets (supabase secrets set ...):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (provided automatically in most setups)
//   MSG91_AUTHKEY          — your MSG91 auth key
//   MSG91_SENDER           — 6-char DLT sender id (e.g. "HELMEV")
//   MSG91_OTP_TEMPLATE_ID  — DLT-approved template id containing ##OTP##
//
// Audit Phase 8: the SMS goes only to the client phone ON FILE for the quote when one
// exists (formats like +91 / 0 / spaces are normalized); with no phone on file, only an
// Indian mobile (+91, 10 digits starting 6-9) is accepted. Each studio has a daily SMS
// cap (public.otp_send_authorize, 0027). DB errors are mapped to generic messages.
//
// 0151: { token, channel: "whatsapp" | "email" } sends the code by the WhatsApp AUTHENTICATION
// template proposal_approval_otp (copy-code) or by e-mail (Resend) - ALWAYS to the phone /
// e-mail ON THE QUOTE (wa_otp_begin; a typed number is ignored), 30 s cooldown, 3 resends.
// Simulated (nothing sent) while WHATSAPP_TOKEN+WHATSAPP_PHONE_ID / RESEND_API_KEY are unset.
// Extra env: WHATSAPP_API_VERSION, WHATSAPP_TPL_LANG, RESEND_API_KEY, RESEND_FROM.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { errTag, responders } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";
import { isLive, otpEmail, otpMessage } from "../wa-proposal/logic.mjs";

function newCode(): string {
  // CSPRNG (Math.random is predictable); rejection sampling avoids modulo bias
  const buf = new Uint32Array(1), lim = 4294967296 - (4294967296 % 900000);
  do crypto.getRandomValues(buf); while (buf[0] >= lim);
  return String(100000 + (buf[0] % 900000));
}

// 0151: WhatsApp / e-mail code to the recipient ON THE QUOTE
// deno-lint-ignore no-explicit-any
async function sendByChannel(req: Request, json: any, admin: any, token: string, channel: "whatsapp" | "email") {
  const ua = String(req.headers.get("user-agent") || "").slice(0, 400);
  const { data: dest, error: bErr } = await admin.rpc("wa_otp_begin", { p_token: token, p_channel: channel, p_user_agent: ua });
  if (bErr || !dest || !dest.phone_key) {
    const [status, msg] = otpFailure(String(bErr?.code || ""));
    return json({ error: msg }, status);
  }
  const { error: aErr } = await admin.rpc("otp_send_authorize", { p_token: token, p_phone: dest.phone_key });
  if (aErr) { const [status, msg] = otpFailure(String(aErr.code || "")); return json({ error: msg }, status); }
  const code = newCode();
  const storeArgs = { p_token: token, p_phone: dest.phone_key, p_code: code };
  const { error } = await admin.rpc("admin_store_otp", storeArgs);
  if (error) { console.error("admin_store_otp failed", errTag(error)); return json({ error: "too many requests — please try again later" }, 429); }
  let live = false;
  if (channel === "whatsapp") {
    live = isLive({ WHATSAPP_TOKEN: Deno.env.get("WHATSAPP_TOKEN"), WHATSAPP_PHONE_ID: Deno.env.get("WHATSAPP_PHONE_ID") });
    if (live) {
      const r = await fetch(`https://graph.facebook.com/${Deno.env.get("WHATSAPP_API_VERSION") || "v21.0"}/${encodeURIComponent(Deno.env.get("WHATSAPP_PHONE_ID")!)}/messages`, {
        method: "POST", headers: { "Authorization": "Bearer " + Deno.env.get("WHATSAPP_TOKEN"), "Content-Type": "application/json" },
        body: JSON.stringify(otpMessage(String(dest.to), code, Deno.env.get("WHATSAPP_TPL_LANG") || "en")),
      });
      await r.text();
      if (!r.ok) { console.error("whatsapp otp status", r.status); return json({ error: "WhatsApp message could not be sent", fallback: "email" }, 502); }
    }
  } else {
    const key = Deno.env.get("RESEND_API_KEY") || "", from = Deno.env.get("RESEND_FROM") || "";
    live = !!(key && from);
    if (live) {
      const m = otpEmail(code, "your planner");
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST", headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [String(dest.email)], subject: m.subject, html: m.html, text: m.text }),
      });
      await r.text();
      if (!r.ok) { console.error("email otp status", r.status); return json({ error: "e-mail could not be sent" }, 502); }
    }
  }
  const { error: logErr } = await admin.from("notifications").insert({
    quote_id: dest.quote_id, channel: channel === "email" ? "email" : "whatsapp",
    recipient: channel === "email" ? String(dest.email) : String(dest.to), kind: "otp", status: live ? "sent" : "simulated",
  });
  if (logErr) console.error("otp log insert failed", errTag(logErr));
  return json({ sent: true, live, simulated: !live, channel, masked: dest.masked, resends_left: dest.resends_left });
}

// DB error → [http status, generic message] (never error.message)
function otpFailure(code: string): [number, string] {
  switch (code) {
    case "HL404": return [404, "invalid link"];
    case "HL403": return [400, "use the mobile number your event manager has on file"];
    case "HL400": return [400, "enter a valid Indian mobile number"];
    case "HL429": return [429, "too many requests — please try again later"];
    default: return [400, "could not send the SMS — please try again later"];
  }
}

Deno.serve(async (req) => {
  const { cors, json, serverError } = responders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const ipWait = await checkLimits([["otp:ip:" + clientIp(req), 10, 60_000]]);
    if (ipWait) return tooMany(json, ipWait);
    const { token, phone, channel } = await readJsonCapped(req) as { token?: unknown; phone?: unknown; channel?: unknown };
    if ((channel === "whatsapp" || channel === "email") && typeof token === "string") {
      const tWait = await checkLimits([["otp:tok:" + token.toLowerCase(), 5, 60_000]]);
      if (tWait) return tooMany(json, tWait);
      if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ error: "invalid link" }, 404);
      const admin0 = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
      return await sendByChannel(req, json, admin0, token, channel);
    }
    if (!token || !phone || typeof token !== "string" || typeof phone !== "string") {
      return json({ error: "token and phone are required" }, 400);
    }
    const idWait = await checkLimits([["otp:tok:" + token.toLowerCase(), 5, 60_000]]);
    if (idWait) return tooMany(json, idWait);
    if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ error: "invalid link" }, 404);
    if (phone.replace(/[^0-9]/g, "").length < 8 || phone.length > 32) return json({ error: "invalid phone" }, 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    // who may receive it + per-studio daily cap (server-side)
    const { data: dest, error: aErr } = await admin.rpc("otp_send_authorize", { p_token: token, p_phone: phone });
    if (aErr || !dest || !dest.mobile) {
      const [status, msg] = otpFailure(String(aErr?.code || ""));
      return json({ error: msg }, status);
    }

    // 0093: the MSG91 DLT OTP template only reaches Indian (+91) numbers. Numbers outside India
    // (UAE +971, USA +1, ...) need MSG91's international route enabled on the account - set
    // MSG91_INTL=1 once it is; until then say so plainly instead of failing silently.
    if (Deno.env.get("MSG91_AUTHKEY") && !String(dest.mobile).startsWith("91") && Deno.env.get("MSG91_INTL") !== "1") {
      return json({ error: "SMS codes can't be sent to numbers outside India yet — please ask your planner to record your approval." }, 422);
    }

    const code = newCode();

    // store the hash (rate-limits + validates the token inside the DB)
    const { error } = await admin.rpc("admin_store_otp", { p_token: token, p_phone: phone, p_code: code });
    if (error) {
      console.error("admin_store_otp failed", errTag(error));
      const tooMany = /too many/i.test(String(error.message || ""));
      return json({ error: tooMany ? "too many requests — please try again later" : "could not send the SMS — please try again later" }, tooMany ? 429 : 400);
    }

    // send via MSG91 (India). See https://docs.msg91.com/otp
    const authkey = Deno.env.get("MSG91_AUTHKEY");
    if (authkey) {
      const body = {
        template_id: Deno.env.get("MSG91_OTP_TEMPLATE_ID"),
        sender: Deno.env.get("MSG91_SENDER"),
        short_url: "0",
        mobiles: String(dest.mobile),
        OTP: code,
      };
      const r = await fetch("https://control.msg91.com/api/v5/flow/", {
        method: "POST",
        headers: { "authkey": authkey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      await r.text();
      if (!r.ok) {
        console.error("msg91 error", r.status);
        return json({ error: "could not send the SMS, please try again" }, 502);
      }
    }
    // log the notification (quote_id → org_id via the org_from_quote trigger)
    const { error: logErr } = await admin.from("notifications").insert({
      quote_id: dest.quote_id, channel: "sms", recipient: String(dest.mobile), kind: "otp", status: authkey ? "sent" : "simulated",
    });
    if (logErr) console.error("otp log insert failed", errTag(logErr));
    return json({ sent: true, live: !!authkey });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    return serverError(e);
  }
});
