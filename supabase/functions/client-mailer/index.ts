// client-mailer - "Send by email" from the quote flow: e-mails the client approval link
// (kind "approval") or the client booklet link (kind "booklet") to the client e-mail
// SAVED ON THE QUOTE. The recipient is never taken from the request.
//
// Request (signed-in staff JWT): { quote_id, kind: "approval" | "booklet" }
// Auth: the JWT is verified here (deploy with --no-verify-jwt). r56 (0297): the caller must be
// allowed to EDIT quotes (client_mailer_check, asked as the caller - same rule as WhatsApp).
// The quote is read AS THE CALLER, so row-level security limits it to the caller's own studio;
// the approval link must exist and still be live (not expired / paused / cancelled - r56 C-03)
// and a booklet link must be live (not revoked / expired). The service role is used only to read the studio name /
// business e-mail (R107: else the studio owner's e-mail, for Reply-To only - never in the answer) and to
// write the notifications log row (no message body, no token).
//
// Delivery: _shared/mailer.ts (Resend, else SMTP_* e.g. Gmail, else not_configured).
// Answer: { status: "sent" | "not_configured" | "failed" | "test_mode" | "limit" | "demo", masked, reason?, trial? }.
// Free trial (0166 rule, _shared/trial-outbound.ts, first gate): a trial / sample studio sends NOTHING -
// the row is logged 'suppressed' (suppressed_by trial) and the answer is status "test_mode"; when the
// plan cannot be read: 503 failed, nothing sent.
// 0179 (second gate): trial_send_blocked asked with the service role right before the send (fails
// closed) -> { status: "not_configured", trial: true }; nothing is sent, the log row says "simulated".
// 0212 (owner decision: e-mail works in the free trial): the gate is public.trial_email_gate (asked with the service
// role, _shared/trial-guard.ts trialEmailGate). Paid studio: sent as before. ACTIVE free trial: the e-mail really
// goes out, capped at 30 a day per studio and 5 a day per address (one slot per send) -> { status: "sent", trial:
// true }; over the cap -> 429 { status: "limit" }; a sample (demo) event -> { status: "demo" }; an ENDED trial,
// the sample master or the owner switch off -> { status: "test_mode" } as before. A database without 0212 keeps
// the two pre-0212 gates below (a trial sends nothing; an unreadable plan -> 503) - also used whenever the 0212 gate
// gives no clear answer, so a broken gate never becomes a trial e-mail.
// R114 (0323, owner decision: a free trial is a full SIMULATION): a trial studio's client e-mail is NEVER sent - not even
// when an older gate would allow it. The answer is { status: "test_mode", trial: true, simulated: true, preview:
// { subject, text } } (what the client WOULD receive) and the log row says "simulated". 0323 also turns the database
// gate off for trials (trial_email_gate -> allowed false). Paid studios: unchanged.
// WhatsApp / SMS are not sent from here at all.
// (The "Share booklet" dialog's Send to client goes through booklet_send / comms_outbox, 0200 / 0212.)
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { bearer, errTag, isAllowedOrigin, responders, UUID_RE } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";
import { brandMode, EMAIL_RE, sendMail } from "../_shared/mailer.ts";
import { postalAddress } from "../_shared/email-compliance.mjs";
import { studioReplyTo } from "../_shared/reply-to.mjs";
import { outboundBlocked, TEST_MODE_TEXT } from "../_shared/trial-outbound.ts";
import { linkEmail, maskEmail } from "./logic.mjs";
import { TRIAL_DEMO_MSG, TRIAL_EMAIL_CAP_MSG, trialEmailGate, trialSendBlocked } from "../_shared/trial-guard.ts";

export const KINDS = ["approval", "booklet"];
// R114 (0323): the line the studio sees next to the preview in a free trial
export const TRIAL_SIM_TEXT = "Trial simulation - nothing was sent to your client. This is what they would receive.";

function appOrigin(req: Request): string {
  const o = req.headers.get("origin");
  if (isAllowedOrigin(o)) return o;
  // r21: APP_URL (the name every other mailer uses) is read too; the default is the canonical www host
  // (the apex only 308-redirects there)
  const env = String(Deno.env.get("APP_ORIGIN") || Deno.env.get("APP_URL") || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[^\s/]+$/.test(env) ? env : "https://www.helm.events";
}

Deno.serve(async (req) => {
  const { cors, json, serverError } = responders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const ipWait = await checkLimits([["cm:ip:" + clientIp(req), 30, 60_000]]);
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

    const quoteId = String(body.quote_id || "");
    const kind = String(body.kind || "approval");
    if (!UUID_RE.test(quoteId)) return json({ error: "quote_id is required" }, 400);
    if (!KINDS.includes(kind)) return json({ error: "unknown message" }, 400);
    const wait = await checkLimits([["cm:user:" + user.id, 10, 60_000], ["cm:q:" + quoteId + ":" + kind, 3, 600_000]]);
    if (wait) return tooMany(json, wait);

    // r56 (0297, C-02): only people who may EDIT quotes send client links (same rule as WhatsApp). Asked AS THE
    // CALLER: signed in, own studio, has_area('quotes','edit'), quote not deleted. Any error (incl. a database
    // without 0297) refuses - nothing is sent.
    const { data: chk, error: cErr } = await asCaller.rpc("client_mailer_check", { p_quote: quoteId, p_kind: kind });
    if (cErr || !chk || chk.ok !== true) {
      const noEdit = String(cErr?.code || "") === "42501";
      return json({ error: noEdit ? "you need permission to edit quotes to send this e-mail" : "you can't send e-mail for this event" }, 403);
    }

    // read AS THE CALLER: RLS = own studio only
    const { data: q, error: qErr } = await asCaller.from("quotes")
      .select("id, org_id, client, approval_token, approval_token_expires_at").eq("id", quoteId).maybeSingle();
    if (qErr || !q) return json({ error: "you can't send e-mail for this event" }, 403);
    const to = String((q.client && q.client.email) || "").trim();
    if (!EMAIL_RE.test(to)) return json({ status: "failed", error: "add a valid client e-mail in step 1 first", reason: "add a valid client e-mail in step 1 first" }, 400);

    let token = "";
    if (kind === "approval") {
      token = String(q.approval_token || "");
      // r56 (C-03): never e-mail an expired / auto-expired / paused / cancelled approval link
      const expired = !!(q.approval_token_expires_at && Date.parse(q.approval_token_expires_at) <= Date.now());
      if (!UUID_RE.test(token) || expired || chk.link_live === false) {
        return json({ status: "failed", error: "create the approval link first", reason: "create the approval link first" }, 409);
      }
    } else {
      const { data: b } = await asCaller.from("client_booklets").select("token, expires_at, revoked_at")
        .eq("quote_id", quoteId).is("revoked_at", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (!b || !UUID_RE.test(String(b.token || "")) || (b.expires_at && Date.parse(b.expires_at) < Date.now())) {
        return json({ status: "failed", error: "create the client booklet link first", reason: "create the client booklet link first" }, 409);
      }
      token = String(b.token);
    }
    const origin = appOrigin(req);
    const link = kind === "approval"
      ? origin + "/portal.html?token=" + encodeURIComponent(token)
      : origin + "/booklet?t=" + encodeURIComponent(token);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: org } = await admin.from("organizations").select("name, business_email").eq("id", q.org_id).maybeSingle();
    const studio = (org && org.name) || "";
    const logKind = kind === "approval" ? "approval_link" : "booklet_link";
    const masked = maskEmail(to);

    const envGet = (k: string) => Deno.env.get(k);
    // R114 (0323): what the client WOULD receive - shown to the studio in a trial, never sent
    const simulated = async (extra: Record<string, unknown> = {}) => {
      let preview: { subject: string; text: string } | null = null;
      try {
        const pm = linkEmail(kind, { client: (q.client && q.client.name) || "", studio, link, brand: brandMode(envGet), address: postalAddress(envGet) });
        preview = { subject: pm.subject, text: pm.text };
      } catch (_) { preview = null; }
      const { error: sErr } = await admin.from("notifications").insert({
        quote_id: quoteId, channel: "email", recipient: to, kind: logKind, status: "simulated", detail: { suppressed_by: "trial_simulation" },
      });
      if (sErr) console.error("client-mailer: log insert failed", errTag(sErr));
      return json({ status: "test_mode", trial: true, simulated: true, masked, reason: TRIAL_SIM_TEXT, preview, ...extra });
    };

    // 0212 gate (0323: a trial is never allowed). R114: ANY trial answer -> simulation, nothing sent
    const g = await trialEmailGate(admin, { org: String(q.org_id || "") || null, quote: quoteId }, to, logKind);
    if (g && g.trial && g.reason !== "demo") return await simulated();
    if (g && !g.allowed) {
      const why = g.reason === "cap_studio" || g.reason === "cap_recipient" ? "trial_cap" : g.reason === "demo" ? "demo" : "trial";
      const { error: sErr } = await admin.from("notifications").insert({
        quote_id: quoteId, channel: "email", recipient: to, kind: logKind, status: "suppressed", detail: { suppressed_by: why },
      });
      if (sErr) console.error("client-mailer: log insert failed", errTag(sErr));
      if (why === "trial_cap") return json({ status: "limit", trial: true, masked, reason: TRIAL_EMAIL_CAP_MSG, error: TRIAL_EMAIL_CAP_MSG }, 429);
      if (why === "demo") return json({ status: "demo", trial: true, masked, reason: TRIAL_DEMO_MSG });
      return json({ status: "test_mode", trial: true, masked, reason: TEST_MODE_TEXT });
    }

    // no 0212 answer: the pre-0212 rule - a trial / sample studio sends nothing real (0166 rule)
    const gate = g ? { blocked: false, unknown: false } : await outboundBlocked(admin, String(q.org_id || ""), to);
    if (gate.blocked && !gate.unknown) return await simulated();   // R114: a trial -> the preview, nothing sent
    if (gate.blocked) {
      const { error: sErr } = await admin.from("notifications").insert({
        quote_id: quoteId, channel: "email", recipient: to, kind: logKind, status: "suppressed",
        detail: { suppressed_by: "plan_unknown" },
      });
      if (sErr) console.error("client-mailer: log insert failed", errTag(sErr));
      return json({ status: "failed", masked, error: "could not check the studio plan - nothing was sent, try again", reason: "could not check the studio plan - nothing was sent, try again" }, 503);
    }

    // 0179 (second gate, no 0212 answer): no e-mail to a client from a free-trial studio (fails closed)
    if (!g && await trialSendBlocked(admin, { org: String(q.org_id || "") || null, quote: quoteId })) {
      return await simulated();   // R114: a trial -> the preview, nothing sent
    }

    const m = linkEmail(kind, { client: (q.client && q.client.name) || "", studio, link, brand: brandMode(envGet), address: postalAddress(envGet) });
    // R107: the client's reply goes to the studio (business e-mail, else the owner's) - never to Helm's sender
    const replyTo = await studioReplyTo(admin, String(q.org_id || ""), { business: (org && org.business_email) || null, env: envGet });
    const res = await sendMail({ to, subject: m.subject, text: m.text, html: m.html, studio, replyTo: replyTo || null, txReason: "client_link" });

    const { error: logErr } = await admin.from("notifications").insert({
      quote_id: quoteId, channel: "email", recipient: to, kind: logKind,
      status: res.status === "sent" ? "sent" : res.status === "not_configured" ? "simulated" : "failed",
    });
    if (logErr) console.error("client-mailer: log insert failed", errTag(logErr));
    if (res.status === "sent") return json({ status: "sent", masked, provider: res.provider });
    return json({ status: res.status, masked, reason: res.reason, ...(res.status === "failed" ? { error: res.reason } : {}) }, res.status === "failed" ? 502 : 200);
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    return serverError(e);
  }
});
