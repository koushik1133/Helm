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
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { errTag, responders } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";

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
    const { token, phone } = await readJsonCapped(req) as { token?: unknown; phone?: unknown };
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

    // CSPRNG (Math.random is predictable); rejection sampling avoids modulo bias
    const buf = new Uint32Array(1), lim = 4294967296 - (4294967296 % 900000);
    do crypto.getRandomValues(buf); while (buf[0] >= lim);
    const code = String(100000 + (buf[0] % 900000));

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
