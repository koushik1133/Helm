// Shared CORS + response helpers for the browser-called Edge Functions.
//
// CORS is an EXACT ALLOWLIST, not "*" and not a pattern. The origin is echoed back
// only when it is one of Helm's own front-ends; otherwise Access-Control-Allow-Origin
// is omitted and the browser blocks the cross-origin read. `Vary: Origin` is always
// sent so a shared cache never serves one origin's CORS answer to another.
//
// Allowed by default:
//   https://helm.events, https://www.helm.events            (production)
//   https://helm-v01.vercel.app, https://helm-alpha-nine.vercel.app
// Overrides (Supabase secrets / env):
//   ALLOWED_ORIGINS="https://a.example,https://b.example"   — REPLACES the list above
//   EXTRA_ALLOWED_ORIGINS="https://helm-v01-abc123-vk-hub.vercel.app"
//                                                            — ADDS exact origins (e.g. one
//                                                              Vercel preview you are testing)
//   ALLOW_LOCALHOST=1                                        — also allow http(s)://localhost
//                                                             and 127.0.0.1 on any port
// Audit Phase 8: the old preview regex (helm-v01-*-vk-hub.vercel.app) was dropped —
// anyone can create a Vercel project whose *.vercel.app name matches such a pattern
// (e.g. a project literally named "helm-v01-x-vk-hub"), so patterns are never trusted.
// Server-to-server callers (razorpay-webhook) do not use CORS at all.

const DEFAULT_ORIGINS = [
  "https://helm.events",
  "https://www.helm.events",
  "https://helm-v01.vercel.app",
  "https://helm-alpha-nine.vercel.app",
];
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

function parseList(v: string | undefined): string[] {
  return String(v || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter((s) => /^https?:\/\/[^\s/]+$/.test(s));
}
function allowedList(): string[] {
  const env = (Deno.env.get("ALLOWED_ORIGINS") || "").trim();
  const base = env ? parseList(env) : DEFAULT_ORIGINS;
  return base.concat(parseList(Deno.env.get("EXTRA_ALLOWED_ORIGINS")));
}

export function isAllowedOrigin(origin: string | null): origin is string {
  if (!origin) return false;
  if (allowedList().includes(origin)) return true;
  if (Deno.env.get("ALLOW_LOCALHOST") === "1" && LOCAL_ORIGIN.test(origin)) return true;
  return false;
}

// CORS headers for THIS request (echo the origin only when allowed).
export function corsFor(req: Request): Record<string, string> {
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
  const origin = req.headers.get("origin");
  if (isAllowedOrigin(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

// Per-request responders bound to that request's CORS headers:
//   const { cors, json, serverError } = responders(req);
export function responders(req: Request) {
  const cors = corsFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
  // Log only a short, PII-free description server-side; return a generic message to
  // the caller so internal details (SQL, provider responses) never reach the browser.
  const serverError = (e: unknown) => {
    console.error("internal error:", errTag(e));
    return json({ error: "internal error" }, 500);
  };
  return { cors, json, serverError };
}

// A log-safe tag for an error: SQLSTATE / name only — never the message body, which
// can carry phone numbers, emails or provider payloads.
export function errTag(e: unknown): string {
  const o = (e && typeof e === "object") ? e as Record<string, unknown> : {};
  return String(o.code || o.name || "error").slice(0, 40);
}

// The caller's bearer token (user access token or the anon key), or "".
export function bearer(req: Request): string {
  return (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
}

// Digits with country code: Indian 10-digit / 0-prefixed → 91…, 00… → … (mirrors
// public.helm_norm_phone in 0027 so the Edge layer and the DB agree).
export function normPhone(p: unknown): string {
  const d = String(p ?? "").replace(/[^0-9]/g, "");
  if (/^[0-9]{10}$/.test(d)) return "91" + d;
  if (/^0[0-9]{10}$/.test(d)) return "91" + d.slice(1);
  if (/^00[0-9]{8,15}$/.test(d)) return d.slice(2);
  return d;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// HTML-escape a value before interpolating it into an email body.
export const escHtml = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
