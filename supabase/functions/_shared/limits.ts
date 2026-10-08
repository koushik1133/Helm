// Request-size cap + best-effort rate limiting for every Edge Function.
//
// readBodyCapped(req, max): rejects BEFORE parsing — a declared Content-Length over
// the cap is refused without reading; otherwise the stream is read chunk by chunk and
// abandoned the moment it passes the cap (a lying / missing Content-Length can't
// make us buffer more than `max` bytes).
//
// rateLimit(key, limit, windowMs): fixed-window counter in this isolate's memory.
// Edge isolates are short-lived and not shared, so this is a FIRST line (stops a
// single client hammering one warm isolate); the durable limits stay in the DB
// (admin_store_otp, per-studio WhatsApp quota). Keys are hashed so no raw IP /
// token / phone is kept in memory longer than needed.
//
// checkLimits(keys): the in-memory limiter FIRST, then the DURABLE limiter — the
// service-role-only RPC public.rate_hit(bucket, key, window_s, max) (migration 0050),
// shared by every isolate. Config (env):
//   HELM_DURABLE_RATE_LIMIT = "on" (default) | "off"
//   HELM_RATE_LIMIT_FAIL_CLOSED = "true" → a DB error refuses the request (429, 30 s);
//                                 default fail-OPEN (the in-memory limit still applied)
// Every DB error is logged (no key / IP in the log line).

import { createClient } from "npm:@supabase/supabase-js@2.117.2";

export const DEFAULT_BODY_LIMIT = 16 * 1024;     // browser-called functions
export const WEBHOOK_BODY_LIMIT = 64 * 1024;     // provider webhooks (Razorpay payloads are a few KB)

export class BodyTooLarge extends Error { constructor() { super("payload too large"); this.name = "BodyTooLarge"; } }

export async function readBodyCapped(req: Request, max = DEFAULT_BODY_LIMIT): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared.trim()) || Number(declared) > max)) throw new BodyTooLarge();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { try { await reader.cancel(); } catch { /* ignore */ } throw new BodyTooLarge(); }
    chunks.push(value);
  }
  const buf = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(buf);
}

// JSON body under the cap; {} for an empty / malformed body (callers validate fields).
export async function readJsonCapped(req: Request, max = DEFAULT_BODY_LIMIT): Promise<Record<string, unknown>> {
  const raw = await readBodyCapped(req, max);
  if (!raw) return {};
  try { const v = JSON.parse(raw); return v && typeof v === "object" && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

// Caller IP as seen by the Supabase edge (first x-forwarded-for hop), or "unknown".
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") || "";
  const first = xff.split(",")[0].trim();
  return (first || req.headers.get("x-real-ip") || req.headers.get("cf-connecting-ip") || "unknown").slice(0, 64);
}

type Bucket = { n: number; reset: number };
const buckets = new Map<string, Bucket>();
const MAX_KEYS = 10_000;

async function hashKey(k: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(k));
  return Array.from(new Uint8Array(d).slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

// Returns 0 when allowed, else the seconds until the window resets (Retry-After).
export async function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): Promise<number> {
  const k = await hashKey(key);
  let b = buckets.get(k);
  if (!b || b.reset <= now) {
    if (buckets.size >= MAX_KEYS) for (const [kk, bb] of buckets) if (bb.reset <= now) buckets.delete(kk);
    if (buckets.size >= MAX_KEYS) buckets.delete(buckets.keys().next().value!);
    b = { n: 0, reset: now + windowMs };
    buckets.set(k, b);
  }
  b.n++;
  return b.n > limit ? Math.max(1, Math.ceil((b.reset - now) / 1000)) : 0;
}

// Check several keys (e.g. per-IP AND per-identity); first non-zero wins.
export async function rateLimitAll(keys: Array<[string, number, number]>, now = Date.now()): Promise<number> {
  for (const [key, limit, windowMs] of keys) {
    const r = await rateLimit(key, limit, windowMs, now);
    if (r) return r;
  }
  return 0;
}

export function _resetRateLimits() { buckets.clear(); durableClient = null; durableClientFor = ""; }   // tests only

// ---- durable (DB) layer -------------------------------------------------------------
let durableClient: any = null, durableClientFor = "";
function envGet(k: string): string { try { return Deno.env.get(k) || ""; } catch { return ""; } }
export function durableEnabled(): boolean { return envGet("HELM_DURABLE_RATE_LIMIT").toLowerCase() !== "off"; }
function getDurableClient(): any {
  const url = envGet("SUPABASE_URL"), key = envGet("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  if (!durableClient || durableClientFor !== url + "|" + key) {
    durableClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    durableClientFor = url + "|" + key;
  }
  return durableClient;
}
// "otp:ip:1.2.3.4" → bucket "otp.ip" (the part the RPC validates; never the raw value)
export function bucketOf(key: string): string {
  const b = key.split(":").slice(0, 2).join(".").toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, 64);
  return b || "default";
}
// 0 = allowed, else Retry-After seconds. Fail-open on DB error unless configured closed.
export async function durableHit(key: string, limit: number, windowMs: number): Promise<number> {
  if (!durableEnabled()) return 0;
  const client = getDurableClient();
  if (!client) return 0;   // no service role in this environment → in-memory only
  const failClosed = envGet("HELM_RATE_LIMIT_FAIL_CLOSED") === "true";
  const bucket = bucketOf(key);
  try {
    const { data, error } = await client.rpc("rate_hit", {
      p_bucket: bucket, p_key: await hashKey(key),
      p_window_s: Math.max(1, Math.ceil(windowMs / 1000)), p_max: Math.max(1, Math.floor(limit)),
    });
    if (error) throw error;
    const n = Number(data);
    if (!Number.isFinite(n) || n < 0) throw new Error("rate_hit returned a non-number");
    return Math.ceil(n);
  } catch (e) {
    console.error("[limits] durable rate limit unavailable (" + bucket + "): " +
      String((e as any)?.code || (e as any)?.message || e).slice(0, 80) + (failClosed ? " — failing CLOSED" : " — failing open"));
    return failClosed ? 30 : 0;
  }
}
// In-memory first (cheap, stops a hammering client without a DB round-trip), then durable.
export async function checkLimits(keys: Array<[string, number, number]>): Promise<number> {
  const mem = await rateLimitAll(keys);
  if (mem) return mem;
  for (const [key, limit, windowMs] of keys) {
    const r = await durableHit(key, limit, windowMs);
    if (r) return r;
  }
  return 0;
}

// 429 through the function's own CORS-aware json() responder, with Retry-After.
export function tooMany(json: (b: unknown, s?: number) => Response, retryAfter: number): Response {
  const r = json({ error: "too many requests — please try again later" }, 429);
  r.headers.set("Retry-After", String(retryAfter));
  return r;
}
