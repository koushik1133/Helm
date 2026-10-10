// render-photo - turns the builder's layout pictures into an ultra-realistic event photograph
// with the OpenAI Images API (edits endpoint, GPT image model, several reference images).
// Migration 0095 (photo_render_begin / photo_renders / photo_render_usage).
//
// DORMANT BY DEFAULT: without the secret OPENAI_API_KEY every POST answers
//   503 {"error":"render_not_configured"}  and nothing else happens.
// The key lives ONLY in the function's secrets (supabase secrets set OPENAI_API_KEY=...);
// it never reaches the browser or the repository. Setup: docs/PHOTO-RENDER-SETUP.md.
//
// Request (POST, JSON, signed-in staff JWT):
//   { quote_id, prompt, n (1-4), quality "standard"|"high", size "1536x1024"|"1024x1024"|"1024x1536",
//     style, camera, theme, images: [{ mime: "image/jpeg"|"image/png", data: base64 }] (1-3, <= 2 MB each) }
// Who may: photo_render_begin runs AS THE CALLER - signed in, staff of the event's studio, quotes EDIT
// + photo_render EDIT, studio writable, renders switched on, hourly limit + monthly quota.
// The photos are stored in the database (photo_renders, like the 0083 booklet pictures - no
// public bucket). ASYNC: the answer is 202 { job_id, status:"pending", used, quota } at once; the
// browser polls photo_render_job(job_id) and loads each photo with photo_render_image. Every request is logged in photo_render_usage
// (studio, user, event, model, size, quality, n, status, cost estimate) for billing.
//
// Secrets / env: OPENAI_API_KEY (switches it on), OPENAI_IMAGE_MODEL (default gpt-image-2.5-sunburst),
//   RENDER_TIMEOUT_MS (default 140000; max 380000 on paid plans), RENDER_COST_USD_LOW / _MEDIUM / _HIGH (per image estimate),
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY (injected).
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { bearer, errTag, responders, UUID_RE } from "../_shared/cors.ts";
import { BodyTooLarge, clientIp, checkLimits, readJsonCapped, tooMany } from "../_shared/limits.ts";

const OPENAI_EDITS = "https://api.openai.com/v1/images/edits";
const BODY_LIMIT = 8 * 1024 * 1024;           // three reference pictures + prompt
const IMG_LIMIT = 2 * 1024 * 1024;            // per reference picture (decoded)
const OUT_LIMIT = 6 * 1024 * 1024;            // per photo stored (photo_renders_bytes_ck)
const SIZES = new Set(["1536x1024", "1024x1024", "1024x1536"]);
const MODEL_RE = /^[a-z0-9.-]{1,60}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function b64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function sniff(b: Uint8Array): string {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return "";
}
function costPer(quality: string): number {
  const d: Record<string, number> = { low: 0.02, medium: 0.07, high: 0.25 };
  const v = Number(Deno.env.get("RENDER_COST_USD_" + quality.toUpperCase()));
  return isFinite(v) && v >= 0 ? v : d[quality] ?? 0.25;
}
const clip = (v: unknown, n: number) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

export function notConfigured(): boolean { return !(Deno.env.get("OPENAI_API_KEY") || "").trim(); }

Deno.serve(async (req) => {
  const { cors, json, serverError } = responders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  // dormant until the owner sets the secret
  if (notConfigured()) return json({ error: "render_not_configured" }, 503);
  // deno-lint-ignore no-explicit-any
  let admin: any = null, usageId = "";
  try {
    const ipWait = await checkLimits([["rp:ip:" + clientIp(req), 20, 60_000]]);
    if (ipWait) return tooMany(json, ipWait);
    const body: any = await readJsonCapped(req, BODY_LIMIT);

    const url = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
    const jwt = bearer(req);
    if (!jwt || !anonKey || jwt === anonKey) return json({ error: "sign in as a staff user" }, 401);
    const asCaller = createClient(url, anonKey, {
      global: { headers: { Authorization: "Bearer " + jwt } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: { user } } = await asCaller.auth.getUser(jwt);
    if (!user) return json({ error: "sign in as a staff user" }, 401);
    const userWait = await checkLimits([["rp:user:" + user.id, 6, 60_000]]);
    if (userWait) return tooMany(json, userWait);

    // ---- validate ----
    const quoteId = String(body.quote_id || "");
    if (!UUID_RE.test(quoteId)) return json({ error: "quote_id is required" }, 400);
    const prompt = String(body.prompt || "").slice(0, 30000);
    if (prompt.trim().length < 40) return json({ error: "prompt is required" }, 400);
    const n = Math.round(Number(body.n) || 1);
    if (n < 1 || n > 4) return json({ error: "number of images must be 1 to 4" }, 400);
    const quality = body.quality === "high" ? "high" : "medium";
    const size = SIZES.has(String(body.size)) ? String(body.size) : "1536x1024";
    const model = (Deno.env.get("OPENAI_IMAGE_MODEL") || "gpt-image-2.5-sunburst").trim();
    if (!MODEL_RE.test(model)) return json({ error: "render_not_configured" }, 503);
    const imgs = Array.isArray(body.images) ? body.images : [];
    if (imgs.length < 1 || imgs.length > 3) return json({ error: "send 1 to 3 reference pictures" }, 400);
    const files: Blob[] = [];
    for (const im of imgs) {
      const data = String(im?.data || "");
      if (!data || data.length > Math.ceil(IMG_LIMIT * 4 / 3) + 4 || !B64_RE.test(data)) return json({ error: "a reference picture is too large or invalid" }, 413);
      let b: Uint8Array<ArrayBuffer>;
      try { b = b64ToBytes(data); } catch { return json({ error: "a reference picture is invalid" }, 400); }
      const mime = sniff(b);
      if (!mime) return json({ error: "reference pictures must be JPEG, PNG or WebP" }, 400);
      files.push(new Blob([b], { type: mime }));
    }

    // ---- who may + quota (as the caller) ----
    const cost = Math.round(costPer(quality) * n * 10000) / 10000;
    const { data: begin, error: bErr } = await asCaller.rpc("photo_render_begin", {
      p_quote_id: quoteId, p_n: n, p_quality: quality, p_size: size, p_model: model, p_cost: cost,
    });
    if (bErr || !begin?.usage_id) {
      const hint = String((bErr as any)?.hint || ""), code = String((bErr as any)?.code || "");
      if (hint === "render_quota") return json({ error: "render_quota", message: String(bErr?.message || "monthly quota reached") }, 429);
      if (hint === "render_rate_limited") return json({ error: "render_rate_limited", message: String(bErr?.message || "too many renders") }, 429);
      if (hint === "render_disabled") return json({ error: "render_disabled", message: "Photo renders are switched off for your studio" }, 403);
      if (code === "42501") return json({ error: "not_allowed", message: "You don't have permission to make photo renders for this event" }, 403);
      if (code === "P0002") return json({ error: "not_found", message: "Event not found" }, 404);
      if (code === "22023") return json({ error: "bad_request", message: String(bErr?.message || "invalid request") }, 400);
      console.error("photo_render_begin failed", errTag(bErr));
      return json({ error: "could not start the render" }, 500);
    }
    usageId = String(begin.usage_id);
    const orgId = String(begin.org_id);
    admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
    const finish = async (status: "ok" | "error", error?: string, realCost?: number) => {
      const patch: Record<string, unknown> = { status, finished_at: new Date().toISOString(), error: error ? error.slice(0, 200) : null };
      if (realCost != null) patch.cost_usd = realCost;
      const { error: e } = await admin!.from("photo_render_usage").update(patch).eq("id", usageId);
      if (e) console.error("usage update failed", errTag(e));
    };

    // ---- OpenAI Images API: edits with several reference images ----
    // Verified against the official SDK (openai-node src/resources/images.ts + internal/uploads.ts):
    // POST /v1/images/edits, multipart; several reference images go as repeated "image[]" fields;
    // size 1024x1024 | 1536x1024 | 1024x1536 | auto; quality low | medium | high | auto (xhigh/max only on
    // the 2.5 models); output_format png | jpeg | webp + output_compression; n 1-10; GPT image models
    // always answer b64_json. Default model gpt-image-2.5-sunburst (OpenAI: "for workflows where editing
    // precision matters most"); override with OPENAI_IMAGE_MODEL (e.g. gpt-image-2.5-flare = faster).
    const fd = new FormData();
    fd.append("model", model);
    fd.append("prompt", prompt);
    fd.append("n", String(n));
    fd.append("size", size);
    fd.append("quality", quality);
    fd.append("output_format", "jpeg");
    fd.append("output_compression", "88");
    files.forEach((f, i) => fd.append("image[]", f, `reference-${i + 1}.${f.type === "image/png" ? "png" : f.type === "image/webp" ? "webp" : "jpg"}`));
    // ASYNC: a render can take up to ~2 minutes (OpenAI) and Supabase cuts a request that has not
    // answered within 150 s (request idle timeout). So the function answers 202 at once with the job id
    // (= the usage row) and keeps working in the background (EdgeRuntime.waitUntil, bounded by the
    // worker wall clock: 150 s Free / 400 s paid plans). The builder polls photo_render_job(job).
    // RENDER_TIMEOUT_MS default 140 s fits the Free plan; on a paid plan it may be raised to 380 s.
    const timeout = Math.min(380_000, Math.max(20_000, Number(Deno.env.get("RENDER_TIMEOUT_MS")) || 140_000));
    const meta = { style: clip(body.style, 40), camera: clip(body.camera, 40), theme: clip(body.theme, 200) };
    const work = async (): Promise<Array<{ id: string; mime: string; data: string }> | string> => {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeout);
        let r: Response;
        try {
          r = await fetch(OPENAI_EDITS, { method: "POST", headers: { Authorization: "Bearer " + Deno.env.get("OPENAI_API_KEY")!.trim() }, body: fd, signal: ac.signal });
        } catch (e) {
          clearTimeout(timer);
          const to = (e as Error)?.name === "AbortError";
          await finish("error", to ? "timeout" : "failed: network");
          return to ? "timeout" : "failed";
        }
        clearTimeout(timer);
        const out: any = await r.json().catch(() => ({}));
        if (!r.ok) {
          const oc = String(out?.error?.code || out?.error?.type || r.status).slice(0, 60);
          console.error("openai images error", r.status, oc);
          const kind = oc === "moderation_blocked" || oc.includes("safety") ? "blocked" : r.status === 429 ? "busy" : "failed";
          await finish("error", kind + ": openai " + r.status + " " + oc);
          return kind;
        }
        const renders: Array<{ id: string; mime: string; data: string }> = [];
        for (const d of Array.isArray(out?.data) ? out.data.slice(0, n) : []) {
          const b64 = String(d?.b64_json || "");
          if (!b64) continue;
          const bytes = b64ToBytes(b64);
          const mime = sniff(bytes);
          if (!mime || bytes.byteLength > OUT_LIMIT) continue;
          const { data: row, error: iErr } = await admin.from("photo_renders").insert({
            org_id: orgId, quote_id: quoteId, usage_id: usageId, created_by: user.id, ...meta,
            quality, model, size, prompt, mime, bytes: bytes.byteLength, data: "\\x" + Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join(""),
          }).select("id").single();
          if (iErr || !row) { console.error("render insert failed", errTag(iErr)); continue; }
          renders.push({ id: String(row.id), mime, data: b64 });
        }
        if (!renders.length) { await finish("error", "failed: no images"); return "failed"; }
        await finish("ok", undefined, Math.round(costPer(quality) * renders.length * 10000) / 10000);
        return renders;
      } catch (e) {
        console.error("render background failed", errTag(e));
        await finish("error", "failed: internal");
        return "failed";
      }
    };
    // deno-lint-ignore no-explicit-any
    const ER = (globalThis as any).EdgeRuntime;
    if (ER && typeof ER.waitUntil === "function") {
      ER.waitUntil(work());
      return json({ job_id: usageId, status: "pending", used: begin.used, quota: begin.quota }, 202);
    }
    // no background runtime (local tests): finish inline, same answer shape as a finished job
    const res = await work();
    if (typeof res === "string") return json({ error: "render_" + res, job_id: usageId }, res === "timeout" ? 504 : res === "blocked" ? 422 : res === "busy" ? 503 : 502);
    return json({ job_id: usageId, status: "ok", renders: res, used: begin.used, quota: begin.quota });
  } catch (e) {
    if (e instanceof BodyTooLarge) return json({ error: "request too large" }, 413);
    if (admin && usageId) { try { await admin.from("photo_render_usage").update({ status: "error", error: "internal", finished_at: new Date().toISOString() }).eq("id", usageId); } catch { /* ignore */ } }
    return serverError(e);
  }
});
