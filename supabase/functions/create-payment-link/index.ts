// create-payment-link — creates a Razorpay Payment Link for an APPROVED quote,
// records it in quote_payments, and returns the short URL. Called by the approval page in LIVE mode.
//
// Secrets / env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET   — global Helm account (FALLBACK only, see 0117 below)
//   APP_URL                       — e.g. https://www.helm.events (Razorpay returns the payer here)
//   PAYMENT_LINK_TTL_MINUTES      — optional, link lifetime (default 4320 = 3 days, 20..43200)
//
// Audit Phase 8:
//   * SERIALIZED per quote: public.payment_link_begin (0027) takes the per-quote money
//     lock and reserves the 'created' row BEFORE Razorpay is called, so two clicks /
//     two tabs can never mint two live links ('busy' → 409, or the same link back).
//   * expire_by is set on every link; an open link is reused only while it is a real
//     Razorpay link (plink_ id + rzp.io URL) for the CURRENT total and not near expiry.
//   * when the total changed, the superseded links are cancelled at Razorpay too.
//   * the approval token is NOT sent to Razorpay: callback_url is a token-free
//     /approve.html?payment=done page (the token is a 30-day bearer secret).
//   * client email / phone are format-checked before they are sent to Razorpay.
//
// 0092 country templates: Razorpay Payment Links are created in INR only. Razorpay
// settles Indian merchant accounts in INR; other currencies need "International
// payments" enabled per account, which Helm cannot verify. A quote in AED / USD (UAE /
// US studio) is refused BEFORE anything is reserved ("currency_unsupported"); the
// approval page shows "pay by bank transfer / card - the studio records it" instead.
// The client phone gets the STUDIO's dial code (+91 / +971 / +1) when typed without one.
//
// 0117 per-studio accounts (DORMANT until a studio's org_payment_accounts row is
// 'connected'): the quote's studio's own Razorpay keys are looked up through the
// service-role RPC org_razorpay_creds(org). If the studio has none (or the lookup
// fails / 0117 is not applied) the link is created exactly as before with the global
// RAZORPAY_KEY_ID/SECRET. Set RAZORPAY_REQUIRE_STUDIO_ACCOUNT=1 to refuse the global
// fallback (recommended once studios collect their own money).
//
// 0187: a studio on its free trial (or whose trial ended unpaid) gets NO real payment link - Razorpay
// would text / e-mail the client and take real money. Checked here with the service role
// (trial_send_blocked) before anything is reserved -> 409 { code: "trial", trial: true }; the database
// refuses it too (payment_link_begin 42501 / hint trial_no_send).
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { errTag, normPhone, responders } from "../_shared/cors.ts";
import { dialFor, quoteCur, razorpaySupports } from "../_shared/money.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";
import { isTrialNoSend, trialSendBlocked } from "../_shared/trial-guard.ts";

const TRIAL_PAY_MSG = "Online payment isn't available while your planner's studio is on its free trial - your planner will share payment details.";

const PLINK = /^plink_[A-Za-z0-9]+$/;
const RZP_URL = /^https:\/\/rzp\.io\/[A-Za-z0-9/_-]+$/;
const EMAIL = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

const KEY_ID = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/;
// 0117: per-studio credentials (service-role RPC) -> global env fallback -> null (503)
// deno-lint-ignore no-explicit-any
export async function resolveRazorpayCreds(admin: any, orgId: unknown): Promise<{ keyId: string; keySecret: string; source: "studio" | "env" } | null> {
  if (orgId && typeof orgId === "string") {
    try {
      const { data, error } = await admin.rpc("org_razorpay_creds", { p_org: orgId });
      if (error) console.error("org_razorpay_creds failed", errTag(error));
      else if (data && KEY_ID.test(String(data.key_id || "")) && typeof data.key_secret === "string" && data.key_secret.length >= 8) {
        return { keyId: String(data.key_id), keySecret: data.key_secret, source: "studio" };
      }
    } catch (e) { console.error("org_razorpay_creds failed", errTag(e)); }
  }
  if (Deno.env.get("RAZORPAY_REQUIRE_STUDIO_ACCOUNT") === "1") return null;
  const keyId = Deno.env.get("RAZORPAY_KEY_ID") || "", keySecret = Deno.env.get("RAZORPAY_KEY_SECRET") || "";
  return keyId && keySecret ? { keyId, keySecret, source: "env" } : null;
}

const isRazorpayLink = (ref: unknown, url: unknown) => PLINK.test(String(ref || "")) && RZP_URL.test(String(url || ""));

Deno.serve(async (req) => {
  const { cors, json, serverError } = responders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const ipWait = await checkLimits([["cpl:ip:" + clientIp(req), 30, 60_000]]);
    if (ipWait) return tooMany(json, ipWait);
    const { token } = await readJsonCapped(req) as { token?: unknown };
    if (!token || typeof token !== "string") return json({ error: "token required" }, 400);
    const idWait = await checkLimits([["cpl:tok:" + token.toLowerCase(), 10, 60_000]]);
    if (idWait) return tooMany(json, idWait);
    if (!/^[0-9a-f-]{36}$/i.test(token)) return json({ error: "invalid link" }, 404);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    // 0092: INR only - checked before payment_link_begin so nothing is reserved for AED / USD
    const { data: qc, error: qcErr } = await admin.from("quotes").select("currency, tax_snapshot, pricing, org_id")
      .eq("approval_token", token.toLowerCase()).maybeSingle();
    if (qcErr) { console.error("quote currency load failed", errTag(qcErr)); return json({ error: "could not prepare the payment, please try again" }, 500); }
    // 0187: never a real link (Razorpay SMS / e-mail to the client, real money) from a free-trial studio
    if (await trialSendBlocked(admin, { org: qc?.org_id ? String(qc.org_id) : null, token: token.toLowerCase() })) {
      return json({ error: TRIAL_PAY_MSG, code: "trial", trial: true }, 409);
    }
    if (qc && !razorpaySupports(quoteCur(qc))) {
      return json({ error: "online card payment is not available for this quote - please pay by bank transfer and your planner will record it", code: "currency_unsupported" }, 409);
    }
    // 0117: the studio's own Razorpay account first, global env keys as the fallback
    const creds = await resolveRazorpayCreds(admin, qc?.org_id);
    if (!creds) return json({ error: "online payments are not configured" }, 503);
    const { keyId, keySecret } = creds;
    let dial = "91";
    if (qc?.org_id) {
      const { data: org } = await admin.from("organizations").select("country").eq("id", qc.org_id).maybeSingle();
      dial = dialFor(org?.country);
    }

    const ttl = Math.min(43200, Math.max(20, Number(Deno.env.get("PAYMENT_LINK_TTL_MINUTES")) || 4320));
    const { data: b, error: bErr } = await admin.rpc("payment_link_begin", { p_token: token, p_ttl_minutes: ttl });
    if (isTrialNoSend(bErr)) return json({ error: TRIAL_PAY_MSG, code: "trial", trial: true }, 409);   // 0187
    if (bErr || !b) { console.error("payment_link_begin failed", errTag(bErr)); return json({ error: "could not prepare the payment, please try again" }, 500); }
    switch (b.action) {
      case "invalid": return json({ error: "invalid link" }, 404);
      // Never mint a second live link for a quote that is already paid (double charge).
      case "paid": return json({ error: "this quote is already paid" }, 409);
      case "not_approved": return json({ error: "approve the terms first" }, 400);
      case "nothing_due": return json({ error: "nothing to pay on this quote" }, 400);
      case "busy": return json({ error: "your payment link is being prepared — try again in a moment" }, 409);
      case "reuse":
        // Only a link Razorpay itself issued (plink_ id + rzp.io URL) is ever handed out.
        return json({ link_url: b.link_url, amount: Number(b.amount), live: true });
      case "create": break;
      default: return json({ error: "could not prepare the payment, please try again" }, 500);
    }

    const auth = "Basic " + btoa(keyId + ":" + keySecret);
    const rzp = (path: string, init: RequestInit = {}) =>
      fetch("https://api.razorpay.com/v1/" + path, { ...init, headers: { "Authorization": auth, "Content-Type": "application/json" } });

    // cancel links superseded by a changed total (best effort; the webhook records any
    // payment that still arrives on one for reconciliation)
    for (const ref of Array.isArray(b.supersede) ? b.supersede : []) {
      if (!PLINK.test(String(ref))) continue;
      try { const r = await rzp(`payment_links/${ref}/cancel`, { method: "POST" }); await r.text(); if (!r.ok) console.error("razorpay cancel failed", r.status); }
      catch (e) { console.error("razorpay cancel failed", errTag(e)); }
    }

    const total = Number(b.amount);
    const amount = Math.round(total * 100); // paise, from the server's quote total
    const cl = (b.client && typeof b.client === "object") ? b.client : {};
    const email = EMAIL.test(String(cl.email || "")) ? String(cl.email) : "";
    const phone = normPhone(cl.phone, dial);
    const contact = /^[0-9]{10,15}$/.test(phone) ? "+" + phone : "";
    const name = String(cl.name || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 100);
    const appUrl = (Deno.env.get("APP_URL") || "").replace(/\/+$/, "");

    const r = await rzp("payment_links", {
      method: "POST",
      body: JSON.stringify({
        amount, currency: "INR", accept_partial: false,
        description: ("Event " + String(b.code || "")).slice(0, 2048),
        reference_id: String(b.payment_id),
        expire_by: Number(b.expire_by),
        customer: { name, email, contact },
        notify: { sms: !!contact, email: !!email },
        notes: { quote_id: String(b.quote_id), code: String(b.code || ""), payment_id: String(b.payment_id) },
        ...(appUrl ? { callback_url: appUrl + "/approve.html?payment=done", callback_method: "get" } : {}),
      }),
    });
    const link = await r.json().catch(() => ({}));
    if (!r.ok || !isRazorpayLink(link.id, link.short_url)) {
      console.error("razorpay error", r.status);
      const { error: fErr } = await admin.rpc("payment_link_fail", { p_payment: b.payment_id });
      if (fErr) console.error("payment_link_fail failed", errTag(fErr));
      return json({ error: "could not create the payment link, please try again" }, 502);
    }

    // Without this row the webhook can't match the payment back by provider_ref.
    const { data: attached, error: aErr } = await admin.rpc("payment_link_attach",
      { p_payment: b.payment_id, p_provider_ref: link.id, p_link_url: link.short_url });
    if (aErr || attached !== true) {
      // our reservation was superseded meanwhile — never hand out an untracked link
      console.error("payment_link_attach failed", errTag(aErr));
      try { const c = await rzp(`payment_links/${link.id}/cancel`, { method: "POST" }); await c.text(); } catch (_) { /* best effort */ }
      return json({ error: "your payment link changed — please try again" }, 409);
    }
    return json({ link_url: link.short_url, amount: total, live: true });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    return serverError(e);
  }
});
