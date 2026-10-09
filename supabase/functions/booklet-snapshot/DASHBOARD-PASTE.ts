// DASHBOARD-PASTE.ts - booklet-snapshot for setup from the Supabase WEBSITE (no terminal).
//
// HOW TO DEPLOY (Supabase Dashboard):
//   1. Edge Functions -> Deploy a new function -> Via editor.
//   2. Function name: booklet-snapshot   (exactly this name)
//   3. Delete the sample code, paste THIS WHOLE FILE, Deploy.
//   4. Function details / settings: turn OFF "Verify JWT" (the booklet page is signed out;
//      the database checks the booklet token instead).
//   5. Edge Functions -> Secrets: add HELM_BOOKLET_SNAPSHOT_ENABLED = true
//      (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically).
//
// Same behaviour as index.ts (kept in sync by test/label-modes.test.mjs), with the
// ../_shared helpers inlined. Rate limiting here is a simple in-memory per-IP limiter
// (per instance); the database also rate-limits per booklet token.
// ----------------------------------------------------------------------------
// booklet-snapshot - streams the 2D / 3D snapshot image of a client booklet (migration
// 0069, private bucket booklet-snapshots). SQL can't sign storage URLs, so the booklet
// page loads <img src=".../booklet-snapshot?t=<booklet token>&k=2d|3d|2d_none|3d_none|2d_names|3d_names">.
// DORMANT BY DEFAULT: unless HELM_BOOKLET_SNAPSHOT_ENABLED === "true" every request is 404.
//
// The database decides: booklet_snapshot_path(token, kind) (service role only) returns the
// storage path ONLY for a live, unexpired, unrevoked link whose share checklist shows that
// section, and rate-limits per token. Anything else -> 404 (no oracle). The path is
// re-checked against <uuid>/<uuid>/{2d|3d}.{png|jpg|webp} before the download.
// Responses are private, short-cached and never sniffed. Logs carry no token.
//
// Secrets / env: HELM_BOOKLET_SNAPSHOT_ENABLED, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected).
import { createClient } from "npm:@supabase/supabase-js@2.117.2";

// ---- inlined from ../_shared/cors.ts + ../_shared/limits.ts ----
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function errTag(e: unknown): string {
  const o = (e && typeof e === "object") ? e as Record<string, unknown> : {};
  return String(o.code || o.name || "error").slice(0, 40);
}
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0].trim();
  return (first || req.headers.get("x-real-ip") || req.headers.get("cf-connecting-ip") || "unknown").slice(0, 64);
}
const buckets = new Map<string, { n: number; reset: number }>();
// 0 = allowed, else seconds until the window resets
async function checkLimits(keys: Array<[string, number, number]>): Promise<number> {
  const now = Date.now(); let wait = 0;
  if (buckets.size > 10_000) buckets.clear();
  for (const [k, limit, windowMs] of keys) {
    let b = buckets.get(k);
    if (!b || b.reset <= now) { b = { n: 0, reset: now + windowMs }; buckets.set(k, b); }
    b.n++;
    if (b.n > limit) wait = Math.max(wait, Math.ceil((b.reset - now) / 1000));
  }
  return wait;
}
// ---- end inlined helpers ----

const PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(2d|3d)(_none|_names)?\.(png|jpg|webp)$/;
// 0083: 2d / 3d = numbered pictures; _none = no labels, _names = name tags
const KINDS = new Set(["2d", "3d", "2d_none", "3d_none", "2d_names", "3d_names"]);
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
const MAX = 3 * 1024 * 1024;
const notFound = () => new Response("not found", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  try {
    if (Deno.env.get("HELM_BOOKLET_SNAPSHOT_ENABLED") !== "true") return notFound();
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    const u = new URL(req.url);
    const token = u.searchParams.get("t") || "", kind = u.searchParams.get("k") || "";
    if (!UUID_RE.test(token) || !KINDS.has(kind)) return notFound();
    const wait = await checkLimits([["bsnap:ip:" + clientIp(req), 120, 60_000]]);
    if (wait) return new Response("too many requests", { status: 429, headers: { "Retry-After": String(wait) } });

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: path, error } = await admin.rpc("booklet_snapshot_path", { p_token: token, p_kind: kind });
    if (error) { console.error("booklet-snapshot: lookup failed", errTag(error)); return notFound(); }
    const p = typeof path === "string" ? path : "";
    if (!PATH.test(p) || !p.includes("/" + kind + ".")) return notFound();
    const { data: blob, error: dErr } = await admin.storage.from("booklet-snapshots").download(p);
    if (dErr || !blob) { if (dErr) console.error("booklet-snapshot: download failed", errTag(dErr)); return notFound(); }
    const buf = new Uint8Array(await blob.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX) return notFound();
    return new Response(buf, { status: 200, headers: {
      "Content-Type": TYPES[p.split(".").pop() || ""] || "application/octet-stream",
      "Cache-Control": "private, max-age=300", "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'", "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "cross-origin",
    } });
  } catch (e) {
    console.error("booklet-snapshot error", errTag(e));
    return notFound();
  }
});
