// razorpay-subscription-webhook — settles Helm's OWN subscription charges (studio → Helm).
// Separate from razorpay-webhook (client → studio event payments) on purpose: different
// secret, different money flow, different RPC.
// DORMANT BY DEFAULT: unless HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED === "true" every request
// is a no-op 200 and nothing is read or written.
//
// Secrets / env:
//   HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED="true"
//   RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET   webhook secret set in the Razorpay dashboard
//                                          (unset → every call 401, fail closed)
//   RAZORPAY_EVENT_MAX_AGE_SEC             reject events older than this (default 86400)
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected)
//
// Trust model:
//   * X-Razorpay-Signature = hex HMAC-SHA256(secret, RAW body), compared in constant time.
//   * Amount, currency, payment id, subscription id and period come ONLY from the verified
//     payload. The org is resolved from studio_subscriptions.provider_subscription_id;
//     notes.org_id, when present, must AGREE with that row or the event is refused.
//   * Idempotent: hq_settle_provider_payment is keyed on the provider payment id, so a
//     replayed delivery settles nothing twice.
//
// ASSUMED SHAPES (NOT FINAL — read defensively):
//   Razorpay `subscription.charged` (standard):
//     { event, created_at (unix s), payload: {
//         subscription: { entity: { id: "sub_…", current_start, current_end (unix s), notes: { org_id } } },
//         payment:      { entity: { id: "pay_…", amount (paise), currency: "INR", status: "captured", created_at } } } }
//   studio_subscriptions(org_id uuid, provider_subscription_id text, …)
//   rpc hq_settle_provider_payment(p_provider_payment_id text, p_org uuid, p_amount numeric (RUPEES),
//       p_paid_on date, p_period_start date, p_period_end date)
//     → { result: 'settled' | 'replay' | … , payment_id? }   (service role only)
//
// Responses: 401 bad/missing signature · 400 stale or malformed · 200 ignored/unmatched/ok ·
// 500 DB error (Razorpay retries). Logs never contain payload contents.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { errTag, UUID_RE } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readBodyCapped, WEBHOOK_BODY_LIMIT } from "../_shared/limits.ts";

const enc = new TextEncoder();
async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const isoDate = (unix: unknown): string | null => {
  const n = Number(unix);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString().slice(0, 10) : null;
};
const text = (s: string, status = 200) => new Response(s, { status });

const HANDLED = new Set(["subscription.charged"]);
// known subscription lifecycle events we accept (200) but do not act on
const KNOWN = new Set(["subscription.activated", "subscription.authenticated", "subscription.pending", "subscription.halted",
  "subscription.cancelled", "subscription.paused", "subscription.resumed", "subscription.completed", "subscription.updated"]);

Deno.serve(async (req) => {
  try {
    if (Deno.env.get("HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED") !== "true") return text("dormant");
    if (req.method !== "POST") return text("method not allowed", 405);
    const wait = await checkLimits([["rzs:ip:" + clientIp(req), 300, 60_000]]);
    if (wait) return new Response("too many requests", { status: 429, headers: { "Retry-After": String(wait) } });
    const raw = await readBodyCapped(req, WEBHOOK_BODY_LIMIT);
    const sig = (req.headers.get("x-razorpay-signature") || "").trim().toLowerCase();
    const secret = Deno.env.get("RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET") || "";
    if (!secret || !sig || !timingSafeEqual(await hmacHex(secret, raw), sig)) return text("invalid signature", 401);

    let evt: any;
    try { evt = JSON.parse(raw); } catch (_) { return text("bad payload", 400); }
    const type = String(evt?.event || "");
    if (!HANDLED.has(type)) return text(KNOWN.has(type) ? "ignored" : "unknown event", 200);

    const maxAge = Math.max(60, Number(Deno.env.get("RAZORPAY_EVENT_MAX_AGE_SEC")) || 86400);
    const created = Number(evt?.created_at);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(created) || created < now - maxAge || created > now + 300) return text("stale event", 400);

    const sub = evt?.payload?.subscription?.entity || {};
    const pay = evt?.payload?.payment?.entity || {};
    const subId = /^sub_[A-Za-z0-9]{6,40}$/.test(String(sub.id || "")) ? String(sub.id) : null;
    const payId = /^pay_[A-Za-z0-9]{6,40}$/.test(String(pay.id || "")) ? String(pay.id) : null;
    const paise = Number(pay.amount);
    if (!subId || !payId || !Number.isInteger(paise) || paise <= 0) return text("malformed", 400);
    if (String(pay.currency || "INR").toUpperCase() !== "INR") return text("ignored: currency", 200);
    if (pay.status && String(pay.status) !== "captured") return text("ignored: not captured", 200);
    const noteOrg = sub.notes?.org_id ?? pay.notes?.org_id ?? null;
    if (noteOrg !== null && !UUID_RE.test(String(noteOrg))) return text("malformed", 400);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: row, error: sErr } = await admin.from("studio_subscriptions")
      .select("org_id").eq("provider_subscription_id", subId).maybeSingle();
    if (sErr) { console.error("sub-webhook: lookup failed", errTag(sErr)); return text("error", 500); }
    const org = row?.org_id ? String(row.org_id) : null;
    if (!org || !UUID_RE.test(org)) { console.error("sub-webhook: subscription matched no studio"); return text("unmatched", 200); }
    if (noteOrg !== null && String(noteOrg).toLowerCase() !== org.toLowerCase()) {
      console.error("sub-webhook: notes.org_id disagrees with subscription owner");
      return text("org mismatch", 200);
    }

    const { data: out, error: rErr } = await admin.rpc("hq_settle_provider_payment", {
      p_provider_payment_id: payId,
      p_org: org,
      p_amount: paise / 100,
      p_paid_on: isoDate(pay.created_at) || isoDate(created),
      p_period_start: isoDate(sub.current_start),
      p_period_end: isoDate(sub.current_end),
    });
    if (rErr) { console.error("sub-webhook: settle failed", errTag(rErr)); return text("error", 500); }
    if (out && typeof out === "object" && out.result === "replay") return text("already recorded (idempotent)");
    return text("ok");
  } catch (e) {
    if (e instanceof BodyTooLarge) return text("payload too large", 413);
    console.error("sub-webhook error", errTag(e));
    return text("error", 500);
  }
});
