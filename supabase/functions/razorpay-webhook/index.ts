// razorpay-webhook — verifies the Razorpay signature, settles the quote, and sends the
// confirmation to the client + the studio by email (Resend).
// Set this URL as a webhook in the Razorpay dashboard for the `payment_link.paid`
// (and `payment.captured`) events, with the same secret as RAZORPAY_WEBHOOK_SECRET.
//
// Secrets / env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   RAZORPAY_WEBHOOK_SECRET
//   RESEND_API_KEY, RESEND_FROM          (e.g. "Helm <events@helm.events>" — the ADDRESS is
//                                         used; the display name is the paying studio's name)
//   MANAGER_EMAIL                        (OPTIONAL platform-ops copy: carries NO tenant data —
//                                         no client, amount or studio details)
//
// Audit Phase 8:
//   * every supabase-js error is checked → HTTP 500, so Razorpay retries the delivery;
//   * the whole decision is ONE DB transaction (public.razorpay_settle, 0027) under the
//     per-quote money lock: the quote is resolved from the link's provider_ref first
//     (notes.quote_id is only a fallback), the same payment id is applied once, and a
//     payment that cannot settle the quote (already paid, short, superseded link, over
//     the balance) is RECORDED in payment_reconciliation for a refund — never dropped;
//   * emails are per studio: organizations.name / business_email of the quote's org,
//     not a global manager address or hard-coded branding.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { errTag, escHtml, UUID_RE } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, rateLimit, readBodyCapped, WEBHOOK_BODY_LIMIT } from "../_shared/limits.ts";

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

const EMAIL = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
// "Studio Name <addr>" with the studio's (sanitized) name and the configured sender address
function fromHeader(studio: string) {
  const conf = Deno.env.get("RESEND_FROM") || "onboarding@resend.dev";
  const m = conf.match(/<([^>]+)>/);
  const addr = (m ? m[1] : conf).trim();
  const name = String(studio || "Helm").replace(/[\r\n<>"\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Helm";
  return `"${name}" <${addr}>`;
}

// returns the notifications.status to record: sent | failed | simulated (no provider)
async function sendEmail(to: string, subject: string, html: string, from: string, replyTo?: string): Promise<string> {
  const key = Deno.env.get("RESEND_API_KEY"); if (!key) return "simulated";
  if (!to || !EMAIL.test(to)) return "failed";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html, ...(replyTo && EMAIL.test(replyTo) ? { reply_to: replyTo } : {}) }),
    });
    await r.text();
    if (!r.ok) console.error("resend error", r.status);
    return r.ok ? "sent" : "failed";
  } catch (e) {
    console.error("resend error", errTag(e));
    return "failed";
  }
}

const oneLine = (s: unknown) => String(s ?? "").replace(/[\r\n]/g, " ").slice(0, 120);

Deno.serve(async (req) => {
  try {
    const wait = await rateLimit("rzp:ip:" + clientIp(req), 300, 60_000);
    if (wait) return new Response("too many requests", { status: 429, headers: { "Retry-After": String(wait) } });
    const raw = await readBodyCapped(req, WEBHOOK_BODY_LIMIT);
    const sig = req.headers.get("x-razorpay-signature") || "";
    const secret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET") || "";
    if (!secret || !timingSafeEqual(await hmacHex(secret, raw), sig)) return new Response("invalid signature", { status: 401 });

    let evt: any;
    try { evt = JSON.parse(raw); } catch (_) { return new Response("bad payload", { status: 200 }); }
    const type = evt?.event;
    if (!["payment_link.paid", "payment.captured"].includes(type)) return new Response("ignored", { status: 200 });

    const linkEnt = evt.payload?.payment_link?.entity || {};
    const payEnt = evt.payload?.payment?.entity || {};
    const linkId = /^plink_[A-Za-z0-9]+$/.test(String(linkEnt.id || "")) ? String(linkEnt.id) : null;
    const payId = /^pay_[A-Za-z0-9]+$/.test(String(payEnt.id || "")) ? String(payEnt.id) : null;
    const noteQuote = linkEnt.notes?.quote_id || payEnt.notes?.quote_id || null;
    // a malformed id would make the RPC throw → 500 → endless Razorpay retries
    const quoteHint = noteQuote && UUID_RE.test(String(noteQuote)) ? String(noteQuote) : null;
    if (!linkId && !quoteHint) return new Response("no quote", { status: 200 });
    const paidPaise = Number(linkEnt.amount_paid ?? payEnt.amount ?? NaN);

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

    const { data: out, error: sErr } = await admin.rpc("razorpay_settle", {
      p_quote: quoteHint, p_link_ref: linkId, p_payment_ref: payId,
      p_paid_paise: Number.isFinite(paidPaise) ? Math.round(paidPaise) : null, p_event: type,
    });
    if (sErr || !out) {
      console.error("razorpay_settle failed", errTag(sErr));
      return new Response("error", { status: 500 });                    // Razorpay retries
    }
    if (out.result === "unmatched") { console.error("webhook: payment matched no quote", type); return new Response("no quote", { status: 200 }); }
    // IDEMPOTENCY: a replayed delivery returns 200 WITHOUT re-notifying
    if (out.result === "replay") return new Response("already recorded (idempotent)", { status: 200 });

    // per-studio details for the emails
    const { data: q, error: qErr } = await admin.from("quotes").select("id, code, title, client, pricing, org_id").eq("id", out.quote_id).maybeSingle();
    if (qErr) { console.error("quote load failed", errTag(qErr)); return new Response("error", { status: 500 }); }
    if (!q) return new Response("ok", { status: 200 });
    const { data: org, error: oErr } = await admin.from("organizations").select("name, business_email").eq("id", q.org_id).maybeSingle();
    if (oErr) { console.error("studio load failed", errTag(oErr)); return new Response("error", { status: 500 }); }
    const studio = String(org?.name || "Your event studio");
    const studioEmail = String(org?.business_email || "");
    const from = fromHeader(studio);
    const subjCode = oneLine(q.code);

    if (out.result === "reconcile") {
      // money arrived that could not settle the quote: tell the studio (refund / match by hand)
      const html = `<h2>Payment needs your attention — ${escHtml(q.code)}</h2><p>A Razorpay payment for <b>${escHtml(q.title || q.code)}</b> could not be applied automatically (${escHtml(out.reason)}). It is listed under payment reconciliation; refund or match it in Razorpay.</p>`;
      const st = await sendEmail(studioEmail, `Payment needs attention — ${subjCode}`, html, fromHeader("Helm"));
      const { error: nErr } = await admin.from("notifications").insert(
        { quote_id: q.id, channel: "email", recipient: studioEmail || null, kind: "payment_reconcile", status: st });
      if (nErr) console.error("notification log failed", errTag(nErr));
      return new Response("recorded for reconciliation", { status: 200 });
    }

    // settled → confirmations (title/code are staff-entered — escaped)
    const total = "₹" + Number(q.pricing?.total || 0).toLocaleString("en-IN");
    const html = `<h2>Payment received — ${escHtml(q.code)}</h2><p>Your event <b>${escHtml(q.title || q.code)}</b> is confirmed.</p><p>Amount: <b>${total}</b></p><p>Thank you — ${escHtml(studio)}.</p>`;
    const clientEmail = String(q.client?.email || "");
    const clientStatus = await sendEmail(clientEmail, `Payment received — ${subjCode}`, html, from, studioEmail);
    // studio copy: the studio admin may have switched the automatic "payment received"
    // e-mail off (0036 notification_prefs). Fail-open: if the check errors, send as before.
    const { data: studioOn, error: pErr } = await admin.rpc("notify_allowed", { p_org: q.org_id, p_role: "*", p_type: "advance_paid", p_channel: "email" });
    if (pErr) console.error("notification prefs check failed", errTag(pErr));
    const studioStatus = (pErr || studioOn !== false)
      ? await sendEmail(studioEmail, `Event confirmed (paid) — ${subjCode}`, html, from)
      : "suppressed";
    const { error: nErr } = await admin.from("notifications").insert([
      { quote_id: q.id, channel: "email", recipient: clientEmail || null, kind: "payment_receipt", status: clientStatus },
      { quote_id: q.id, channel: "email", recipient: studioEmail || null, kind: "payment_receipt", status: studioStatus },
    ]);
    if (nErr) console.error("notification log failed", errTag(nErr));

    // optional platform-ops copy: no tenant data at all
    const ops = Deno.env.get("MANAGER_EMAIL") || "";
    if (ops) await sendEmail(ops, "Helm: a Razorpay payment was settled", "<p>A payment-link payment was settled. Details are in the studio's own account.</p>", fromHeader("Helm"));
    return new Response("ok", { status: 200 });
  } catch (e) {
    if (e instanceof BodyTooLarge) return new Response("payload too large", { status: 413 });
    console.error("webhook error", errTag(e));
    return new Response("error", { status: 500 });
  }
});
