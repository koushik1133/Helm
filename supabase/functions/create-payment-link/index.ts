// create-payment-link — creates a Razorpay Payment Link for an APPROVED quote,
// records it in quote_payments, and returns the short URL. Called by the approval page in LIVE mode.
//
// Secrets / env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
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
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { errTag, normPhone, responders } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";

const PLINK = /^plink_[A-Za-z0-9]+$/;
const RZP_URL = /^https:\/\/rzp\.io\/[A-Za-z0-9/_-]+$/;
const EMAIL = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

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
    const keyId = Deno.env.get("RAZORPAY_KEY_ID") || "", keySecret = Deno.env.get("RAZORPAY_KEY_SECRET") || "";
    if (!keyId || !keySecret) return json({ error: "online payments are not configured" }, 503);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    const ttl = Math.min(43200, Math.max(20, Number(Deno.env.get("PAYMENT_LINK_TTL_MINUTES")) || 4320));
    const { data: b, error: bErr } = await admin.rpc("payment_link_begin", { p_token: token, p_ttl_minutes: ttl });
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
    const phone = normPhone(cl.phone);
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
