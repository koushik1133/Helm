// create-payment-link — creates a Razorpay Payment Link for an APPROVED quote,
// records it in quote_payments, and returns the short URL. Called by the approval page in LIVE mode.
//
// Secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { cors, json } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { token } = await req.json();
    if (!token) return json({ error: "token required" }, 400);
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const { data: q, error } = await admin.from("quotes").select("*").eq("approval_token", token).single();
    if (error || !q) return json({ error: "invalid link" }, 404);
    if (!["approved", "paid"].includes(q.approval_status)) return json({ error: "approve the terms first" }, 400);

    const amount = Math.round(Number(q.pricing?.total || 0) * 100); // paise
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
        callback_url: (Deno.env.get("APP_URL") || "") + "/approve.html?token=" + token,
        callback_method: "get",
      }),
    });
    const link = await r.json();
    if (!r.ok) return json({ error: link?.error?.description || "razorpay error" }, 502);

    await admin.from("quote_payments").insert({
      quote_id: q.id, provider: "razorpay", amount: Number(q.pricing?.total || 0),
      status: "created", link_url: link.short_url, provider_ref: link.id, simulated: false,
    });
    return json({ link_url: link.short_url, amount: Number(q.pricing?.total || 0), live: true });
  } catch (e) {
    return json({ error: (e as Error).message || "error" }, 500);
  }
});
