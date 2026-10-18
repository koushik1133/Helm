// client-mailer - "Send by email" from the quote flow: e-mails the client approval link
// (kind "approval") or the client booklet link (kind "booklet") to the client e-mail
// SAVED ON THE QUOTE. The recipient is never taken from the request.
//
// Request (signed-in staff JWT): { quote_id, kind: "approval" | "booklet" }
// Auth: the JWT is verified here (deploy with --no-verify-jwt). The quote is read AS THE
// CALLER, so row-level security limits it to the caller's own studio; the approval link
// must already exist (generate_approval_token needs quotes EDIT) and a booklet link must be
// live (not revoked / expired). The service role is used only to read the studio name /
// business e-mail and to write the notifications log row (no message body, no token).
//
// Delivery: _shared/mailer.ts (Resend, else SMTP_* e.g. Gmail, else not_configured).
// Answer: { status: "sent" | "not_configured" | "failed", masked, reason? }.
// 0179: a free-trial studio (studio_subscriptions.status 'trial') e-mails NO client: checked with the
// service role (trial_send_blocked) before the send -> { status: "not_configured", trial: true }
// (the screen says "Not sent ... Use Copy link"); nothing is sent, the log row says "simulated".
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { bearer, errTag, isAllowedOrigin, responders, UUID_RE } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";
import { brandMode, EMAIL_RE, sendMail } from "../_shared/mailer.ts";
import { postalAddress } from "../_shared/email-compliance.mjs";
import { linkEmail, maskEmail } from "./logic.mjs";
import { trialSendBlocked } from "../_shared/trial-guard.ts";

export const KINDS = ["approval", "booklet"];

function appOrigin(req: Request): string {
  const o = req.headers.get("origin");
  if (isAllowedOrigin(o)) return o;
  const env = String(Deno.env.get("APP_ORIGIN") || "").replace(/\/+$/, "");
  return /^https:\/\/[^\s/]+$/.test(env) ? env : "https://helm.events";
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

    // read AS THE CALLER: RLS = own studio only
    const { data: q, error: qErr } = await asCaller.from("quotes")
      .select("id, org_id, client, approval_token").eq("id", quoteId).maybeSingle();
    if (qErr || !q) return json({ error: "you can't send e-mail for this event" }, 403);
    const to = String((q.client && q.client.email) || "").trim();
    if (!EMAIL_RE.test(to)) return json({ status: "failed", error: "add a valid client e-mail in step 1 first", reason: "add a valid client e-mail in step 1 first" }, 400);

    let token = "";
    if (kind === "approval") {
      token = String(q.approval_token || "");
      if (!UUID_RE.test(token)) return json({ status: "failed", error: "create the approval link first", reason: "create the approval link first" }, 409);
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
    // 0179: no e-mail to a client from a free-trial studio
    if (await trialSendBlocked(admin, { org: String(q.org_id || "") || null, quote: quoteId })) {
      const { error: tErr } = await admin.from("notifications").insert({
        quote_id: quoteId, channel: "email", recipient: to, kind: kind === "approval" ? "approval_link" : "booklet_link", status: "simulated",
      });
      if (tErr) console.error("client-mailer: log insert failed", errTag(tErr));
      return json({ status: "not_configured", trial: true, masked: maskEmail(to), reason: "e-mails to clients are not sent during the free trial" });
    }
    const { data: org } = await admin.from("organizations").select("name, business_email").eq("id", q.org_id).maybeSingle();
    const studio = (org && org.name) || "";
    const envGet = (k: string) => Deno.env.get(k);
    const m = linkEmail(kind, { client: (q.client && q.client.name) || "", studio, link, brand: brandMode(envGet), address: postalAddress(envGet) });
    const res = await sendMail({ to, subject: m.subject, text: m.text, html: m.html, studio, replyTo: org && org.business_email, txReason: "client_link" });

    const { error: logErr } = await admin.from("notifications").insert({
      quote_id: quoteId, channel: "email", recipient: to, kind: kind === "approval" ? "approval_link" : "booklet_link",
      status: res.status === "sent" ? "sent" : res.status === "not_configured" ? "simulated" : "failed",
    });
    if (logErr) console.error("client-mailer: log insert failed", errTag(logErr));
    const masked = maskEmail(to);
    if (res.status === "sent") return json({ status: "sent", masked, provider: res.provider });
    return json({ status: res.status, masked, reason: res.reason, ...(res.status === "failed" ? { error: res.reason } : {}) }, res.status === "failed" ? 502 : 200);
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    return serverError(e);
  }
});
