// create-payment-link — creates a Razorpay Payment Link for an APPROVED quote,
// records it in quote_payments, and returns the short URL. Called by the approval page in LIVE mode.
//
// Secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cors, json, serverError } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { token } = await req.json();
    if (!token || typeof token !== "string") return json({ error: "token required" }, 400);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: q, error } = await admin.from("quotes").select("*").eq("approval_token", token).maybeSingle();
    if (error || !q) return json({ error: "invalid link" }, 404);
    // same expiry rule as the SQL token functions (approval_token_expires_at)
    if (q.approval_token_expires_at && new Date(q.approval_token_expires_at) <= new Date()) {
      return json({ error: "invalid link" }, 404);
    }
    // Never mint a second live link for a quote that is already paid (double charge).
    if (q.approval_status === "paid") return json({ error: "this quote is already paid" }, 409);
    if (q.approval_status !== "approved") return json({ error: "approve the terms first" }, 400);

    const total = Number(q.pricing?.total || 0);
    const amount = Math.round(total * 100); // paise
    if (!Number.isFinite(amount) || amount <= 0) return json({ error: "nothing to pay on this quote" }, 400);

    // Reuse an open (unpaid) live link for the same amount instead of creating a
    // new one on every click — multiple open links let the client pay twice.
    const { data: open } = await admin.from("quote_payments").select("link_url, amount")
      .eq("quote_id", q.id).eq("provider", "razorpay").eq("status", "created").eq("simulated", false)
      .not("link_url", "is", null).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (open?.link_url && Number(open.amount) === total) {
      return json({ link_url: open.link_url, amount: total, live: true });
    }

    const keyId = Deno.env.get("RAZORPAY_KEY_ID")!, keySecret = Deno.env.get("RAZORPAY_KEY_SECRET")!;
    const auth = "Basic " + btoa(keyId + ":" + keySecret);
    const cl = q.client || {};
    const r = await fetch("https://api.razorpay.com/v1/payment_links", {
      method: "POST",
      headers: { "Authorization": auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount, currency: "INR", accept_partial: false,
        description: "Event " + q.code,
        customer: { name: cl.name || "", email: cl.email || "", contact: cl.phone || "" },
        notify: { sms: true, email: !!cl.email },
        notes: { quote_id: q.id, code: q.code },
        callback_url: (Deno.env.get("APP_URL") || "") + "/approve.html?token=" + encodeURIComponent(token),
        callback_method: "get",
      }),
    });
    const link = await r.json();
    if (!r.ok) {
      console.error("razorpay error", r.status, JSON.stringify(link).slice(0, 500));
      return json({ error: "could not create the payment link, please try again" }, 502);
    }

    const { error: insErr } = await admin.from("quote_payments").insert({
      quote_id: q.id, provider: "razorpay", amount: total,
      status: "created", link_url: link.short_url, provider_ref: link.id, simulated: false,
    });
    // Without this row the webhook can't match the payment back by provider_ref.
    if (insErr) console.error("quote_payments insert failed", insErr);
    return json({ link_url: link.short_url, amount: total, live: true });
  } catch (e) {
    return serverError(e);
  }
});
