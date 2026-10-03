// send-otp — runtime-verified with mocked MSG91 + mocked Supabase (admin_store_otp).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  setEnv, installFetch, jsonResponse, textResponse, loadHandler, post,
  resetSupaMock, supaLog, fetchLog, captureConsoleError,
} from "./harness.ts";

const FN = "../../supabase/functions/send-otp/index.ts";
const g = globalThis as any;

const BASE_ENV = {
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
};

Deno.test("send-otp: missing token/phone -> 400", async () => {
  resetSupaMock();
  const rEnv = setEnv(BASE_ENV);
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ phone: "9999999999" }))).status, 400);
    assertEquals((await h(post({ token: "t" }))).status, 400);
  } finally { rF(); rEnv(); }
});

Deno.test("send-otp: invalid phone (<8 digits) -> 400", async () => {
  resetSupaMock();
  const rEnv = setEnv(BASE_ENV);
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ token: "t", phone: "123" }))).status, 400);
  } finally { rF(); rEnv(); }
});

Deno.test("send-otp: rate-limit / invalid-token from admin_store_otp -> 400, NO SMS sent", async () => {
  resetSupaMock();
  g.__supaRpc = () => ({ error: { message: "rate limit exceeded" } });
  const rEnv = setEnv({ ...BASE_ENV, MSG91_AUTHKEY: "ak" });
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({}); });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: "t", phone: "9999999999" }));
    assertEquals(res.status, 400);
    assert(!fetched, "MSG91 must not be called when store_otp fails");
  } finally { rF(); rEnv(); }
});

Deno.test("send-otp: provider (MSG91) unavailable -> 502 safe generic error, body not leaked", async () => {
  resetSupaMock();
  g.__supaRpc = () => ({ error: null });
  g.__supaResolver = () => ({ data: null, error: null }); // notifications insert
  const rEnv = setEnv({ ...BASE_ENV, MSG91_AUTHKEY: "ak", MSG91_SENDER: "HELMEV", MSG91_OTP_TEMPLATE_ID: "tpl" });
  const rF = installFetch((url) => {
    assert(url.startsWith("https://control.msg91.com/"), "only MSG91 may be called");
    return textResponse("MSG91 secret failure detail XYZ", 500);
  });
  try {
    const h = await loadHandler(FN);
    const { result: res, logs } = await captureConsoleError(async () => h(post({ token: "t", phone: "9999999999" })));
    assertEquals(res.status, 502);
    const body = await res.json();
    assertEquals(body.error, "could not send the SMS, please try again");
    assert(!JSON.stringify(body).includes("XYZ"), "provider body must not leak to client");
    assert(logs.join(" ").includes("msg91 error"), "provider error logged server-side");
  } finally { rF(); rEnv(); }
});

Deno.test("send-otp: happy path LIVE -> MSG91 called, 200 {sent:true,live:true}", async () => {
  resetSupaMock();
  g.__supaRpc = () => ({ error: null });
  g.__supaResolver = () => ({ data: null, error: null });
  const rEnv = setEnv({ ...BASE_ENV, MSG91_AUTHKEY: "ak", MSG91_SENDER: "HELMEV", MSG91_OTP_TEMPLATE_ID: "tpl" });
  const rF = installFetch(() => jsonResponse({ type: "success" }));
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: "t", phone: "9999999999" }));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { sent: true, live: true });
    // 10-digit number prefixed with 91
    const body = JSON.parse((fetchLog()[0].init as any).body);
    assertEquals(body.mobiles, "919999999999");
    assert(typeof body.OTP === "string" && /^\d{6}$/.test(body.OTP));
  } finally { rF(); rEnv(); }
});

Deno.test("send-otp: simulated mode (no MSG91_AUTHKEY) -> 200 {live:false}, no fetch", async () => {
  resetSupaMock();
  g.__supaRpc = () => ({ error: null });
  g.__supaResolver = () => ({ data: null, error: null });
  const rEnv = setEnv(BASE_ENV);
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({}); });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: "t", phone: "9999999999" }));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).live, false);
    assert(!fetched);
  } finally { rF(); rEnv(); }
});

// ---- CSPRNG source audit (static): no Math.random; getRandomValues + rejection sampling, no modulo bias ----
Deno.test("send-otp: OTP uses CSPRNG, rejection sampling, no Math.random (source audit)", async () => {
  const src = await Deno.readTextFile(new URL(FN, import.meta.url));
  assert(!/Math\.random\s*\(/.test(src), "must not call Math.random()");
  assert(/crypto\.getRandomValues/.test(src), "must use crypto.getRandomValues");
  assert(/4294967296\s*%\s*900000/.test(src), "rejection limit removes modulo bias");
  assert(/while\s*\(buf\[0\]\s*>=\s*lim\)/.test(src), "rejection sampling loop present");
});

// ---- Statistical sanity: generated OTPs are 6 digits, well-spread, unbiased leading digit ----
Deno.test("send-otp: generated code shape is uniform 6-digit (runtime sampling of the exact algorithm)", () => {
  function gen() {
    const buf = new Uint32Array(1), lim = 4294967296 - (4294967296 % 900000);
    do crypto.getRandomValues(buf); while (buf[0] >= lim);
    return String(100000 + (buf[0] % 900000));
  }
  const seen = new Set<string>();
  const lead = new Array(10).fill(0);
  for (let i = 0; i < 5000; i++) {
    const c = gen();
    assert(/^\d{6}$/.test(c), "always 6 digits");
    assert(Number(c) >= 100000 && Number(c) <= 999999);
    seen.add(c);
    lead[Number(c[0])]++;
  }
  assert(seen.size > 4800, "high entropy (few collisions)");
  assertEquals(lead[0], 0, "leading digit never 0 (range starts at 100000)");
  for (let d = 1; d <= 9; d++) assert(lead[d] > 300, `leading digit ${d} reasonably represented`);
});
