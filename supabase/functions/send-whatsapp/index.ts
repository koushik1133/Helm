// send-whatsapp — sends a WhatsApp message through the **Meta WhatsApp Cloud API**
// (graph.facebook.com). Called by the app in LIVE mode via callFn("send-whatsapp", …).
// All Meta credentials live ONLY here as secret env vars — never in the frontend.
//
// Secrets / env (supabase secrets set …):
//   SUPABASE_URL, SUPABASE_ANON_KEY            (provided automatically)
//   SUPABASE_SERVICE_ROLE_KEY                  (provided automatically; used ONLY to log)
//   WHATSAPP_TOKEN            — permanent access token of the Meta system user
//   WHATSAPP_PHONE_ID         — the WhatsApp Business phone number ID (numeric)
//   WHATSAPP_API_VERSION      — optional, defaults to "v21.0"
//   WHATSAPP_TEMPLATES        — comma-separated allowlist of approved template names
//                               (default: the names in DEFAULT_TEMPLATES below)
//   WHATSAPP_ALLOW_TEXT=1     — optional: also allow free-form text (24h session window)
//
// Audit Phase 8 — no open relay on the shared platform number. Every send must:
//   * come from a signed-in user (their JWT, not the anon key),
//   * name the event (quote_id) it is about; the caller's OWN JWT is used (RLS +
//     public.whatsapp_authorize) to prove the event is in their studio, that they have
//     quotes edit rights, that the number belongs to that event (client, crew link,
//     booked vendor) and that the studio is under its hourly WhatsApp limit,
//   * use an allowlisted template (free text only when WHATSAPP_ALLOW_TEXT=1),
//   * be logged to notifications with channel 'whatsapp' (insert error checked).
// Audit run-3 (0155): the database also refuses a number that replied STOP (HL451), caps the
// distinct numbers a studio may message per day, and limits an unpaid trial studio to clients
// who opted in. Template values are plain one-line text (no control characters, at most 200
// characters) and may link only to the Helm site (APP_URL), never to another host.
//
// Audit run-3 edge/send-whatsapp/staff-editable-recipient-binding-relay: the "number is
// on the event" rule above is checked against phone fields the same studio can edit, so
// this function also (after whatsapp_authorize, service role for the reads):
//   * refuses a number that sent STOP (public.whatsapp_opt_outs, Helm-wide or this studio),
//   * UNPAID studios (no 'active' studio_subscriptions row - trials included) may message
//     only a number with a recorded opt-in for THIS event (public.wa_proposal_optins);
//     paid studios too when WHATSAPP_REQUIRE_OPTIN=1,
//   * caps DISTINCT recipients per studio per day (WHATSAPP_DISTINCT_PER_DAY_PAID,
//     default 200; WHATSAPP_DISTINCT_PER_DAY_UNPAID, default 3 new numbers) and unpaid
//     studios' total sends per day (WHATSAPP_UNPAID_PER_DAY, default 60). "Unpaid" = no
//     'active' subscription AND no current payment (same rule as public._trial_paid),
//   * template parameters (ONE rule set, shared with 0155): plain one-line text - control
//     characters / line breaks / tabs are REJECTED (not cleaned); a link only to the Helm
//     site (APP_URL host, needed for proposal links); at most 10 of at most 200 characters.
//
// 0179: a free-trial studio (studio_subscriptions.status 'trial') sends NO WhatsApp at all (the 0155
// "opted-in clients only" trial exception is gone): the database refuses (42501 / hint trial_no_send)
// and this function also asks trial_send_blocked with the service role right before the Meta call.
//
// Requests:
//   { "ping": true }                                     → credential check, no send
//   { "quote_id": "<uuid>", "number": "<phone>", "template": "<name>",
//     "lang": "en_US", "params": ["v1","v2", …], "kind": "<label>" }
//   { "quote_id": "<uuid>", "number": "<phone>", "text": "<message>" }  (if allowed)
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { bearer, errTag, responders, UUID_RE } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, durableHit, readJsonCapped, tooMany } from "../_shared/limits.ts";
import { TRIAL_NO_SEND_HINT, TRIAL_NO_SEND_MSG, trialSendBlocked } from "../_shared/trial-guard.ts";

const TOKEN = Deno.env.get("WHATSAPP_TOKEN") || "";
const PHONE_ID = Deno.env.get("WHATSAPP_PHONE_ID") || "";
const VER = Deno.env.get("WHATSAPP_API_VERSION") || "v21.0";
const GRAPH = "https://graph.facebook.com";
const DEFAULT_TEMPLATES = ["event_update", "payment_reminder", "event_reminder", "crew_assignment"];
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const LANG = /^[a-z]{2,3}(_[A-Z]{2})?$/;

const DAY_MS = 86_400_000;
const PARAM_MAX = 200;
// Things that look like a link: scheme://..., www...., or a bare domain (common TLDs, or any
// domain followed by a path). Each one must point at the Helm site, never another host.
const LINK_TOKENS = /[a-z][a-z0-9+.-]*:\/\/[^\s]*|\bwww\.[^\s]*|\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|in|ae|co|ly|me|app|xyz|link|site|online|info|biz|events)\b[^\s]*|\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\/[^\s]*/gi;
// Plain text only: Meta also refuses new lines / tabs / >4 spaces in template params.
// deno-lint-ignore no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]| {5,}/;
function siteHost(): string {
  try { return new URL(Deno.env.get("APP_URL") || "https://www.helm.events").hostname.toLowerCase(); }
  catch (_) { return "www.helm.events"; }
}
function linkHost(tok: string): string {
  let t = tok.toLowerCase();
  const m = /^([a-z][a-z0-9+.-]*):\/\//.exec(t);
  if (m) {
    if (m[1] !== "https" && m[1] !== "http") return "";
    t = t.slice(m[0].length);
  }
  t = t.replace(/^[^@\/]*@/, "");            // user@host tricks
  return t.split(/[\/?#:\s]/)[0].replace(/\.+$/, "");
}
export function paramProblem(p: unknown, site = siteHost()): string {
  if (p != null && typeof p !== "string" && typeof p !== "number") return "template parameters must be text";
  const v = String(p ?? "");
  if (v.length > PARAM_MAX) return "a template parameter is too long";
  if (BAD_CHARS.test(v)) return "template parameters must be one line of plain text";
  const base = site.replace(/^www\./, "");
  for (const m of v.matchAll(LINK_TOKENS)) {
    const h = linkHost(m[0]);
    if (!h || (h !== base && !h.endsWith("." + base))) return "template values may only link to the Helm site";
  }
  return "";
}
function envInt(k: string, dflt: number): number {
  const n = Number(Deno.env.get(k) || "");
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : dflt;
}

function templateAllowlist(): string[] {
  const env = (Deno.env.get("WHATSAPP_TEMPLATES") || "").trim();
  const list = env ? env.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_TEMPLATES;
  return list.filter((n) => TEMPLATE_NAME.test(n));
}

function authHeaders() {
  return { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" };
}

// DB error → [http status, generic message] (never the raw message)
function authzFailure(code: string, hint = ""): [number, string] {
  if (code === "HL429") return [429, "WhatsApp limit reached for your studio — try again later"];
  if (code === "HL451") return [409, "this person replied STOP to WhatsApp messages — reach them another way"];
  if (code === "22023") return [400, "invalid number"];
  if (code === "42501" && hint === TRIAL_NO_SEND_HINT) return [403, TRIAL_NO_SEND_MSG];   // 0179
  if (code === "42501" && hint === "trial_optin") return [403, "during the free trial, WhatsApp goes only to clients who opted in on the proposal screen"];
  return [403, "you can't send WhatsApp messages for this event to that number"];
}

Deno.serve(async (req) => {
  const { cors, json, serverError } = responders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const ipWait = await checkLimits([["wa:ip:" + clientIp(req), 60, 60_000]]);
    if (ipWait) return tooMany(json, ipWait);
    // size cap BEFORE any auth round-trip or parsing (413)
    const body: any = await readJsonCapped(req);
    if (!TOKEN || !PHONE_ID) {
      return json({ error: "WhatsApp Cloud API not configured (set WHATSAPP_TOKEN / WHATSAPP_PHONE_ID)" }, 500);
    }
    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const jwt = bearer(req);
    if (!jwt || !anonKey || jwt === anonKey) return json({ error: "sign in as a staff user" }, 401);

    // Everything about WHO may send WHAT to WHOM runs as the CALLER (their JWT → RLS).
    const asCaller = createClient(url, anonKey, {
      global: { headers: { Authorization: "Bearer " + jwt } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user } } = await asCaller.auth.getUser(jwt);
    if (!user) return json({ error: "sign in as a staff user" }, 401);
    const userWait = await checkLimits([["wa:user:" + user.id, 30, 60_000]]);
    if (userWait) return tooMany(json, userWait);

    // ---- credential / connection check (no message sent) ----
    if (body && body.ping === true) {
      const r = await fetch(`${GRAPH}/${VER}/${encodeURIComponent(PHONE_ID)}?fields=verified_name,display_phone_number,quality_rating`, {
        headers: authHeaders(),
      });
      await r.text();
      if (!r.ok) { console.error("meta ping failed", r.status); return json({ error: "whatsapp connection check failed" }, 502); }
      return json({ ok: true });
    }

    const quoteId = String(body.quote_id || "");
    if (!UUID_RE.test(quoteId)) return json({ error: "quote_id is required" }, 400);

    // ---- message content: allowlisted template, or (opt-in) session text ----
    let content: Record<string, unknown>;
    if (body.template != null) {
      const name = String(body.template);
      if (!templateAllowlist().includes(name)) return json({ error: "template not allowed" }, 400);
      const lang = String(body.lang || "en_US");
      if (!LANG.test(lang)) return json({ error: "invalid language" }, 400);
      if (Array.isArray(body.params) && body.params.length > 10) return json({ error: "at most 10 template parameters" }, 400);
      const params = Array.isArray(body.params) ? body.params : [];
      for (const p of params) { const bad = paramProblem(p); if (bad) return json({ error: bad }, 400); }
      content = {
        type: "template",
        template: {
          name,
          language: { code: lang },
          ...(params.length
            ? { components: [{ type: "body", parameters: params.map((p: unknown) => ({ type: "text", text: String(p ?? "") })) }] }
            : {}),
        },
      };
    } else {
      if (Deno.env.get("WHATSAPP_ALLOW_TEXT") !== "1") return json({ error: "use an approved template" }, 400);
      const text = String(body.text || "").trim().slice(0, 1000);
      if (!text) return json({ error: "text or template is required" }, 400);
      content = { type: "text", text: { preview_url: false, body: text } };
    }

    // ---- the caller's studio must own the event (RLS) ----
    const { data: q, error: qErr } = await asCaller.from("quotes").select("id, org_id").eq("id", quoteId).maybeSingle();
    if (qErr) { console.error("quote lookup failed", errTag(qErr)); return json({ error: "could not check the event" }, 500); }
    if (!q) return json({ error: "you can't send WhatsApp messages for this event to that number" }, 403);

    // ---- area right + number belongs to the event + per-studio rate limit ----
    const { data: ok, error: aErr } = await asCaller.rpc("whatsapp_authorize", { p_quote: quoteId, p_recipient: String(body.number || "") });
    if (aErr || !ok || !ok.to) {
      const [status, msg] = authzFailure(String(aErr?.code || ""), String((aErr as { hint?: string } | null)?.hint || ""));
      return json({ error: msg }, status);
    }
    const to = String(ok.to);

    // ---- recipient binding the studio cannot edit (audit run-3) -------------------
    // service role from here on: reads of opt-out / opt-in / plan state, then the log.
    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const orgId = String((q as any).org_id || "");
    if (!UUID_RE.test(orgId)) return json({ error: "could not check the event" }, 500);
    // 0179: no WhatsApp from a free-trial studio (service-role check, independent of the caller's RPC)
    if (await trialSendBlocked(admin, { org: orgId, quote: quoteId })) return json({ error: TRIAL_NO_SEND_MSG, trial: true }, 403);
    const digits = to.replace(/\D/g, "");
    const { data: optOut, error: ooErr } = await admin.from("whatsapp_opt_outs").select("id")
      .eq("phone", digits).eq("opted_out", true).or("org_id.is.null,org_id.eq." + orgId).limit(1).maybeSingle();
    if (ooErr) { console.error("opt-out lookup failed", errTag(ooErr)); return json({ error: "could not check the recipient" }, 500); }
    if (optOut) return json({ error: "this number has opted out of WhatsApp messages" }, 403);

    const { data: sub, error: subErr } = await admin.from("studio_subscriptions").select("status").eq("org_id", orgId).maybeSingle();
    if (subErr) { console.error("plan lookup failed", errTag(subErr)); return json({ error: "could not check the studio" }, 500); }
    let paid = !!sub && (sub as any).status === "active";
    if (!paid) {   // same rule as public._trial_paid: a current, not-voided payment
      const today = new Date().toISOString().slice(0, 10);
      const { data: pay, error: payErr } = await admin.from("subscription_payments").select("id")
        .eq("org_id", orgId).is("voided_at", null).or("period_end.is.null,period_end.gte." + today).limit(1).maybeSingle();
      if (payErr) { console.error("payment lookup failed", errTag(payErr)); return json({ error: "could not check the studio" }, 500); }
      paid = !!pay;
    }
    if (!paid || Deno.env.get("WHATSAPP_REQUIRE_OPTIN") === "1") {
      const { data: optIn, error: oiErr } = await admin.from("wa_proposal_optins").select("id")
        .eq("quote_id", quoteId).eq("org_id", orgId).eq("phone_e164", "+" + digits).eq("opted_in", true).limit(1).maybeSingle();
      if (oiErr) { console.error("opt-in lookup failed", errTag(oiErr)); return json({ error: "could not check the recipient" }, 500); }
      if (!optIn) return json({ error: "record the recipient's WhatsApp opt-in for this event first" }, 403);
    }
    // distinct recipients per studio per day (a first message to a number today counts once)
    const firstToday = (await durableHit("wa:seen:" + orgId + ":" + digits, 1, DAY_MS)) === 0;
    const caps: Array<[string, number, number]> = [];
    if (firstToday) caps.push(["wa:rcpt:" + orgId, paid ? envInt("WHATSAPP_DISTINCT_PER_DAY_PAID", 200) : envInt("WHATSAPP_DISTINCT_PER_DAY_UNPAID", 3), DAY_MS]);
    if (!paid) caps.push(["wa:unpaid:" + orgId, envInt("WHATSAPP_UNPAID_PER_DAY", 60), DAY_MS]);
    const capWait = caps.length ? await checkLimits(caps) : 0;
    if (capWait) {
      const r = json({ error: "WhatsApp daily limit reached for your studio — try again tomorrow" }, 429);
      r.headers.set("Retry-After", String(capWait));
      return r;
    }

    const r = await fetch(`${GRAPH}/${VER}/${encodeURIComponent(PHONE_ID)}/messages`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ messaging_product: "whatsapp", to, ...content }),
    });
    const out = await r.text();
    const sent = r.ok;
    if (!sent) console.error("whatsapp send failed", r.status);

    // log with the right channel (org_id is taken from the quote by the org_from_quote trigger)
    const kind = String(body.kind || (body.template ? "template" : "message")).slice(0, 40);
    const { error: logErr } = await admin.from("notifications").insert({
      quote_id: quoteId, channel: "whatsapp", recipient: to, kind, status: sent ? "sent" : "failed",
    });
    if (logErr) console.error("whatsapp log insert failed", errTag(logErr));

    if (!sent) return json({ error: "whatsapp send failed" }, 502);
    let id: string | null = null;
    try { id = JSON.parse(out)?.messages?.[0]?.id ?? null; } catch (_) { /* keep null */ }
    return json({ sent: true, id });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    return serverError(e);
  }
});
