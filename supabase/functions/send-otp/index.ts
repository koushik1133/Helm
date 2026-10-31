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
// Extra env: WHATSAPP_API_VERSION, WHATSAPP_TPL_LANG, RESEND_API_KEY, RESEND_FROM,
// or SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM (e-mail via _shared/mailer.ts).
// The OTP value is never logged or stored in plain text (hash only, via admin_store_otp).
//
// 0179: a free-trial studio (studio_subscriptions.status 'trial') sends NO code: checked here with the
// service role (trial_send_blocked) before anything is stored or sent -> 403 { trial: true }; the
// database wrappers refuse it too (42501 / hint trial_no_send). The portal offers Test mode instead.
// 0212 (SUPERSEDED by R113 / 0322 below): in an ACTIVE trial the code BY E-MAIL was sent -
// trial_email_otp_begin (service role) runs the same checks as wa_otp_begin + otp_send_authorize (address on
// the quote, 30 s cooldown, 4 per 30 min, demo, studio daily cap) and takes one trial e-mail slot (30 a day per
// studio, 5 a day per address) -> over the cap 429. SMS and WhatsApp codes stay refused in the trial (403
// { trial: true }); an ended trial / the sample master / a database without 0212: e-mail refused too (403).
//
// R113 (0322, owner decision: trial client approval = DUMMY / TEST MODE): a free-trial studio (active OR ended, or the
// sample master) gets NO approval code on ANY channel - no e-mail, no WhatsApp, no SMS. The 0212 trial e-mail code path
// (trial_email_otp_begin) is no longer called: 403 { trial: true, test_mode: true } before anything is stored or sent.
// The client approval page shows "Test mode" and the client uses the test code 000000 (trial_test_approve_code). The
// database refuses it too (0322: no quote_otps row / no 'otp' e-mail slot for a trial quote). Paid studios: unchanged.
//
// R108 (0318): a quote with no price (total missing or <= 0, public_quote_ready) gets no code -> 409 { not_priced: true }
// with "This quote isn't ready yet - please contact <Studio>."; the database refuses its approval too (0318 trigger).
// A database without 0318: the check is skipped (unchanged behaviour). The e-mail / SMS / WhatsApp sends are unchanged.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { errTag, responders } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";
import { isLive, otpEmail, otpMessage } from "../wa-proposal/logic.mjs";
import { brandMode, sendMail } from "../_shared/mailer.ts";
import { postalAddress } from "../_shared/email-compliance.mjs";
import { studioReplyTo } from "../_shared/reply-to.mjs";
import { isTrialNoSend, trialSendBlocked } from "../_shared/trial-guard.ts";

// R113 (0322): a free trial never sends a code - the client page offers the test code 000000 instead
const TRIAL_OTP_MSG = "Test mode: your planner's studio is on a Helm free trial, so no code is sent. Use the test code 000000 on this page.";

// R108 (0318): { priced, studio } for this link, or null (unknown link / database without 0318 / any error)
// deno-lint-ignore no-explicit-any
async function quoteReady(admin: any, token: string): Promise<any> {
  try {
    const { data, error } = await admin.rpc("public_quote_ready", { p_token: token });
    return !error && data && typeof data === "object" ? data : null;
  } catch (_) { return null; }
}
const studioName = (v: unknown) => String(v || "").replace(/[\r\n<>]/g, " ").trim().slice(0, 120);
// R108: a quote with no price is not sent a code (fails open when the database cannot say)
// deno-lint-ignore no-explicit-any
async function notPricedMsg(admin: any, token: string): Promise<string | null> {
  const info = await quoteReady(admin, token);
  if (!info || info.priced !== false) return null;
  return "This quote isn't ready yet - please contact " + (studioName(info.studio) || "your planner") + ".";
}

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
  // deno-lint-ignore no-explicit-any
  let dest: any = null;
  const np = await notPricedMsg(admin, token);
  if (np) return json({ error: np, not_priced: true }, 409);
  // 0179 / R113 (0322): a free-trial studio (active or ended) gets no code on any channel - test mode instead
  if (await trialSendBlocked(admin, { token })) return json({ error: TRIAL_OTP_MSG, trial: true, test_mode: true }, 403);
  {
    const { data: pDest, error: bErr } = await admin.rpc("wa_otp_begin", { p_token: token, p_channel: channel, p_user_agent: ua });
    if (isTrialNoSend(bErr)) return json({ error: TRIAL_OTP_MSG, trial: true, test_mode: true }, 403);
    if (bErr || !pDest || !pDest.phone_key) {
      const [status, msg] = otpFailure(String(bErr?.code || ""), channel);
      return json({ error: msg }, status);
    }
    const { error: aErr } = await admin.rpc("otp_send_authorize", { p_token: token, p_phone: pDest.phone_key });
    if (isTrialNoSend(aErr)) return json({ error: TRIAL_OTP_MSG, trial: true, test_mode: true }, 403);
    if (aErr) { const [status, msg] = otpFailure(String(aErr.code || ""), channel); return json({ error: msg }, status); }
    dest = pDest;
  }
  const code = newCode();
  const storeArgs = { p_token: token, p_phone: dest.phone_key, p_code: code };
  const { error } = await admin.rpc("admin_store_otp", storeArgs);
  if (isTrialNoSend(error)) return json({ error: TRIAL_OTP_MSG, trial: true, test_mode: true }, 403);   // R113 (0322)
  if (error) { console.error("admin_store_otp failed", errTag(error)); return json({ error: "too many requests — please try again later" }, 429); }
  let live = false;
  if (channel === "whatsapp") {
    live = isLive({ WHATSAPP_TOKEN: Deno.env.get("WHATSAPP_TOKEN"), WHATSAPP_PHONE_ID: Deno.env.get("WHATSAPP_PHONE_ID") });
    if (live) {
      const r = await fetch(`https://graph.facebook.com/${Deno.env.get("WHATSAPP_API_VERSION") || "v21.0"}/${encodeURIComponent(Deno.env.get("WHATSAPP_PHONE_ID")!)}/messages`, { redirect: "error",
        method: "POST", headers: { "Authorization": "Bearer " + Deno.env.get("WHATSAPP_TOKEN"), "Content-Type": "application/json" },
        body: JSON.stringify(otpMessage(String(dest.to), code, Deno.env.get("WHATSAPP_TPL_LANG") || "en")),
      });
      await r.text();
      if (!r.ok) { console.error("whatsapp otp status", r.status); return json({ error: "WhatsApp message could not be sent", fallback: "email" }, 502); }
    }
  } else {
    // e-mail: shared mailer (Resend, else SMTP_* e.g. Gmail); sender per EMAIL_BRAND_MODE (default "Helm Events"),
    // R107: Reply-To = the studio's business e-mail, else the studio owner's (never Helm's sender, never in the answer)
    const envGet = (k: string) => Deno.env.get(k);
    let studio = "", replyTo: string | null = null;
    try {
      const { data: q } = await admin.from("quotes").select("org_id").eq("id", dest.quote_id).maybeSingle();
      if (q && q.org_id) {
        const { data: o } = await admin.from("organizations").select("name, business_email").eq("id", q.org_id).maybeSingle();
        studio = (o && o.name) || "";
        replyTo = (await studioReplyTo(admin, String(q.org_id), { business: (o && o.business_email) || null, env: envGet })) || null;
      }
    } catch (_) { /* studio name / reply-to are cosmetic */ }
    const m = otpEmail(code, studio || "your planner", { address: postalAddress(envGet), brand: brandMode(envGet) });
    const res = await sendMail({ to: String(dest.email), subject: m.subject, html: m.html, text: m.text, studio, replyTo, txReason: "otp" });
    if (res.status === "failed") { console.error("email otp failed", res.provider || ""); return json({ error: "e-mail could not be sent", status: "failed" }, 502); }
    live = res.status === "sent";
  }
  const { error: logErr } = await admin.from("notifications").insert({
    quote_id: dest.quote_id, channel: channel === "email" ? "email" : "whatsapp",
    recipient: channel === "email" ? String(dest.email) : String(dest.to), kind: "otp", status: live ? "sent" : "simulated",
  });
  if (logErr) console.error("otp log insert failed", errTag(logErr));
  return json({ sent: true, live, simulated: !live, status: live ? "sent" : "not_configured", channel, masked: dest.masked, resends_left: dest.resends_left });
}

// DB error → [http status, generic message] (never error.message)
function otpFailure(code: string, channel: "sms" | "whatsapp" | "email" = "sms"): [number, string] {
  switch (code) {
    case "HL404": return [404, "invalid link"];
    // 0151: an e-mail / WhatsApp code needs BOTH the client's mobile and (for e-mail) a valid e-mail saved on the quote
    case "HL403": return [400, channel === "sms" ? "use the mobile number your event manager has on file" : "your planner has not saved your mobile number and e-mail address on file yet - please contact your planner"];
    case "HL400": return [400, channel === "sms" ? "enter a valid Indian mobile number" : "your planner has not saved a valid mobile number on file yet - please contact your planner"];
    case "HL429": return [429, "too many requests — please try again later"];
    default: return [400, channel === "sms" ? "could not send the SMS — please try again later" : "could not send the code — please try again in a minute"];
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

    // 0179 / R113 (0322): no SMS from a free-trial studio (checked before any code is stored) - test mode instead
    if (await trialSendBlocked(admin, { token })) return json({ error: TRIAL_OTP_MSG, trial: true, test_mode: true }, 403);
    const npS = await notPricedMsg(admin, token);   // R108: no code for a quote without a price
    if (npS) return json({ error: npS, not_priced: true }, 409);

    // who may receive it + per-studio daily cap (server-side)
    const { data: dest, error: aErr } = await admin.rpc("otp_send_authorize", { p_token: token, p_phone: phone });
    if (isTrialNoSend(aErr)) return json({ error: TRIAL_OTP_MSG, trial: true, test_mode: true }, 403);
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
    if (isTrialNoSend(error)) return json({ error: TRIAL_OTP_MSG, trial: true, test_mode: true }, 403);   // R113 (0322)
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
      const r = await fetch("https://control.msg91.com/api/v5/flow/", { redirect: "error",
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
