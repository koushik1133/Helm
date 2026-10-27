// email-unsubscribe - public opt-out endpoint for NON-transactional Helm e-mail (0165).
// Deploy with --no-verify-jwt (recipients are not signed in; the signed token is the proof).
//
//   POST ?t=<token>  body "List-Unsubscribe=One-Click"  -> RFC 8058 one-click from Gmail/Yahoo/etc.
//                    (no cookies, no redirect, answers 200; the token is HMAC-checked in the DB)
//   POST JSON { t, action: "status" | "unsubscribe" | "resubscribe" }  -> the /unsubscribe page
//   GET  ?t=<token>  -> 303 to APP_URL/unsubscribe?t=... (a GET never changes anything, so link
//                    scanners / previews cannot unsubscribe anyone)
// The token names one recipient + one sender (a studio, or Helm itself). A malformed or forged
// token gets { ok: false }. Logs never carry the token or the address.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
import { errTag, responders } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readBodyCapped, tooMany } from "../_shared/limits.ts";
import { appBase, UNSUB_TOKEN_RE } from "../_shared/email-compliance.mjs";

export const ONE_CLICK_RE = /(^|&)List-Unsubscribe=One-Click(&|$)/;

export async function handler(req: Request): Promise<Response> {
  const { cors, json } = responders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);
  const app = appBase(Deno.env.get("APP_URL"));
  try {
    if (req.method === "GET") {
      const t = String(url.searchParams.get("t") || "");
      const to = app + "/unsubscribe" + (UNSUB_TOKEN_RE.test(t) ? "?t=" + t : "");
      return new Response(null, { status: 303, headers: { Location: to, "Cache-Control": "no-store" } });
    }
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const wait = await checkLimits([["unsub:ip:" + clientIp(req), 30, 60_000]]);
    if (wait) return tooMany(json, wait);

    const raw = await readBodyCapped(req, 4096);
    const ctype = String(req.headers.get("content-type") || "").toLowerCase();
    let token = String(url.searchParams.get("t") || "");
    let action = "";
    let source = "link";
    if (ctype.includes("application/json")) {
      let b: any = {};
      try { b = JSON.parse(raw || "{}"); } catch (_) { return json({ error: "bad request" }, 400); }
      token = String(b?.t ?? token);
      action = String(b?.action ?? "");
    } else if (ONE_CLICK_RE.test(raw.trim()) || /List-Unsubscribe=One-Click/.test(raw)) {
      action = "unsubscribe"; source = "one_click";   // form-urlencoded or multipart one-click
    }
    if (!["status", "unsubscribe", "resubscribe"].includes(action)) return json({ error: "bad request" }, 400);
    if (!UNSUB_TOKEN_RE.test(token)) return json({ ok: false });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data, error } = action === "status"
      ? await admin.rpc("email_unsub_status", { p_token: token })
      : await admin.rpc("email_unsub_set", { p_token: token, p_opt_out: action === "unsubscribe", p_source: source });
    if (error) { console.error("email-unsubscribe: rpc failed", errTag(error)); return json({ error: "internal error" }, 500); }
    const d: any = data && typeof data === "object" ? data : { ok: false };
    if (source === "one_click") return new Response(d.ok ? "unsubscribed" : "invalid", { status: 200, headers: { ...cors, "Content-Type": "text/plain" } });
    return json({ ok: !!d.ok, sender: d.ok ? String(d.sender ?? "") : undefined, email: d.ok ? String(d.email ?? "") : undefined, opted_out: d.ok ? !!d.opted_out : undefined });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    console.error("email-unsubscribe error", errTag(e));
    return json({ error: "internal error" }, 500);
  }
}

Deno.serve(handler);
