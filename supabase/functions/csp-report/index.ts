// csp-report - r21 monitoring: receives browser Content-Security-Policy violation reports.
// vercel.json / public/_headers (scripts/gen-csp.mjs) send `report-uri <prod>/functions/v1/csp-report` on every
// production page. A report is turned into ONE redacted log line (Supabase -> Edge Functions -> csp-report ->
// Logs): directive, blocked origin/path shape, page path shape - never a query string, token, UUID, e-mail,
// script sample or IP. Nothing is stored in the database. Always answers 204 (browsers ignore the body).
// Abuse: body capped at 16 KB, 30 reports / minute / IP (in-memory first, then the durable rate_hit), at most
// 10 violations logged per request. Off switch: HELM_CSP_REPORTS_ENABLED=false (still 204, logs nothing).
// Deploy: supabase functions deploy csp-report --no-verify-jwt   (browsers send reports without any auth)
import { responders } from "../_shared/cors.ts";
import { BodyTooLarge, checkLimits, clientIp, readBodyCapped } from "../_shared/limits.ts";
import { logLine, summarize } from "./logic.mjs";

Deno.serve(async (req) => {
  const { cors } = responders(req);
  const done = () => new Response(null, { status: 204, headers: cors });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: cors });
  if ((Deno.env.get("HELM_CSP_REPORTS_ENABLED") || "").toLowerCase() === "false") return done();
  const ct = (req.headers.get("content-type") || "").toLowerCase();
  if (!/^(application\/(csp-report|reports\+json|json))\b/.test(ct)) return new Response(null, { status: 415, headers: cors });
  try {
    const wait = await checkLimits([["csp:ip:" + clientIp(req), 30, 60_000]]);
    if (wait) return done();   // over the limit: drop quietly (a browser never retries a report)
    const raw = await readBodyCapped(req, 16 * 1024);
    for (const s of summarize(raw)) console.log(logLine(s));
    return done();
  } catch (e) {
    if (e instanceof BodyTooLarge) return new Response(null, { status: 413, headers: cors });
    console.error("csp-report: bad report");
    return done();
  }
});
