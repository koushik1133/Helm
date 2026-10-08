// create-subscription-checkout — starts a Helm subscription (studio → Helm) paid through
// Razorpay Standard Checkout (checkout.js modal, subscription mode). Called by /checkout.
// We never see card / UPI / netbanking data: Razorpay's own modal collects it (PCI-DSS).
//   POST {plan, interval}                       → {key_id, subscription_id}
//   POST {action:"verify", razorpay_payment_id, razorpay_subscription_id, razorpay_signature}
//        → {verified:true}  (HMAC-SHA256(key_secret, payment_id + "|" + subscription_id),
//          constant-time; the subscription must belong to the caller's studio)
// The razorpay-subscription-webhook stays the SOURCE OF TRUTH for the charge — verify only
// lets the page say "payment received" early; it records no money.
//
// DORMANT BY DEFAULT: unless HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED === "true" AND both
// Razorpay keys are set, every POST answers 503 {dormant:true} and nothing is read,
// written or sent — the page then offers the free trial instead.
//
// Secrets / env:
//   HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED="true"
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET      (Helm's OWN Razorpay account)
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (injected)
//
// Trust model:
//   * The caller's JWT is required. Plan, price, tax, currency and the Razorpay plan id
//     all come from my_checkout_prepare, run AS THE CALLER (admin gate, terms accepted,
//     no active subscription) — the browser only names a plan code + interval.
//   * The Razorpay plan's own amount must equal the server total, or we refuse (409):
//     a mis-configured plan can never charge a different amount than the page showed.
//   * The org goes into the subscription notes AND is attached server-side
//     (checkout_attach_subscription, service role) so the webhook can map it back.
//
// Error contract (JSON {error, kind}): kind = "validation" (400, message is safe to
// show), "declined" (402/502, provider refused), "security" (401/403/429, generic
// message only), "dormant" (503), "server" (500).
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { bearer, errTag, responders } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped } from "../_shared/limits.ts";

const PLAN = /^[a-z0-9][a-z0-9_-]{1,39}$/;
const RZP_PLAN = /^plan_[A-Za-z0-9]{6,40}$/;
const RZP_SUB = /^sub_[A-Za-z0-9]{6,40}$/;
const RZP_PAY = /^pay_[A-Za-z0-9]{6,40}$/;
const enc = new TextEncoder();
async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
const SECURITY_MSG = "We couldn't verify this request. Please sign in again, or contact support if this keeps happening.";

Deno.serve(async (req) => {
  const { cors, json } = responders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed", kind: "validation" }, 405);
  const keyId = Deno.env.get("RAZORPAY_KEY_ID") || "", keySecret = Deno.env.get("RAZORPAY_KEY_SECRET") || "";
  if (Deno.env.get("HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED") !== "true" || !keyId || !keySecret) {
    return json({ error: "Online payment is being enabled", kind: "dormant", dormant: true }, 503);
  }
  try {
    const ipWait = await checkLimits([["csc:ip:" + clientIp(req), 20, 60_000]]);
    if (ipWait) return json({ error: SECURITY_MSG, kind: "security" }, 429);
    const body = await readJsonCapped(req) as Record<string, unknown>;
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const jwt = bearer(req);
    if (!jwt || !anonKey || jwt === anonKey) return json({ error: SECURITY_MSG, kind: "security" }, 401);
    const asCaller = createClient(url, anonKey, {
      global: { headers: { Authorization: "Bearer " + jwt } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user } } = await asCaller.auth.getUser(jwt);
    if (!user) return json({ error: SECURITY_MSG, kind: "security" }, 401);
    const userWait = await checkLimits([["csc:user:" + user.id, 5, 60_000]]);
    if (userWait) return json({ error: SECURITY_MSG, kind: "security" }, 429);

    if (body?.action === "verify") {
      const payId = String(body.razorpay_payment_id ?? ""), subId = String(body.razorpay_subscription_id ?? "");
      const sig = String(body.razorpay_signature ?? "").trim().toLowerCase();
      if (!RZP_PAY.test(payId) || !RZP_SUB.test(subId) || !/^[0-9a-f]{64}$/.test(sig)) return json({ error: SECURITY_MSG, kind: "security" }, 400);
      if (!timingSafeEqual(await hmacHex(keySecret, payId + "|" + subId), sig)) {
        console.error("checkout: payment signature mismatch");
        return json({ error: SECURITY_MSG, kind: "security" }, 400);
      }
      const { data: myOrg, error: oErr } = await asCaller.rpc("current_org_id");
      const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
      const { data: row, error: sErr } = await admin.from("studio_subscriptions").select("org_id").eq("provider_subscription_id", subId).maybeSingle();
      if (oErr || sErr) { console.error("checkout: verify lookup failed", errTag(oErr || sErr)); return json({ error: "Something went wrong. Please try again.", kind: "server" }, 500); }
      if (!myOrg || !row?.org_id || String(row.org_id).toLowerCase() !== String(myOrg).toLowerCase()) return json({ error: SECURITY_MSG, kind: "security" }, 403);
      return json({ verified: true });
    }

    const plan = String(body?.plan ?? ""), interval = String(body?.interval ?? "");
    if (!PLAN.test(plan)) return json({ error: "Choose a plan", kind: "validation" }, 400);
    if (interval !== "monthly" && interval !== "yearly") return json({ error: "Choose monthly or yearly billing", kind: "validation" }, 400);

    const { data: q, error: pErr } = await asCaller.rpc("my_checkout_prepare", { p_plan: plan, p_interval: interval });
    if (pErr) {
      const code = String((pErr as any).code || "");
      if (code === "42501") return json({ error: SECURITY_MSG, kind: "security" }, 403);
      if (code === "22023") {
        // our own validation messages (plain text, no data) are safe to show
        const msg = String((pErr as any).message || "").replace(/[^\w .,'’()-]/g, "").slice(0, 120) || "Please check your details";
        return json({ error: msg, kind: "validation" }, 400);
      }
      console.error("checkout: prepare failed", errTag(pErr));
      return json({ error: "Something went wrong. Please try again.", kind: "server" }, 500);
    }
    const org = String(q?.org_id || ""), rzpPlan = String(q?.razorpay_plan_id || "");
    const total = Number(q?.total), currency = String(q?.currency || "");
    if (!/^[0-9a-f-]{36}$/i.test(org) || !RZP_PLAN.test(rzpPlan) || !(total > 0) || !/^[A-Z]{3}$/.test(currency)) {
      console.error("checkout: prepare returned an unusable answer");
      return json({ error: "Something went wrong. Please try again.", kind: "server" }, 500);
    }

    const auth = "Basic " + btoa(keyId + ":" + keySecret);
    const rzp = (path: string, init: RequestInit = {}) =>
      fetch("https://api.razorpay.com/v1/" + path, { ...init, headers: { "Authorization": auth, "Content-Type": "application/json" } });

    // the Razorpay plan must charge exactly what the page showed
    const pr = await rzp("plans/" + rzpPlan);
    const pj = await pr.json().catch(() => ({}));
    if (!pr.ok) { console.error("checkout: razorpay plan lookup failed", pr.status); return json({ error: "The payment provider is unavailable. Please try again shortly.", kind: "declined" }, 502); }
    const item = pj?.item || {};
    if (Number(item.amount) !== Math.round(total * 100) || String(item.currency || "").toUpperCase() !== currency) {
      console.error("checkout: razorpay plan amount does not match the server total");
      return json({ error: "This plan's price is being updated. Please try again later or contact support.", kind: "validation" }, 409);
    }

    const r = await rzp("subscriptions", {
      method: "POST",
      body: JSON.stringify({
        plan_id: rzpPlan,
        total_count: interval === "yearly" ? 10 : 120,
        customer_notify: 1,
        notes: { org_id: org, plan: plan, interval },
      }),
    });
    const sub = await r.json().catch(() => ({}));
    if (!r.ok || !RZP_SUB.test(String(sub?.id || ""))) {
      console.error("checkout: razorpay subscription create failed", r.status);
      return json({ error: "The payment provider couldn't start your payment. Please try again.", kind: "declined" }, 502);
    }

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: attached, error: aErr } = await admin.rpc("checkout_attach_subscription",
      { p_org: org, p_subscription_id: sub.id, p_plan: plan, p_interval: interval });
    if (aErr || attached !== true) {
      console.error("checkout: attach failed", errTag(aErr));
      try { const c = await rzp(`subscriptions/${sub.id}/cancel`, { method: "POST", body: "{}" }); await c.text(); } catch (_) { /* best effort */ }
      return json({ error: "Something went wrong. Please try again.", kind: "server" }, 409);
    }
    // the modal needs only the PUBLIC key id + the subscription id (never the secret)
    return json({ key_id: keyId, subscription_id: sub.id });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large", kind: "validation" }, 413);
    console.error("checkout: internal error", errTag(e));
    return json({ error: "Something went wrong. Please try again.", kind: "server" }, 500);
  }
});
