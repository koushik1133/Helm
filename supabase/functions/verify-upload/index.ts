// verify-upload — server-side verification of new Storage uploads (migration 0051).
// DORMANT BY DEFAULT: unless HELM_UPLOAD_SCAN_ENABLED === "true" every request is a no-op 200.
// Invoked ONLY by a Supabase Database Webhook (storage.objects INSERT) or a cron, presenting
// a shared secret. The request body is ignored except for its size: the function never
// trusts a bucket / path from the caller — it CLAIMS the next pending rows from the DB
// (upload_scan_claim, service role) and checks each object itself.
//
// For each pending object:
//   1. download it with the service role (stream capped at the bucket's size limit + 1)
//   2. magic bytes vs extension vs declared type vs the bucket allowlist (sniff.ts)
//   3. optional antivirus (HELM_AV_URL) — dormant unless set
//   4. upload_scan_mark(clean | rejected | retry). Rejected objects are hidden by RLS at once,
//      an 'upload.rejected' audit row is written, and the object is MOVED to the private
//      'upload-quarantine' bucket (HELM_UPLOAD_QUARANTINE=keep leaves it in place, hidden).
//      Nothing is hard-deleted.
//   Download / AV errors leave the row pending ('retry'); after 10 attempts it stays pending
//   (hidden from others once enforcement is on) for a human to look at.
//
// Secrets / env:
//   HELM_UPLOAD_SCAN_ENABLED="true"      turn it on (anything else → dormant no-op)
//   HELM_UPLOAD_SCAN_SECRET               shared secret; caller sends header x-helm-cron-secret.
//                                         Unset → every call 401.
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected)
//   UPLOAD_SCAN_BATCH                     objects per run, 1..50 (default 20)
//   HELM_UPLOAD_QUARANTINE                "move" (default) | "keep"
//   HELM_AV_URL                           optional https URL of a ClamAV-style REST scanner that
//                                         accepts POST of the raw bytes and answers JSON
//                                         ({infected:bool} or {status:"OK"|"FOUND"|"clean"|"infected"}).
//   HELM_AV_ALLOWED_HOSTS                 comma list; HELM_AV_URL's host MUST be in it, else AV is
//                                         treated as misconfigured and objects stay pending.
//   HELM_AV_TOKEN                         optional bearer token for the scanner
//   HELM_AV_TIMEOUT_MS                    1000..60000 (default 15000)
//
// Logs carry only counts, reasons and HTTP status — never object paths, owners or tokens.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { errTag } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, rateLimit, readBodyCapped, WEBHOOK_BODY_LIMIT } from "../_shared/limits.ts";
import { BUCKETS, verdict } from "./sniff.ts";

const enc = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_KEY = /^[A-Za-z0-9._\/-]{1,400}$/;

export async function secretMatches(given: string, expected: string): Promise<boolean> {
  if (!expected || !given) return false;
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ---- antivirus (optional) ---------------------------------------------------------------
export type AvResult = "clean" | "infected" | "error" | "off";

export function avConfig(): { url: URL; token: string; timeout: number } | null | "misconfigured" {
  const raw = (Deno.env.get("HELM_AV_URL") || "").trim();
  if (!raw) return null;                                            // dormant
  let u: URL;
  try { u = new URL(raw); } catch { return "misconfigured"; }
  const hosts = (Deno.env.get("HELM_AV_ALLOWED_HOSTS") || "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  if (u.protocol !== "https:" || u.username || u.password || !hosts.includes(u.hostname.toLowerCase())) return "misconfigured";
  const t = Number(Deno.env.get("HELM_AV_TIMEOUT_MS"));
  const timeout = Number.isFinite(t) && t > 0 ? Math.min(60_000, Math.max(1_000, t)) : 15_000;
  return { url: u, token: Deno.env.get("HELM_AV_TOKEN") || "", timeout };
}

export async function avScan(bytes: Uint8Array): Promise<AvResult> {
  const cfg = avConfig();
  if (cfg === null) return "off";
  if (cfg === "misconfigured") { console.error("verify-upload: AV misconfigured (https + allowlisted host required)"); return "error"; }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeout);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
    if (cfg.token) headers["Authorization"] = "Bearer " + cfg.token;
    const r = await fetch(cfg.url.toString(), { method: "POST", headers, body: bytes, signal: ctl.signal, redirect: "error" });
    const text = (await r.text()).slice(0, 4096);
    if (!r.ok) { console.error("verify-upload: AV status", r.status); return "error"; }
    let j: any = null;
    try { j = JSON.parse(text); } catch { return "error"; }
    if (j && j.infected === true) return "infected";
    if (j && j.infected === false) return "clean";
    const st = String((j && (j.status ?? j.Status ?? j.result)) ?? "").trim();
    if (/^(found|infected|virus|malicious)$/i.test(st)) return "infected";
    if (/^(ok|clean|passed)$/i.test(st)) return "clean";
    return "error";
  } catch (e) {
    console.error("verify-upload: AV error", errTag(e));
    return "error";
  } finally {
    clearTimeout(timer);
  }
}

// ---- storage I/O (service role, SUPABASE_URL host only) ----------------------------------
function storageUrl(path: string): string {
  const base = new URL(Deno.env.get("SUPABASE_URL") || "");
  if (base.protocol !== "https:" && base.hostname !== "localhost" && base.hostname !== "127.0.0.1") throw new Error("bad SUPABASE_URL");
  return base.origin + "/storage/v1/" + path;
}
const encKey = (k: string) => k.split("/").map(encodeURIComponent).join("/");

/** Download an object, reading at most `max + 1` bytes. */
export async function download(bucket: string, name: string, max: number): Promise<{ bytes: Uint8Array; size: number } | null> {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const r = await fetch(storageUrl("object/" + encodeURIComponent(bucket) + "/" + encKey(name)), {
    headers: { Authorization: "Bearer " + key, apikey: key }, redirect: "error",
  });
  if (!r.ok || !r.body) { try { await r.body?.cancel(); } catch { /* */ } console.error("verify-upload: download status", r.status); return null; }
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    chunks.push(value);
    if (size > max) { try { await reader.cancel(); } catch { /* */ } break; }
  }
  const bytes = new Uint8Array(Math.min(size, max + 1));
  let off = 0;
  for (const c of chunks) { const n = Math.min(c.byteLength, bytes.length - off); bytes.set(c.subarray(0, n), off); off += n; if (off >= bytes.length) break; }
  return { bytes, size };
}

async function quarantine(bucket: string, name: string): Promise<boolean> {
  if ((Deno.env.get("HELM_UPLOAD_QUARANTINE") || "move") === "keep") return true;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const r = await fetch(storageUrl("object/move"), {
    method: "POST", redirect: "error",
    headers: { Authorization: "Bearer " + key, apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ bucketId: bucket, sourceKey: name, destinationBucket: "upload-quarantine", destinationKey: bucket + "/" + name }),
  });
  await r.text();
  if (!r.ok) console.error("verify-upload: quarantine move status", r.status);
  return r.ok;   // a failed move still leaves the object hidden (status rejected)
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  try {
    if (Deno.env.get("HELM_UPLOAD_SCAN_ENABLED") !== "true") return json({ status: "dormant" });
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    const wait = await rateLimit("scan:ip:" + clientIp(req), 60, 60_000);
    if (wait) return new Response(JSON.stringify({ error: "too many requests" }), { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(wait) } });
    await readBodyCapped(req, WEBHOOK_BODY_LIMIT);        // webhook payload unused (never trusted)
    const ok = await secretMatches(req.headers.get("x-helm-cron-secret") || "", Deno.env.get("HELM_UPLOAD_SCAN_SECRET") || "");
    if (!ok) return json({ error: "unauthorized" }, 401);

    const batch = Math.min(50, Math.max(1, Number(Deno.env.get("UPLOAD_SCAN_BATCH")) || 20));
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const { data: rows, error } = await admin.rpc("upload_scan_claim", { p_limit: batch });
    if (error) { console.error("verify-upload: claim failed", errTag(error)); return json({ error: "internal error" }, 500); }

    const counts = { clean: 0, rejected: 0, retry: 0, invalid: 0 };
    const mark = async (id: string, status: string, reason: string, size: number | null) => {
      const { error: mErr } = await admin.rpc("upload_scan_mark", { p_object: id, p_status: status, p_reason: reason, p_size: size });
      if (mErr) { console.error("verify-upload: mark failed", errTag(mErr)); return false; }
      return true;
    };
    for (const r of (Array.isArray(rows) ? rows : [])) {
      const id = String(r?.object_id ?? ""), bucket = String(r?.bucket_id ?? ""), name = String(r?.name ?? "");
      const rule = BUCKETS[bucket];
      if (!UUID.test(id)) { counts.invalid++; continue; }
      if (!rule || !SAFE_KEY.test(name) || name.includes("..")) {
        if (await mark(id, "rejected", "invalid object key", null)) { counts.rejected++; if (rule) await quarantine(bucket, name); }
        continue;
      }
      let dl: { bytes: Uint8Array; size: number } | null = null;
      try { dl = await download(bucket, name, rule.max); } catch (e) { console.error("verify-upload: download error", errTag(e)); }
      if (!dl) { await mark(id, "retry", "download failed", null); counts.retry++; continue; }
      const v = verdict(bucket, name, dl.bytes.subarray(0, 16), dl.size, r?.mimetype ?? null);
      if (!v.ok) {
        console.log("verify-upload: rejected", bucket, v.reason);
        if (await mark(id, "rejected", v.reason, dl.size)) { counts.rejected++; await quarantine(bucket, name); }
        continue;
      }
      const av = await avScan(dl.bytes);
      if (av === "error") { await mark(id, "retry", "antivirus unavailable", dl.size); counts.retry++; continue; }
      if (av === "infected") {
        console.log("verify-upload: rejected", bucket, "antivirus");
        if (await mark(id, "rejected", "antivirus: infected", dl.size)) { counts.rejected++; await quarantine(bucket, name); }
        continue;
      }
      if (await mark(id, "clean", av === "clean" ? "magic+av ok" : "magic ok", dl.size)) counts.clean++;
    }
    console.log("verify-upload: run", JSON.stringify(counts));
    return json({ status: "ok", ...counts });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "payload too large" }, 413);
    console.error("verify-upload error", errTag(e));
    return json({ error: "internal error" }, 500);
  }
});
