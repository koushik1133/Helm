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
//   * the code is never logged and never returned; errors are generic;
//   * aggregate spend caps (audit run-3 edge/send-phone-code/uncapped-paid-auth-messages),
//     durable across isolates (public.rate_hit), checked before a code is minted:
//       - a confirmed e-mail (or phone) on the account is required (farmed sign-ups that
//         never confirmed cannot send),
//       - Helm-wide per day           PHONE_CODE_GLOBAL_PER_DAY        (default 2000)
//       - per studio per day          PHONE_CODE_ORG_PER_DAY           (default 50)
//       - per destination country/day PHONE_CODE_COUNTRY_PER_DAY       (default 100) for
//         countries outside PHONE_CODE_HOME_CC (default "91,971": India, UAE), which get
//         PHONE_CODE_HOME_COUNTRY_PER_DAY (default 1500),
//       - optional allowlist          PHONE_CODE_ALLOWED_CC="91,971"   (others refused).
//     Also set a spend alert in Meta Business Manager (owner action).
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { bearer, errTag, responders } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";

const DAY_MS = 86_400_000;
// ITU-T E.164 country calling codes: 1 and 7 are one digit; this set is every two-digit
// code; every other code is three digits. Enough to bucket spend by destination country.
const CC2 = new Set(["20", "27", "30", "31", "32", "33", "34", "36", "39", "40", "41", "43", "44", "45", "46", "47", "48", "49",
  "51", "52", "53", "54", "55", "56", "57", "58", "60", "61", "62", "63", "64", "65", "66", "81", "82", "84", "86",
  "90", "91", "92", "93", "94", "95", "98"]);
export function callingCode(e164: string): string {
  const d = String(e164 || "").replace(/^\+/, "");
  if (!/^[1-9][0-9]{6,14}$/.test(d)) return "";
  if (d[0] === "1" || d[0] === "7") return d[0];
  if (CC2.has(d.slice(0, 2))) return d.slice(0, 2);
  return d.slice(0, 3);
}
function envInt(k: string, dflt: number): number {
  const n = Number(Deno.env.get(k) || "");
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : dflt;
}
function ccList(k: string, dflt: string): string[] {
  return (Deno.env.get(k) ?? dflt).split(",").map((x) => x.trim().replace(/^\+/, "")).filter((x) => /^[0-9]{1,3}$/.test(x));
}

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
    // r57 (audit A-10): a sign-in is checked BEFORE saying whether the feature is configured (no config disclosure)
    // and a banned login (0283 deactivation sets banned_until) can't ask for codes with a still-valid token
    const banned = Date.parse(String((user as any).banned_until || ""));
    if (Number.isFinite(banned) && banned > Date.now()) return json({ error: "sign in first" }, 401);
    if (!TOKEN || !PHONE_ID) return json({ error: "phone verification is not available yet" }, 503);
    const userWait = await checkLimits([["pv:user:" + user.id, 5, 60_000]]);
    if (userWait) return tooMany(json, userWait);

    const phone = String((body && body.phone) || "").slice(0, 32);
    if (!/^\+[1-9][0-9]{6,14}$/.test(phone)) return json({ error: "enter a valid mobile number" }, 400);

    // ---- aggregate spend caps (audit run-3) ----
    if (!(user as any).email_confirmed_at && !(user as any).phone_confirmed_at) {
      return json({ error: "confirm your e-mail address first" }, 403);
    }
    const cc = callingCode(phone);
    const allowed = ccList("PHONE_CODE_ALLOWED_CC", "");
    if (!cc || (allowed.length && !allowed.includes(cc))) {
      return json({ error: "WhatsApp verification isn't available for numbers in that country yet" }, 400);
    }
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: prof, error: pErr } = await admin.from("profiles").select("org_id").eq("id", user.id).maybeSingle();
    if (pErr) { console.error("profile lookup failed", errTag(pErr)); return json({ error: "could not send a code — please try again later" }, 500); }
    // r57 (A-10): a member deactivated by their studio (0283 team_member_status) gets no codes either
    if ((prof as any)?.org_id) {
      const { data: tms, error: tErr } = await admin.from("team_member_status").select("status")
        .eq("user_id", user.id).eq("org_id", (prof as any).org_id).maybeSingle();
      if (tErr && !/team_member_status|PGRST205|42P01/i.test(String(tErr.message || "") + " " + String((tErr as any).code || ""))) {
        console.error("member status lookup failed", errTag(tErr)); return json({ error: "could not send a code — please try again later" }, 500);
      }
      if ((tms as any)?.status === "deactivated") return json({ error: "sign in first" }, 401);
    }
    const orgKey = String((prof as any)?.org_id || "none:" + user.id);
    const home = ccList("PHONE_CODE_HOME_CC", "91,971").includes(cc);
    const capWait = await checkLimits([
      ["pv:global:all", envInt("PHONE_CODE_GLOBAL_PER_DAY", 2000), DAY_MS],
      ["pv:cc:" + cc, home ? envInt("PHONE_CODE_HOME_COUNTRY_PER_DAY", 1500) : envInt("PHONE_CODE_COUNTRY_PER_DAY", 100), DAY_MS],
      ["pv:org:" + orgKey, envInt("PHONE_CODE_ORG_PER_DAY", 50), DAY_MS],
    ]);
    if (capWait) {
      const r = json({ error: "too many codes requested — try again later", retry_after: capWait }, 429);
      r.headers.set("Retry-After", String(capWait));
      return r;
    }

    const { data: issued, error: iErr } = await admin.rpc("phone_verify_request", { p_user: user.id, p_phone: phone });
    if (iErr || !issued || !issued.code) {
      const [status, msg, retry] = requestFailure(String(iErr?.code || ""), String(iErr?.message || ""));
      return json(retry ? { error: msg, retry_after: retry } : { error: msg }, status);
    }
    const to = String(issued.phone).replace(/^\+/, "");
    // Meta AUTHENTICATION template: the code goes in the body AND the copy-code button.
    const r = await fetch(`${GRAPH}/${VER}/${encodeURIComponent(PHONE_ID)}/messages`, { redirect: "error",
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
