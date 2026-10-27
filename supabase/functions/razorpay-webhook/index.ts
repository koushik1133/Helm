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
//
// 0117 (DORMANT until a studio connects its own Razorpay account):
//   * per-studio webhook URL  .../razorpay-webhook?org=<studio uuid>  is verified with
//     THAT studio's webhook secret (org_razorpay_creds, service role); a payment it signs
//     may only settle a quote of that studio (razorpay_settle_for_org -> 'org_mismatch'
//     is ignored, never settled). Without ?org= the global RAZORPAY_WEBHOOK_SECRET path
//     is unchanged.
//   * payment.failed, payment_link.cancelled, payment_link.expired, refund.processed
//     are recorded idempotently (razorpay_record_event, unique per x-razorpay-event-id);
//     a cancelled/expired link's open reservation is closed so it is never reused.
//     Refunds are recorded only - the ledger is never rewritten automatically.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { errTag, escHtml, UUID_RE } from "../_shared/cors.ts";
import { quoteCur, symMoney } from "../_shared/money.ts";
import { BodyTooLarge, clientIp, checkLimits, readBodyCapped, WEBHOOK_BODY_LIMIT } from "../_shared/limits.ts";
import { postalAddress, txFooter, withFooter } from "../_shared/email-compliance.mjs";

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
  const _f = withFooter({ text: "", html }, txFooter("payment", { app: Deno.env.get("APP_URL"), address: postalAddress((k: string) => Deno.env.get(k)) }));
    try {
    const r = await fetch("https://api.resend.com/emails", { redirect: "error",
      method: "POST", headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html: _f.html, ...(replyTo && EMAIL.test(replyTo) ? { reply_to: replyTo } : {}) }),
    });
    await r.text();
    if (!r.ok) console.error("resend error", r.status);
    return r.ok ? "sent" : "failed";
  } catch (e) {
    console.error("resend error", errTag(e));
    return "failed";
  }
}

// 0117: events that are RECORDED (idempotently), never settled
export const RECORD_ONLY = ["payment.failed", "payment_link.cancelled", "payment_link.expired", "refund.processed"];
const REF = (re: RegExp, v: unknown) => re.test(String(v || "")) ? String(v) : null;
async function sha256Hex(s: string) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// deno-lint-ignore no-explicit-any
async function recordEvent(admin: any, req: Request, raw: string, evt: any, org: string | null): Promise<Response> {
  const type = String(evt.event);
  const hdrId = req.headers.get("x-razorpay-event-id") || "";
  const eventId = /^[A-Za-z0-9_-]{6,100}$/.test(hdrId) ? hdrId : "body:" + await sha256Hex(raw);
  const link = evt.payload?.payment_link?.entity || {};
  const pay = evt.payload?.payment?.entity || {};
  const rf = evt.payload?.refund?.entity || {};
  const linkRef = REF(/^plink_[A-Za-z0-9]+$/, link.id);
  const payRef = REF(/^pay_[A-Za-z0-9]+$/, pay.id) || REF(/^pay_[A-Za-z0-9]+$/, rf.payment_id);
  const refundRef = REF(/^rfnd_[A-Za-z0-9]+$/, rf.id);
  const hint = link.notes?.quote_id || pay.notes?.quote_id || rf.notes?.quote_id || null;
  const amount = Number(type === "refund.processed" ? rf.amount : type === "payment.failed" ? pay.amount : link.amount);
  const status = String((type === "refund.processed" ? rf.status : type === "payment.failed" ? pay.status : link.status) || "").slice(0, 40) || null;
  const { data, error: recErr } = await admin.rpc("razorpay_record_event", {
    p_event_id: eventId, p_org: org, p_type: type, p_link_ref: linkRef, p_payment_ref: payRef, p_refund_ref: refundRef,
    p_amount_paise: Number.isFinite(amount) ? Math.round(amount) : null, p_status: status,
    p_quote_hint: hint && UUID_RE.test(String(hint)) ? String(hint) : null,
  });
  if (recErr) { console.error("razorpay_record_event failed", errTag(recErr)); return new Response("error", { status: 500 }); }
  if (data?.result === "replay") return new Response("already recorded (idempotent)", { status: 200 });
  if (data?.result === "org_mismatch") return new Response("ignored", { status: 200 });
  return new Response("recorded", { status: 200 });
}

const oneLine = (s: unknown) => String(s ?? "").replace(/[\r\n]/g, " ").slice(0, 120);

Deno.serve(async (req) => {
  try {
    const wait = await checkLimits([["rzp:ip:" + clientIp(req), 300, 60_000]]);
    if (wait) return new Response("too many requests", { status: 429, headers: { "Retry-After": String(wait) } });
    const raw = await readBodyCapped(req, WEBHOOK_BODY_LIMIT);
    const sig = req.headers.get("x-razorpay-signature") || "";
    // 0117: ?org=<uuid> -> that studio's own webhook secret; otherwise the global one
    const orgParam = new URL(req.url).searchParams.get("org");
    if (orgParam !== null && !UUID_RE.test(orgParam)) return new Response("invalid signature", { status: 401 });
    let secret = "";
    let admin: any = null;
    const db = () => admin ||= createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    if (orgParam) {
      const { data: cr, error: cErr } = await db().rpc("org_razorpay_creds", { p_org: orgParam });
      if (cErr) { console.error("org_razorpay_creds failed", errTag(cErr)); return new Response("error", { status: 500 }); }
      secret = typeof cr?.webhook_secret === "string" ? cr.webhook_secret : "";
    } else {
      secret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET") || "";
    }
    if (!secret || !timingSafeEqual(await hmacHex(secret, raw), sig)) return new Response("invalid signature", { status: 401 });

    let evt: any;
    try { evt = JSON.parse(raw); } catch (_) { return new Response("bad payload", { status: 200 }); }
    const type = evt?.event;
    if (RECORD_ONLY.includes(type)) return await recordEvent(db(), req, raw, evt, orgParam);
    if (!["payment_link.paid", "payment.captured"].includes(type)) return new Response("ignored", { status: 200 });

    const linkEnt = evt.payload?.payment_link?.entity || {};
    const payEnt = evt.payload?.payment?.entity || {};
    const linkId = /^plink_[A-Za-z0-9]+$/.test(String(linkEnt.id || "")) ? String(linkEnt.id) : null;
    const payId = /^pay_[A-Za-z0-9]+$/.test(String(payEnt.id || "")) ? String(payEnt.id) : null;
    const noteQuote = linkEnt.notes?.quote_id || payEnt.notes?.quote_id || null;
    // a malformed id would make the RPC throw → 500 → endless Razorpay retries
    const quoteHint = noteQuote && UUID_RE.test(String(noteQuote)) ? String(noteQuote) : null;
    if (!linkId && !quoteHint) return new Response("no quote", { status: 200 });
    // r31: Helm makes payment links in INR only (create-payment-link). A paid event in any other currency is never
    // settled automatically: the amount is left blank, so razorpay_settle files it under payment reconciliation
    // (amount_mismatch) for the studio to check by hand - money is never dropped, never counted at the wrong value.
    const payCur = String(payEnt.currency || linkEnt.currency || "INR").trim().toUpperCase();
    const paidPaise = payCur === "INR" ? Number(linkEnt.amount_paid ?? payEnt.amount ?? NaN) : NaN;
    if (payCur !== "INR") console.error("webhook: paid event not in INR - sent to reconciliation", oneLine(payCur).slice(0, 8));
    // r31: razorpay_settle de-duplicates on the payment id. An event WITHOUT one can't be de-duplicated, so a
    // re-sent copy would file another reconciliation row and e-mail the studio again: only a fresh one is used.
    if (!payId) {
      const maxAge = Math.max(60, Number(Deno.env.get("RAZORPAY_EVENT_MAX_AGE_SEC")) || 86400);
      const created = Number(evt?.created_at), now = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(created) || created < now - maxAge || created > now + 300) {
        console.error("webhook: paid event without a payment id and not fresh - ignored", type);
        return new Response("stale event", { status: 200 });
      }
    }

    admin = db();
    const settleArgs = {
      p_quote: quoteHint, p_link_ref: linkId, p_payment_ref: payId,
      p_paid_paise: Number.isFinite(paidPaise) ? Math.round(paidPaise) : null, p_event: type,
    };
    let out: any = null, sErr: any = null;
    if (orgParam) {
      const { data: oOut, error: oErr } = await admin.rpc("razorpay_settle_for_org", { p_org: orgParam, ...settleArgs });
      out = oOut; sErr = oErr;
    } else {
      const { data: gOut, error: gErr } = await admin.rpc("razorpay_settle", settleArgs);
      out = gOut; sErr = gErr;
    }
    if (sErr || !out) {
      console.error("razorpay_settle failed", errTag(sErr));
      return new Response("error", { status: 500 });                    // Razorpay retries
    }
    if (out.result === "org_mismatch") { console.error("webhook: payment belongs to another studio - ignored", type); return new Response("ignored", { status: 200 }); }
    if (out.result === "unmatched") { console.error("webhook: payment matched no quote", type); return new Response("no quote", { status: 200 }); }
    // IDEMPOTENCY: a replayed delivery returns 200 WITHOUT re-notifying
    if (out.result === "replay") return new Response("already recorded (idempotent)", { status: 200 });

    // per-studio details for the emails
    const { data: q, error: qErr } = await admin.from("quotes").select("id, code, title, client, pricing, org_id, currency, tax_snapshot").eq("id", out.quote_id).maybeSingle();
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
    // India audit: say what was PAID (this payment + ledger total) and the balance - never the quote total as if paid in full
    const grand = Number(q.pricing?.total || 0);
    const { data: pays, error: paysErr } = await admin.from("quote_payments").select("amount").eq("quote_id", q.id).eq("status", "paid");
    if (paysErr) console.error("payments load failed", errTag(paysErr));   // email still goes, using this payment only
    const paidSum = (pays || []).reduce((a: number, r: { amount: unknown }) => a + (Number(r.amount) || 0), 0);
    const thisPay = Number.isFinite(paidPaise) ? Math.round(paidPaise) / 100 : paidSum;
    const bal = Math.max(0, grand - paidSum);
    const amt = symMoney(thisPay, quoteCur(q)), totalTxt = symMoney(grand, quoteCur(q));   // 0092: the quote's own currency
    const html = `<h2>Payment received — ${escHtml(q.code)}</h2><p>Your booking for <b>${escHtml(q.title || q.code)}</b> is confirmed.</p><p>Amount received: <b>${amt}</b></p>`
      + (bal > 0.5 ? `<p>Quote total: ${totalTxt} · Balance due: <b>${symMoney(bal, quoteCur(q))}</b></p>` : `<p>Your event is now paid in full (${totalTxt}).</p>`)
      + `<p>Thank you — ${escHtml(studio)}.</p>`;
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
