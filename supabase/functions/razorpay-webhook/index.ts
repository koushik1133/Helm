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
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";
import { escHtml } from "../_shared/cors.ts";

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

// returns the notifications.status to record: sent | failed | simulated (no provider)
async function sendEmail(to: string, subject: string, html: string): Promise<string> {
  const key = Deno.env.get("RESEND_API_KEY"); if (!key) return "simulated";
  if (!to) return "failed";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from: Deno.env.get("RESEND_FROM") || "onboarding@resend.dev", to, subject, html }),
    });
    if (!r.ok) console.error("resend error", r.status, (await r.text()).slice(0, 300));
    return r.ok ? "sent" : "failed";
  } catch (e) {
    console.error("resend error", e);
    return "failed";
  }
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
      const { data } = await admin.from("quote_payments").select("quote_id").eq("provider_ref", linkId).maybeSingle();
      quoteId = data?.quote_id;
    }
    // a malformed id would make the UPDATE throw → 500 → endless Razorpay retries
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!quoteId || !UUID_RE.test(String(quoteId))) return new Response("no quote", { status: 200 });

    // Only settle the quote when what was actually paid covers its current total
    // (the quote may have been re-priced after the link was issued).
    const paidPaise = Number(evt.payload?.payment_link?.entity?.amount_paid ?? evt.payload?.payment?.entity?.amount ?? NaN);
    const { data: cur } = await admin.from("quotes").select("pricing").eq("id", quoteId).maybeSingle();
    if (!cur) return new Response("no quote", { status: 200 });
    const expectedPaise = Math.round(Number(cur.pricing?.total || 0) * 100);
    if (!Number.isFinite(paidPaise) || paidPaise < expectedPaise) {
      console.error("payment amount does not cover quote total", { quoteId, paidPaise, expectedPaise });
      // still record that this specific link was paid, for the manager to reconcile
      if (linkId) {
        await admin.from("quote_payments").update({ status: "paid", paid_at: new Date().toISOString() })
          .eq("provider_ref", linkId).eq("status", "created");
      }
      return new Response("amount mismatch — not marked paid", { status: 200 });
    }

    // IDEMPOTENCY: Razorpay delivers webhooks at-least-once (retries on non-2xx or
    // timeout). Only the FIRST delivery may transition created→paid and send the
    // confirmation emails. A replay finds the quote already paid and returns 200
    // WITHOUT re-notifying, so the client/manager never get duplicate receipts.
    // The transition is a single conditional UPDATE, so two concurrent deliveries
    // can't both "win" (a separate read-then-write check would race).
    const { data: q, error: upErr } = await admin.from("quotes").update({ approval_status: "paid" })
      .eq("id", quoteId).neq("approval_status", "paid").select("*").maybeSingle();
    if (upErr) throw upErr;
    if (!q) return new Response("already paid or unknown quote (idempotent)", { status: 200 });

    // mark the link that was actually paid; cancel the quote's other open links
    // (marking every open row "paid" over-recorded the payment)
    const paidAt = new Date().toISOString();
    let marked = false;
    if (linkId) {
      const { data: hit } = await admin.from("quote_payments").update({ status: "paid", paid_at: paidAt })
        .eq("quote_id", quoteId).eq("provider_ref", linkId).eq("status", "created").select("id");
      marked = !!(hit && hit.length);
    }
    if (!marked) {
      const { data: newest } = await admin.from("quote_payments").select("id").eq("quote_id", quoteId)
        .eq("status", "created").order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (newest) await admin.from("quote_payments").update({ status: "paid", paid_at: paidAt }).eq("id", newest.id);
    }
    await admin.from("quote_payments").update({ status: "cancelled" }).eq("quote_id", quoteId).eq("status", "created");

    // confirmations
    // title/code are staff-entered — escape before putting them in HTML email
    const total = "₹" + Number(q.pricing?.total || 0).toLocaleString("en-IN");
    const html = `<h2>Payment received — ${escHtml(q.code)}</h2><p>Your event <b>${escHtml(q.title || q.code)}</b> is confirmed.</p><p>Amount: <b>${total}</b></p><p>Thank you — Blueprint Stage.</p>`;
    const subjCode = String(q.code ?? "").replace(/[\r\n]/g, " ");
    const clientStatus = await sendEmail(q.client?.email, `Payment received — ${subjCode}`, html);
    const managerStatus = await sendEmail(Deno.env.get("MANAGER_EMAIL") || "", `Event confirmed (paid) — ${subjCode}`, html);
    await admin.from("notifications").insert([
      { quote_id: quoteId, channel: "email", recipient: q.client?.email, kind: "payment_receipt", status: clientStatus },
      { quote_id: quoteId, channel: "email", recipient: Deno.env.get("MANAGER_EMAIL"), kind: "payment_receipt", status: managerStatus },
    ]);
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response("error", { status: 500 });
  }
});
