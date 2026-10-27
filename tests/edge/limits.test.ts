// Body-size cap (413 before parsing) + per-IP / per-identity rate limits on every
// Edge Function. No network: fetch throws if any provider call is attempted.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, loadHandler, post, resetSupaMock, supaLog } from "./harness.ts";
import {
  BodyTooLarge, DEFAULT_BODY_LIMIT, WEBHOOK_BODY_LIMIT, readBodyCapped, readJsonCapped,
  rateLimit, rateLimitAll, clientIp, _resetRateLimits,
} from "../../supabase/functions/_shared/limits.ts";

const F = "../../supabase/functions/";
const TOKEN = "a0000000-0000-4000-8000-0000000000aa";
const big = (n: number) => "x".repeat(n);
const noFetch = () => installFetch(() => { throw new Error("no fetch expected"); });

// a body stream with NO content-length (chunked) — the cap must still hold
function streamReq(bytes: number, headers: Record<string, string> = {}): Request {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) { if (sent >= bytes) return c.close(); const n = Math.min(4096, bytes - sent); sent += n; c.enqueue(new Uint8Array(n).fill(120)); },
  });
  return new Request("https://fn.local/", { method: "POST", headers, body });
}

Deno.test("limits: readBodyCapped accepts <= cap, rejects declared and streamed oversize", async () => {
  assertEquals(await readBodyCapped(new Request("https://x/", { method: "POST", body: "abc" })), "abc");
  assertEquals((await readBodyCapped(streamReq(DEFAULT_BODY_LIMIT))).length, DEFAULT_BODY_LIMIT);
  await assertRejects(() => readBodyCapped(streamReq(DEFAULT_BODY_LIMIT + 1)), BodyTooLarge);
  await assertRejects(() => readBodyCapped(new Request("https://x/", { method: "POST", body: "a", headers: { "content-length": "999999" } })), BodyTooLarge);
  await assertRejects(() => readBodyCapped(new Request("https://x/", { method: "POST", body: "a", headers: { "content-length": "abc" } })), BodyTooLarge);
  assertEquals(await readJsonCapped(new Request("https://x/", { method: "POST", body: "null" })), {});
  assertEquals(await readJsonCapped(new Request("https://x/", { method: "POST", body: "[1]" })), {});
  assert(WEBHOOK_BODY_LIMIT > DEFAULT_BODY_LIMIT);
});

Deno.test("limits: rateLimit fixed window, Retry-After, independent keys, reset after window", async () => {
  _resetRateLimits();
  const t0 = 1_000_000;
  for (let i = 0; i < 3; i++) assertEquals(await rateLimit("k", 3, 60_000, t0), 0);
  assertEquals(await rateLimit("k", 3, 60_000, t0 + 1000), 59);
  assertEquals(await rateLimit("other", 3, 60_000, t0), 0);
  assertEquals(await rateLimit("k", 3, 60_000, t0 + 60_000), 0);
  assert(await rateLimitAll([["a", 5, 1000], ["k", 1, 60_000]], t0 + 60_001) > 0);
  assertEquals(clientIp(new Request("https://x/", { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } })), "1.2.3.4");
});
Deno.test("limits (r31): a faked x-forwarded-for can't buy a fresh rate-limit bucket behind Cloudflare", async () => {
  _resetRateLimits();
  // Cloudflare sets cf-connecting-ip itself; the caller's own x-forwarded-for value stays first in the list
  const req = (fake: string) => new Request("https://x/", { headers: { "cf-connecting-ip": "203.0.113.7", "x-forwarded-for": fake + ", 203.0.113.7" } });
  assertEquals(clientIp(req("1.1.1.1")), "203.0.113.7");
  assertEquals(clientIp(req("9.9.9.9")), "203.0.113.7");
  const t0 = 2_000_000;
  for (let i = 0; i < 3; i++) assertEquals(await rateLimit("ip:" + clientIp(req("10.0.0." + i)), 3, 60_000, t0), 0);
  assert(await rateLimit("ip:" + clientIp(req("10.0.0.99")), 3, 60_000, t0) > 0, "a 4th call with yet another fake hop is still limited");
  // no Cloudflare header (local dev / tests): unchanged fallback order
  assertEquals(clientIp(new Request("https://x/", { headers: { "x-real-ip": "5.6.7.8" } })), "5.6.7.8");
  assertEquals(clientIp(new Request("https://x/")), "unknown");
});

const JSON_FNS: Array<[string, Record<string, string>]> = [
  ["send-otp", { SUPABASE_URL: "https://p.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "s" }],
  ["create-payment-link", { SUPABASE_URL: "https://p.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "s", RAZORPAY_KEY_ID: "k", RAZORPAY_KEY_SECRET: "s" }],
  ["send-whatsapp", { SUPABASE_URL: "https://p.supabase.co", SUPABASE_ANON_KEY: "anon", WHATSAPP_TOKEN: "t", WHATSAPP_PHONE_ID: "1" }],
];
for (const [fn, env] of JSON_FNS) {
  Deno.test(`${fn}: oversize body -> 413 before parsing / auth / DB, no provider call`, async () => {
    resetSupaMock();
    const rEnv = setEnv(env), rF = noFetch();
    try {
      const h = await loadHandler(F + fn + "/index.ts");
      const r = await h(post({ token: TOKEN, phone: "9800000001", pad: big(DEFAULT_BODY_LIMIT) }, { authorization: "Bearer user-jwt" }));
      assertEquals(r.status, 413);
      assertEquals((await h(streamReq(DEFAULT_BODY_LIMIT + 10, { "content-type": "application/json" }))).status, 413);
      assertEquals(supaLog().length, 0);
    } finally { rF(); rEnv(); }
  });
}

Deno.test("send-otp: per-IP limit -> 429 with Retry-After; per-token limit across IPs", async () => {
  resetSupaMock();
  const rEnv = setEnv(JSON_FNS[0][1]), rF = noFetch();
  try {
    const h = await loadHandler(F + "send-otp/index.ts");
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) codes.push((await h(post({}, { "x-forwarded-for": "9.9.9.9" }))).status);
    assertEquals(codes.slice(0, 10).every((c) => c === 400), true);
    const last = await h(post({}, { "x-forwarded-for": "9.9.9.9" }));
    assertEquals(last.status, 429);
    assert(Number(last.headers.get("retry-after")) > 0);
    // same approval token from many IPs: identity limit (5/min) trips
    const tok: number[] = [];
    for (let i = 0; i < 6; i++) tok.push((await h(post({ token: "bad-token", phone: "x" }, { "x-forwarded-for": "8.8.8." + i }))).status);
    assertEquals(tok[5], 429);
    assert(tok.slice(0, 5).every((c) => c !== 429));
  } finally { rF(); rEnv(); }
});

Deno.test("create-payment-link: per-IP limit -> 429", async () => {
  resetSupaMock();
  const rEnv = setEnv(JSON_FNS[1][1]), rF = noFetch();
  try {
    const h = await loadHandler(F + "create-payment-link/index.ts");
    let s = 0;
    for (let i = 0; i < 31; i++) s = (await h(post({}, { "x-forwarded-for": "7.7.7.7" }))).status;
    assertEquals(s, 429);
  } finally { rF(); rEnv(); }
});

Deno.test("webhooks: oversize -> 413 before the HMAC check; normal size still reaches it (401 unsigned)", async () => {
  resetSupaMock();
  const rEnv = setEnv({ SUPABASE_URL: "https://p.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "s", RAZORPAY_WEBHOOK_SECRET: "w",
    HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED: "true", RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET: "w" }), rF = noFetch();
  try {
    for (const fn of ["razorpay-webhook", "razorpay-subscription-webhook"]) {
      const h = await loadHandler(F + fn + "/index.ts");
      assertEquals((await h(post({ pad: big(WEBHOOK_BODY_LIMIT) }))).status, 413, fn);
      assertEquals((await h(post({ event: "x" }))).status, 401, fn);
    }
  } finally { rF(); rEnv(); }
});

Deno.test("billing-reminder: oversize -> 413, per-IP limit -> 429 (before the secret check)", async () => {
  resetSupaMock();
  const rEnv = setEnv({ HELM_BILLING_REMINDERS_ENABLED: "true", HELM_BILLING_CRON_SECRET: "c" }), rF = noFetch();
  try {
    const h = await loadHandler(F + "billing-reminder/index.ts");
    assertEquals((await h(post({ pad: big(DEFAULT_BODY_LIMIT) }))).status, 413);
    let s = 0;
    for (let i = 0; i < 31; i++) s = (await h(post({}, { "x-forwarded-for": "6.6.6.6" }))).status;
    assertEquals(s, 429);
  } finally { rF(); rEnv(); }
});

// ---- durable (DB) limiter: public.rate_hit via the service role ----------------------
import { checkLimits, durableHit, bucketOf } from "../../supabase/functions/_shared/limits.ts";
const DUR_ENV = { SUPABASE_URL: "https://p.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc", HELM_DURABLE_RATE_LIMIT: "on" };
const g = globalThis as any;

Deno.test("durable: rate_hit called with service key, bucket + HASHED key, window seconds; its verdict is honoured", async () => {
  _resetRateLimits(); resetSupaMock();
  const rEnv = setEnv(DUR_ENV);
  const seen: any[] = [];
  g.__supaRpc = (name: string, args: any, key: string) => { seen.push([name, args, key]); return { data: seen.length >= 2 ? 17 : 0, error: null }; };
  try {
    assertEquals(await checkLimits([["otp:ip:1.2.3.4", 10, 60_000]]), 0);
    assertEquals(await checkLimits([["otp:ip:1.2.3.4", 10, 60_000]]), 17, "another isolate's hits count");
    assertEquals(seen[0][0], "rate_hit");
    assertEquals(seen[0][2], "svc");
    assertEquals(seen[0][1].p_bucket, "otp.ip");
    assertEquals(seen[0][1].p_window_s, 60);
    assertEquals(seen[0][1].p_max, 10);
    assert(!JSON.stringify(seen).includes("1.2.3.4"), "raw IP never sent");
  } finally { delete g.__supaRpc; rEnv(); }
});

Deno.test("durable: in-memory limit trips first without a DB round-trip", async () => {
  _resetRateLimits(); resetSupaMock();
  const rEnv = setEnv(DUR_ENV); let calls = 0;
  g.__supaRpc = () => { calls++; return { data: 0, error: null }; };
  try {
    for (let i = 0; i < 2; i++) assertEquals(await checkLimits([["x:ip:a", 2, 60_000]]), 0);
    assert(await checkLimits([["x:ip:a", 2, 60_000]]) > 0);
    assertEquals(calls, 2);
  } finally { delete g.__supaRpc; rEnv(); }
});

Deno.test("durable (r21): DB error fails CLOSED by default; a MISSING rate_hit fails open (loud); 'false' = open; 'true' = strict", async () => {
  _resetRateLimits(); resetSupaMock();
  const origErr = console.error; const logs: string[] = []; console.error = (m: string) => logs.push(String(m));
  let rEnv = setEnv(DUR_ENV);   // HELM_RATE_LIMIT_FAIL_CLOSED unset
  try {
    g.__supaRpc = () => { throw new Error("network"); };
    assertEquals(await durableHit("otp:tok:abc", 5, 60_000), 30, "default: network error -> 429");
    g.__supaRpc = () => ({ data: null, error: { code: "57014", message: "timeout" } });
    assertEquals(await durableHit("otp:tok:abc", 5, 60_000), 30, "default: statement timeout -> 429");
    assert(logs.some((l) => /failing CLOSED/.test(l)) && !logs.some((l) => l.includes("abc")));
    g.__supaRpc = () => ({ data: null, error: { code: "PGRST202", message: "not found" } });
    assertEquals(await durableHit("otp:tok:abc", 5, 60_000), 0, "default: rate_hit missing -> open");
    assert(logs.some((l) => /failing open \(rate_hit missing/.test(l)));
    rEnv(); rEnv = setEnv({ ...DUR_ENV, HELM_RATE_LIMIT_FAIL_CLOSED: "false" });
    g.__supaRpc = () => { throw new Error("network"); };
    assertEquals(await durableHit("otp:tok:abc", 5, 60_000), 0, "'false': open");
    rEnv(); rEnv = setEnv({ ...DUR_ENV, HELM_RATE_LIMIT_FAIL_CLOSED: "true" });
    assertEquals(await durableHit("otp:tok:abc", 5, 60_000), 30, "'true': closed");
    g.__supaRpc = () => ({ data: null, error: { code: "PGRST202", message: "not found" } });
    assertEquals(await durableHit("otp:tok:abc", 5, 60_000), 30, "'true': strict even when rate_hit is missing");
  } finally { console.error = origErr; delete g.__supaRpc; rEnv(); }
});

Deno.test("durable: off switch / no service role → no DB call", async () => {
  _resetRateLimits(); resetSupaMock(); let calls = 0;
  g.__supaRpc = () => { calls++; return { data: 99, error: null }; };
  let rEnv = setEnv({ ...DUR_ENV, HELM_DURABLE_RATE_LIMIT: "off" });
  try {
    assertEquals(await durableHit("a:b:c", 1, 1000), 0);
    rEnv(); rEnv = setEnv({ HELM_DURABLE_RATE_LIMIT: "on" });
    assertEquals(await durableHit("a:b:c", 1, 1000), 0);
    assertEquals(calls, 0);
    assertEquals(bucketOf("wa:user:UUID"), "wa.user");
  } finally { delete g.__supaRpc; rEnv(); }
});

Deno.test("send-otp: durable limiter returns 429 from the DB verdict (cross-isolate)", async () => {
  resetSupaMock();
  const rEnv = setEnv({ ...JSON_FNS[0][1], HELM_DURABLE_RATE_LIMIT: "on" }), rF = noFetch();
  g.__supaRpc = (name: string) => name === "rate_hit" ? { data: 42, error: null } : { data: null, error: null };
  try {
    const h = await loadHandler(F + "send-otp/index.ts");
    const r = await h(post({ token: TOKEN, phone: "9800000001" }, { "x-forwarded-for": "5.5.5.5" }));
    assertEquals(r.status, 429);
    assertEquals(r.headers.get("retry-after"), "42");
  } finally { delete g.__supaRpc; rF(); rEnv(); }
});
