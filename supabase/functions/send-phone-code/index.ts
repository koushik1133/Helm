// send-phone-code — sends a member their 6-digit phone-verification code on WhatsApp
// (Meta WhatsApp Cloud API, same credentials as send-whatsapp). 0055.
//
// DORMANT until the owner deploys it, sets the secrets below AND flips
// config.liveChannels.whatsapp to true. While dormant the app never calls it and tells the
// member "Phone verification will be available shortly — you can continue".
//
// Secrets / env:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY   (provided automatically)
//   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_API_VERSION      (as send-whatsapp)
//   WHATSAPP_VERIFY_TEMPLATE  — approved AUTHENTICATION template name (default "phone_verification")
//   WHATSAPP_VERIFY_LANG      — its language code (default "en_US")
//
// Safety:
//   * caller must be signed in (their JWT, not the anon key); the code is minted for
//     THAT user only, by public.phone_verify_request (service role only — the browser can
//     never call it, so a code never reaches a page or this function's response);
//   * the DB enforces 60 s between sends, 5 per user per hour, 10 per number per day;
//     this function adds IP / user burst limits;
//   * the code is never logged and never returned; errors are generic.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { bearer, errTag, responders } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";

const TOKEN = Deno.env.get("WHATSAPP_TOKEN") || "";
const PHONE_ID = Deno.env.get("WHATSAPP_PHONE_ID") || "";
const VER = Deno.env.get("WHATSAPP_API_VERSION") || "v21.0";
const TEMPLATE = Deno.env.get("WHATSAPP_VERIFY_TEMPLATE") || "phone_verification";
const LANG = Deno.env.get("WHATSAPP_VERIFY_LANG") || "en_US";
const GRAPH = "https://graph.facebook.com";

function requestFailure(code: string, msg: string): [number, string, number?] {
  if (code === "HL429") {
    const m = /wait (\d+) seconds/.exec(msg || "");
    return [429, m ? "please wait before asking for another code" : "too many codes requested — try again later", m ? Number(m[1]) : undefined];
  }
  if (code === "22023") return [400, "enter a valid mobile number"];
  return [400, "could not send a code — please try again later"];
}

Deno.serve(async (req) => {
  const { cors, json, serverError } = responders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const ipWait = await checkLimits([["pv:ip:" + clientIp(req), 20, 60_000]]);
    if (ipWait) return tooMany(json, ipWait);
    const body: any = await readJsonCapped(req);
    if (!TOKEN || !PHONE_ID) return json({ error: "phone verification is not available yet" }, 503);
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const jwt = bearer(req);
    if (!jwt || !anonKey || jwt === anonKey) return json({ error: "sign in first" }, 401);
    const asCaller = createClient(url, anonKey, {
      global: { headers: { Authorization: "Bearer " + jwt } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user } } = await asCaller.auth.getUser(jwt);
    if (!user) return json({ error: "sign in first" }, 401);
    const userWait = await checkLimits([["pv:user:" + user.id, 5, 60_000]]);
    if (userWait) return tooMany(json, userWait);

    const phone = String((body && body.phone) || "").slice(0, 32);
    if (!/^\+[1-9][0-9]{6,14}$/.test(phone)) return json({ error: "enter a valid mobile number" }, 400);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: issued, error: iErr } = await admin.rpc("phone_verify_request", { p_user: user.id, p_phone: phone });
    if (iErr || !issued || !issued.code) {
      const [status, msg, retry] = requestFailure(String(iErr?.code || ""), String(iErr?.message || ""));
      return json(retry ? { error: msg, retry_after: retry } : { error: msg }, status);
    }
    const to = String(issued.phone).replace(/^\+/, "");
    // Meta AUTHENTICATION template: the code goes in the body AND the copy-code button.
    const r = await fetch(`${GRAPH}/${VER}/${encodeURIComponent(PHONE_ID)}/messages`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to, type: "template",
        template: {
          name: TEMPLATE, language: { code: LANG },
          components: [
            { type: "body", parameters: [{ type: "text", text: String(issued.code) }] },
            { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: String(issued.code) }] },
          ],
        },
      }),
    });
    await r.text();
    if (!r.ok) { console.error("phone code send failed", r.status); return json({ error: "could not send the WhatsApp message — try again later" }, 502); }
    return json({ sent: true, expires_in: Number(issued.expires_in) || 600, resend_after: Number(issued.resend_after) || 60 });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    console.error("send-phone-code error", errTag(e));
    return serverError(e);
  }
});
