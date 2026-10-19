// captcha-verify - r21 (0249): server-side Cloudflare Turnstile check for the RPC paths that the
// Supabase Auth CAPTCHA does not cover (today: checkout "Contact sales" -> request_plan_activation).
//
// Sign-up / sign-in / password reset are verified by Supabase Auth itself (Dashboard -> Authentication ->
// Attack Protection -> CAPTCHA, Turnstile secret) - this function is NOT used for them.
//
// Request (signed-in user JWT): POST { action: "sales", token: "<turnstile token>" }
// Answers:
//   200 { ok: true, configured: false }            TURNSTILE_SECRET_KEY not set -> fail OPEN (nothing to check
//                                                   against; the database switch rpc_captcha_required must stay off)
//   200 { ok: true, configured: true, recorded }    Cloudflare confirmed the token -> a one-use, 10-minute pass is
//                                                   recorded for THIS user (captcha_pass_record, service role)
//   403 { error, code: "captcha_failed" }           token rejected / wrong action / wrong hostname -> fail CLOSED
//   503 { error, code: "captcha_unavailable" }      Cloudflare unreachable while configured -> fail CLOSED
//   401 / 400 / 405 / 413 / 429                     not signed in / bad body / method / size / rate limit
// Secrets / env: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (injected),
//   TURNSTILE_SECRET_KEY (Cloudflare -> Turnstile -> the site -> Secret key; the SAME secret that is pasted into
//   Supabase Attack Protection), HELM_TURNSTILE_HOSTNAMES (optional, e.g. "www.helm.events,helm.events").
// Deploy: supabase functions deploy captcha-verify --no-verify-jwt   (the user JWT is verified here with getUser)
// Logs never carry the token, the secret, an IP or an e-mail.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { bearer, errTag, responders } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";
import { hostList, judge, SITEVERIFY_URL, validRequest, verifyForm } from "./logic.mjs";

const FAILED = "The security check failed - please try again.";

Deno.serve(async (req) => {
  const { cors, json, serverError } = responders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  try {
    const ip = clientIp(req);
    const ipWait = await checkLimits([["cap:ip:" + ip, 20, 60_000]]);
    if (ipWait) return tooMany(json, ipWait);
    const body: any = await readJsonCapped(req, 4 * 1024);
    const url = Deno.env.get("SUPABASE_URL") || "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const jwt = bearer(req);
    if (!url || !jwt || !anonKey || jwt === anonKey) return json({ error: "sign in first" }, 401);
    const asCaller = createClient(url, anonKey, {
      global: { headers: { Authorization: "Bearer " + jwt } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user } } = await asCaller.auth.getUser(jwt);
    if (!user) return json({ error: "sign in first" }, 401);
    const userWait = await checkLimits([["cap:user:" + user.id, 10, 10 * 60_000]]);
    if (userWait) return tooMany(json, userWait);

    const v = validRequest(body);
    if (!v.ok) return json({ error: v.error }, 400);

    const secret = Deno.env.get("TURNSTILE_SECRET_KEY") || "";
    if (!secret) return json({ ok: true, configured: false });   // not configured -> fail open (switch must be off)

    let answer: unknown = null;
    try {
      const r = await fetch(SITEVERIFY_URL, {
        method: "POST",
        body: verifyForm(secret, v.token, ip, crypto.randomUUID()),
        signal: AbortSignal.timeout(8000),
      });
      answer = r.ok ? await r.json() : null;
      if (!r.ok) console.error("captcha-verify: siteverify status", r.status);
    } catch (e) {
      console.error("captcha-verify: siteverify unreachable", errTag(e));
      return json({ error: "The security check couldn't be confirmed just now. Please try again.", code: "captcha_unavailable" }, 503);
    }
    if (answer === null) return json({ error: "The security check couldn't be confirmed just now. Please try again.", code: "captcha_unavailable" }, 503);
    const verdict = judge(answer, { action: v.action, hostnames: hostList(Deno.env.get("HELM_TURNSTILE_HOSTNAMES")) });
    if (!verdict.ok) { console.log("captcha-verify: refused", verdict.reason); return json({ error: FAILED, code: "captcha_failed" }, 403); }

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "", { auth: { persistSession: false } });
    const { error } = await admin.rpc("captcha_pass_record", { p_user: user.id, p_action: v.action });
    if (error) {
      // a database without 0249 has no captcha switch either: the request can go on
      if (String((error as any).code || "") === "PGRST202") return json({ ok: true, configured: true, recorded: false });
      console.error("captcha-verify: record failed", errTag(error));
      return json({ error: "internal error" }, 500);
    }
    return json({ ok: true, configured: true, recorded: true });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    return serverError(e);
  }
});
