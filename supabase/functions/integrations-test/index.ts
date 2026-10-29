// integrations-test (0150) - the Integrations page's "Check status" and "Send test" buttons.
// Called by a SIGNED-IN studio member with their own JWT (never the anon key).
//
// Requests:
//   { "action": "status" }                        -> which channels can really send (booleans
//                                                    only, never a key). Needs Settings VIEW
//                                                    (checked by integrations_overview as the caller).
//   { "action": "test", "channel": "email" }      -> a test e-mail to the CALLER'S OWN login e-mail
//   { "action": "test", "channel": "whatsapp" }   -> a test WhatsApp to the studio's OWN saved number
//   The e-mail test needs Settings EDIT; the recipient comes from integrations_test_target()
//   (the database, as the caller) - never from the request, so this is not a relay.
//   r59 (0300, audit F-1): the WhatsApp test is for STUDIO ADMINS only and goes out only when the
//   studio WhatsApp number is the saved mobile of an active member of the same studio
//   (integrations_wa_test_target, as the caller). Before a LIVE send it also checks the STOP list
//   (whatsapp_opt_outs, when that table exists), the free-trial guard (no WhatsApp from a trial
//   studio) and a per-studio daily cap (WA_TEST_PER_DAY, default 5 a day, durable).
//
// Result: { mode: "live", sent: true, to: "<masked>" } when the secrets are set and the
//         provider accepted it; { mode: "simulated", to, from, reply_to, reason } when the
//         channel is not switched on (nothing leaves Helm); { mode: "live", sent: false, error }
//         when the provider refused it.
//
// Secrets / env (same names as comms-dispatch / invite-mailer - nothing new to set):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (injected)
//   RESEND_API_KEY, RESEND_FROM
//   WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_API_VERSION, COMMS_WHATSAPP_TEMPLATE,
//   WHATSAPP_TPL_LANG, WHATSAPP_ALLOW_TEXT, WHATSAPP_APP_SECRET + WHATSAPP_WEBHOOK_VERIFY_TOKEN
//   (status only: reports whether the webhook is configured)
//   HELM_INTEGRATIONS_TEST_ENABLED="false"  kill switch -> every test is "simulated"
//
// Limits: 20 status / 5 tests per user per 10 minutes, 60 per IP per minute, WhatsApp tests 5 per studio per day.
// Logs carry only status codes - never an address, a phone number or a key.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { bearer, errTag, responders } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";
import { postalAddress, txFooter, withFooter } from "../_shared/email-compliance.mjs";
import { TRIAL_NO_SEND_MSG, trialSendBlocked } from "../_shared/trial-guard.ts";
import { channelStatus, fromHeader, maskEmail, maskPhone, PHONE_RE, EMAIL_RE, replyToOf, testEmail, waTargetRefusal, waTestContent, optOutTableMissing, waTestPerDay } from "./logic.mjs";

const DAY_MS = 86_400_000;

const ALLOWED_HOSTS = new Set(["api.resend.com", "graph.facebook.com"]);
async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) throw new Error("host not allowed");
  return await fetch(u.toString(), { ...init, redirect: "error" });
}
const env = (k: string) => Deno.env.get(k);

Deno.serve(async (req) => {
  const { cors, json, serverError } = responders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const ipWait = await checkLimits([["itest:ip:" + clientIp(req), 60, 60_000]]);
    if (ipWait) return tooMany(json, ipWait);
    const body: Record<string, unknown> = await readJsonCapped(req);
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
    const st = channelStatus(env);
    const action = String(body.action || "");

    if (action === "status") {
      const w = await checkLimits([["itest:status:" + user.id, 20, 600_000]]);
      if (w) return tooMany(json, w);
      const { error } = await asCaller.rpc("integrations_overview", {});
      if (error) return json({ error: "only people who can open Settings can see this" }, 403);
      return json({ email: st.email, whatsapp: st.whatsapp });
    }
    if (action !== "test") return json({ error: "unknown action" }, 400);
    const channel = String(body.channel || "");
    if (channel !== "email" && channel !== "whatsapp") return json({ error: "channel must be email or whatsapp" }, 400);
    const w = await checkLimits([["itest:send:" + user.id, 5, 600_000]]);
    if (w) return tooMany(json, w);
    const { data: t, error: tErr } = await asCaller.rpc("integrations_test_target", {});
    if (tErr || !t) {
      if (String(tErr?.code || "") === "42501") return json({ error: "only people who can edit Settings can send a test" }, 403);
      console.error("integrations-test: target failed", errTag(tErr));
      return json({ error: "apply APPLY-0150.sql first" }, 503);
    }
    const off = String(env("HELM_INTEGRATIONS_TEST_ENABLED") ?? "").trim().toLowerCase() === "false";

    if (channel === "email") {
      const to = String(t.email || "");
      if (!EMAIL_RE.test(to)) return json({ error: "your login has no e-mail address" }, 400);
      const from = fromHeader(env("RESEND_FROM"), t.from_name, t.studio_name);
      const reply = replyToOf(t.reply_to);
      const shown = { to: maskEmail(to), from: st.email.live ? from : fromHeader("", t.from_name, t.studio_name).replace(/<[^>]*>/, "<Helm's sending address>"), reply_to: reply || null };
      if (!st.email.live || off) return json({ mode: "simulated", sent: false, reason: off ? "test sending is switched off" : "RESEND_API_KEY is not set yet", ...shown });
      const msg = testEmail(t.studio_name);
      const r = await safeFetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": "Bearer " + (env("RESEND_API_KEY") || ""), "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject: msg.subject, text: withFooter({ text: msg.text }, txFooter("test", { app: Deno.env.get("APP_URL"), address: postalAddress((k: string) => Deno.env.get(k)) })).text, ...(reply ? { reply_to: reply } : {}) }),
      });
      await r.text();
      if (!r.ok) { console.error("integrations-test: email status", r.status); return json({ mode: "live", sent: false, error: "the e-mail provider refused it (status " + r.status + ") - check the sending domain is verified", ...shown }); }
      return json({ mode: "live", sent: true, ...shown });
    }

    // whatsapp (r59 / 0300): admins only, a team member's own mobile only - asked as the CALLER
    const { data: wt, error: wtErr } = await asCaller.rpc("integrations_wa_test_target", {});
    if (wtErr) {
      const c = String(wtErr.code || "");
      if (c === "42501") return json({ error: "only a studio admin can send a test WhatsApp" }, 403);
      if (c === "PGRST202" || c === "42883") return json({ error: "apply APPLY-0300.sql first" }, 503);
      console.error("integrations-test: whatsapp target failed", errTag(wtErr));
      return json({ error: "could not check the number - try again" }, 500);
    }
    const refused = waTargetRefusal(wt);
    if (refused) return json({ error: refused }, 400);
    const to = String(wt.studio_whatsapp || "");
    if (!PHONE_RE.test(to)) return json({ error: "save your studio WhatsApp number first" }, 400);
    const orgId = String(wt.org_id || t.org_id || "");
    const shown = { to: maskPhone(to) };
    const content = waTestContent(env);
    if (!st.whatsapp.live || off || !content) {
      const reason = off ? "test sending is switched off" : !st.whatsapp.credentials ? "WHATSAPP_TOKEN / WHATSAPP_PHONE_ID are not set yet" : "no approved template set (COMMS_WHATSAPP_TEMPLATE)";
      return json({ mode: "simulated", sent: false, reason, ...shown });
    }
    // a real send from Helm's shared number: free trial, STOP list and a daily cap first (service role)
    const svcKey = env("SUPABASE_SERVICE_ROLE_KEY") || "";
    if (!svcKey || !/^[0-9a-f-]{36}$/i.test(orgId)) return json({ error: "could not check the studio" }, 500);
    const admin = createClient(url, svcKey, { auth: { persistSession: false, autoRefreshToken: false } });
    if (await trialSendBlocked(admin, { org: orgId })) return json({ error: TRIAL_NO_SEND_MSG, trial: true }, 403);
    const { data: optOut, error: ooErr } = await admin.from("whatsapp_opt_outs").select("id")
      .eq("phone", to).eq("opted_out", true).or("org_id.is.null,org_id.eq." + orgId).limit(1).maybeSingle();
    if (ooErr && !optOutTableMissing(ooErr)) { console.error("integrations-test: opt-out lookup failed", errTag(ooErr)); return json({ error: "could not check the recipient" }, 500); }
    if (optOut) return json({ error: "this number replied STOP to WhatsApp messages - no test was sent", ...shown }, 409);
    const dayWait = await checkLimits([["itest:wa:day:" + orgId, waTestPerDay(env), DAY_MS]]);
    if (dayWait) {
      const r = json({ error: "the daily limit of test WhatsApps for your studio is reached - try again tomorrow" }, 429);
      r.headers.set("Retry-After", String(dayWait));
      return r;
    }
    const ver = /^v[0-9]{1,2}\.[0-9]$/.test(env("WHATSAPP_API_VERSION") || "") ? env("WHATSAPP_API_VERSION")! : "v21.0";
    const r = await safeFetch(`https://graph.facebook.com/${ver}/${encodeURIComponent(env("WHATSAPP_PHONE_ID") || "")}/messages`, {
      method: "POST",
      headers: { "Authorization": "Bearer " + (env("WHATSAPP_TOKEN") || ""), "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, ...content }),
    });
    await r.text();
    if (!r.ok) { console.error("integrations-test: whatsapp status", r.status); return json({ mode: "live", sent: false, error: "Meta refused it (status " + r.status + ") - check the token, phone number ID and that the template is approved", ...shown }); }
    return json({ mode: "live", sent: true, ...shown });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    return serverError(e);
  }
});
