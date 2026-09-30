// Shared CORS + response helpers for the browser-called Edge Functions.
//
// CORS is an ALLOWLIST, not "*". The origin is echoed back only when it is one
// of Helm's own front-ends; otherwise Access-Control-Allow-Origin is omitted and
// the browser blocks the cross-origin read. `Vary: Origin` is always sent so a
// shared cache never serves one origin's CORS answer to another.
//
// Allowed by default:
//   https://helm.events, https://www.helm.events            (production)
//   https://helm-v01.vercel.app, https://helm-alpha-nine.vercel.app
//   https://helm-v01-<hash>-vk-hub.vercel.app               (Vercel previews)
// Overrides (Supabase secrets / env):
//   ALLOWED_ORIGINS="https://a.example,https://b.example"   — REPLACES the list
//                                                             above (preview regex kept)
//   ALLOW_LOCALHOST=1                                        — also allow http(s)://localhost
//                                                             and 127.0.0.1 on any port
// Server-to-server callers (razorpay-webhook) do not use CORS at all.

const DEFAULT_ORIGINS = [
  "https://helm.events",
  "https://www.helm.events",
  "https://helm-v01.vercel.app",
  "https://helm-alpha-nine.vercel.app",
];
const PREVIEW_ORIGIN = /^https:\/\/helm-v01-[a-z0-9-]+-vk-hub\.vercel\.app$/;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

function allowedList(): string[] {
  const env = (Deno.env.get("ALLOWED_ORIGINS") || "").trim();
  if (!env) return DEFAULT_ORIGINS;
  return env.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
}

export function isAllowedOrigin(origin: string | null): origin is string {
  if (!origin) return false;
  if (allowedList().includes(origin)) return true;
  if (PREVIEW_ORIGIN.test(origin)) return true;
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
  // Log the real error server-side; return a generic message to the caller so
  // internal details (SQL, provider responses) are not leaked to the browser.
  const serverError = (e: unknown) => {
    console.error(e);
    return json({ error: "internal error" }, 500);
  };
  return { cors, json, serverError };
}

// HTML-escape a value before interpolating it into an email body.
export const escHtml = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
