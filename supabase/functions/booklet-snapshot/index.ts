// booklet-snapshot - streams the 2D / 3D snapshot image of a client booklet (migration
// 0069, private bucket booklet-snapshots). SQL can't sign storage URLs, so the booklet
// page loads <img src=".../booklet-snapshot?t=<booklet token>&k=2d|3d">.
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
import { errTag, UUID_RE } from "../_shared/cors.ts";
import { clientIp, checkLimits } from "../_shared/limits.ts";

const PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(2d|3d)\.(png|jpg|webp)$/;
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
const MAX = 3 * 1024 * 1024;
const notFound = () => new Response("not found", { status: 404, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  try {
    if (Deno.env.get("HELM_BOOKLET_SNAPSHOT_ENABLED") !== "true") return notFound();
    if (req.method !== "GET") return new Response("method not allowed", { status: 405 });
    const u = new URL(req.url);
    const token = u.searchParams.get("t") || "", kind = u.searchParams.get("k") || "";
    if (!UUID_RE.test(token) || (kind !== "2d" && kind !== "3d")) return notFound();
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
