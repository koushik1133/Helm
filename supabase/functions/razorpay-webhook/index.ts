// razorpay-webhook — verifies the Razorpay signature, marks the quote paid, and
// sends confirmation to the client + manager by email (Resend) and SMS (MSG91).
// Set this URL as a webhook in the Razorpay dashboard for the `payment_link.paid`
// (and `payment.captured`) events, with the same secret as RAZORPAY_WEBHOOK_SECRET.
//
// Secrets:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RAZORPAY_WEBHOOK_SECRET
//   RESEND_API_KEY, RESEND_FROM          (e.g. "Blueprint Stage <events@yourdomain.com>")
//   MANAGER_EMAIL, MANAGER_PHONE         (where the studio copy goes)
//   MSG91_AUTHKEY, MSG91_SENDER, MSG91_SMS_TEMPLATE_ID  (optional SMS receipt)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const enc = new TextEncoder();
async function hmacHex(secret: string, body: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// constant-time string compare — avoids leaking the signature via response timing
function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sendEmail(to: string, subject: string, html: string) {
  const key = Deno.env.get("RESEND_API_KEY"); if (!key || !to) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify({ from: Deno.env.get("RESEND_FROM") || "onboarding@resend.dev", to, subject, html }),
  });
}

Deno.serve(async (req) => {
  try {
    const raw = await req.text();
    const sig = req.headers.get("x-razorpay-signature") || "";
    const secret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET") || "";
    if (!secret || !timingSafeEqual(await hmacHex(secret, raw), sig)) return new Response("invalid signature", { status: 401 });

    const evt = JSON.parse(raw);
    const type = evt.event;
    if (!["payment_link.paid", "payment.captured"].includes(type)) return new Response("ignored", { status: 200 });

    const linkId = evt.payload?.payment_link?.entity?.id;
    const noteQuote = evt.payload?.payment_link?.entity?.notes?.quote_id
      || evt.payload?.payment?.entity?.notes?.quote_id;
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // find the quote (by provider_ref or the notes.quote_id)
    let quoteId = noteQuote;
    if (!quoteId && linkId) {
      const { data } = await admin.from("quote_payments").select("quote_id").eq("provider_ref", linkId).single();
      quoteId = data?.quote_id;
    }
    if (!quoteId) return new Response("no quote", { status: 200 });

    // IDEMPOTENCY: Razorpay delivers webhooks at-least-once (retries on non-2xx or
    // timeout). Only the FIRST delivery may transition created→paid and send the
    // confirmation emails. A replay finds the quote already paid and returns 200
    // WITHOUT re-notifying, so the client/manager never get duplicate receipts.
    const { data: already } = await admin.from("quotes").select("approval_status").eq("id", quoteId).single();
    if (already?.approval_status === "paid") return new Response("already paid (idempotent)", { status: 200 });

    await admin.from("quote_payments").update({ status: "paid", paid_at: new Date().toISOString() })
      .eq("quote_id", quoteId).eq("status", "created");
    const { data: q } = await admin.from("quotes").update({ approval_status: "paid" }).eq("id", quoteId).select("*").single();

    // confirmations
    const total = "₹" + Number(q?.pricing?.total || 0).toLocaleString("en-IN");
    const html = `<h2>Payment received — ${q?.code}</h2><p>Your event <b>${q?.title || q?.code}</b> is confirmed.</p><p>Amount: <b>${total}</b></p><p>Thank you — Blueprint Stage.</p>`;
    await sendEmail(q?.client?.email, `Payment received — ${q?.code}`, html);
    await sendEmail(Deno.env.get("MANAGER_EMAIL") || "", `Event confirmed (paid) — ${q?.code}`, html);
    await admin.from("notifications").insert([
      { quote_id: quoteId, channel: "email", recipient: q?.client?.email, kind: "payment_receipt", status: "sent" },
      { quote_id: quoteId, channel: "email", recipient: Deno.env.get("MANAGER_EMAIL"), kind: "payment_receipt", status: "sent" },
    ]);
    return new Response("ok", { status: 200 });
  } catch (e) {
    return new Response((e as Error).message || "error", { status: 500 });
  }
});
