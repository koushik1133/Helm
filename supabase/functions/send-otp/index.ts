// send-otp — generates a 6-digit OTP, stores its bcrypt hash (via admin_store_otp),
// and sends it to the client's phone through MSG91. Called by the approval page in LIVE mode.
//
// Secrets (supabase secrets set ...):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (provided automatically in most setups)
//   MSG91_AUTHKEY          — your MSG91 auth key
//   MSG91_SENDER           — 6-char DLT sender id (e.g. "HELMEV")
//   MSG91_OTP_TEMPLATE_ID  — DLT-approved template id containing ##OTP##
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cors, json } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { token, phone } = await req.json();
    if (!token || !phone) return json({ error: "token and phone are required" }, 400);
    const digits = String(phone).replace(/[^0-9]/g, "");
    if (digits.length < 8) return json({ error: "invalid phone" }, 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const code = String(Math.floor(100000 + Math.random() * 900000));

    // store the hash (rate-limits + validates the token inside the DB)
    const { error } = await admin.rpc("admin_store_otp", { p_token: token, p_phone: phone, p_code: code });
    if (error) return json({ error: error.message }, 400);

    // send via MSG91 (India). See https://docs.msg91.com/otp
    const authkey = Deno.env.get("MSG91_AUTHKEY");
    if (authkey) {
      const body = {
        template_id: Deno.env.get("MSG91_OTP_TEMPLATE_ID"),
        sender: Deno.env.get("MSG91_SENDER"),
        short_url: "0",
        mobiles: digits.length === 10 ? "91" + digits : digits,
        OTP: code,
      };
      const r = await fetch("https://control.msg91.com/api/v5/flow/", {
        method: "POST",
        headers: { "authkey": authkey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) return json({ error: "sms provider error: " + (await r.text()).slice(0, 160) }, 502);
    }
    // log the notification
    await admin.from("notifications").insert({ channel: "sms", recipient: phone, kind: "otp", status: authkey ? "sent" : "simulated" });
    return json({ sent: true, live: !!authkey });
  } catch (e) {
    return json({ error: (e as Error).message || "error" }, 500);
  }
});
