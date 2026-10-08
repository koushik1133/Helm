// create-subscription-checkout — dormant mode, caller JWT, server-authoritative price,
// Razorpay plan amount check, decline vs validation vs security errors, attach + cancel.
// Mock-only: fetch throws on any URL a test did not allow; run without --allow-net.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, resetSupaMock, supaLog, fetchLog, captureConsoleError } from "./harness.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/create-subscription-checkout/index.ts";
const ORG = "c0000000-0000-4000-8000-0000000000c1";
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_ANON_KEY: "anon-key", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" };
const LIVE = { ...BASE, HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED: "true", RAZORPAY_KEY_ID: "rzp_test_KEY", RAZORPAY_KEY_SECRET: "rzp_secret_XYZ" };
const PREP = { org_id: ORG, total: 1180, currency: "INR", razorpay_plan_id: "plan_TEST123456", net: 1000, tax: 180 };

function req(body: unknown, jwt: string | null = "user-jwt") {
  const h: Record<string, string> = { "Content-Type": "application/json", Origin: "https://www.helm.events" };
  if (jwt) h.Authorization = "Bearer " + jwt;
  return new Request("https://fn.local/", { method: "POST", headers: h, body: JSON.stringify(body) });
}
function db(prepare: any = { data: PREP, error: null }, attach: any = { data: true, error: null }) {
  g.__supaGetUser = (jwt: string) => ({ data: { user: jwt === "user-jwt" ? { id: "u1" } : null } });
  g.__supaRpc = (name: string) => name === "my_checkout_prepare" ? prepare : name === "checkout_attach_subscription" ? attach : { data: null, error: null };
}
function rzp(o: { planAmount?: number; planStatus?: number; subStatus?: number; sub?: any } = {}) {
  return installFetch((url, init) => {
    if (url === "https://api.razorpay.com/v1/plans/plan_TEST123456")
      return jsonResponse({ id: "plan_TEST123456", item: { amount: o.planAmount ?? 118000, currency: "INR" } }, o.planStatus ?? 200);
    if (url === "https://api.razorpay.com/v1/subscriptions" && init?.method === "POST")
      return jsonResponse(o.sub ?? { id: "sub_NEW123456", short_url: "https://rzp.io/i/abc123" }, o.subStatus ?? 200);
    if (url.startsWith("https://api.razorpay.com/v1/subscriptions/") && url.endsWith("/cancel")) return jsonResponse({ ok: true });
    throw new Error("unexpected fetch " + url);
  });
}
const rpcs = () => supaLog().filter((l) => l.rpc).map((l) => l.rpc);

Deno.test("dormant by default: 503 {dormant}, nothing read or sent", async () => {
  resetSupaMock(); db();
  for (const env of [BASE, { ...BASE, HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED: "true" }, { ...LIVE, HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED: "1" },
                     { ...LIVE, RAZORPAY_KEY_SECRET: "" }]) {
    const r = setEnv(env); const f = rzp();
    try {
      const res = await (await loadHandler(FN))(req({ plan: "starter", interval: "monthly" }));
      assertEquals(res.status, 503);
      const j = await res.json(); assertEquals(j.dormant, true); assertEquals(j.kind, "dormant");
      assertEquals(fetchLog().length, 0); assertEquals(supaLog().length, 0);
    } finally { f(); r(); }
  }
});

Deno.test("no / anon / invalid JWT → 401 security (generic), no provider call", async () => {
  for (const jwt of [null, "anon-key", "forged"]) {
    resetSupaMock(); db(); const r = setEnv(LIVE); const f = rzp();
    try {
      const res = await (await loadHandler(FN))(req({ plan: "starter", interval: "monthly" }, jwt));
      assertEquals(res.status, 401);
      const j = await res.json(); assertEquals(j.kind, "security"); assert(!/jwt|token|anon/i.test(j.error));
      assertEquals(fetchLog().length, 0); assertEquals(rpcs().length, 0);
    } finally { f(); r(); }
  }
});

Deno.test("bad plan / interval → 400 validation before any RPC", async () => {
  for (const b of [{ plan: "../x", interval: "monthly" }, { plan: "starter", interval: "weekly" }, {}]) {
    resetSupaMock(); db(); const r = setEnv(LIVE); const f = rzp();
    try {
      const res = await (await loadHandler(FN))(req(b));
      assertEquals(res.status, 400); assertEquals((await res.json()).kind, "validation");
      assertEquals(rpcs().length, 0); assertEquals(fetchLog().length, 0);
    } finally { f(); r(); }
  }
});

Deno.test("prepare runs AS THE CALLER; not-admin → 403 generic; terms missing → 400 with message", async () => {
  resetSupaMock(); db({ data: null, error: { code: "42501", message: "not authorized" } });
  let r = setEnv(LIVE); let f = rzp();
  try {
    const res = await (await loadHandler(FN))(req({ plan: "starter", interval: "monthly" }));
    assertEquals(res.status, 403); const j = await res.json(); assertEquals(j.kind, "security");
    const cc = supaLog().filter((l) => "createClient" in l);
    assertEquals(cc[0].createClient, "anon-key"); assertEquals(cc[0].authHeader, "Bearer user-jwt");
    assertEquals(fetchLog().length, 0);
  } finally { f(); r(); }
  resetSupaMock(); db({ data: null, error: { code: "22023", message: "please accept the Terms of Service first" } });
  r = setEnv(LIVE); f = rzp();
  try {
    const res = await (await loadHandler(FN))(req({ plan: "starter", interval: "monthly" }));
    assertEquals(res.status, 400); const j = await res.json();
    assertEquals(j.kind, "validation"); assertEquals(j.error, "please accept the Terms of Service first");
  } finally { f(); r(); }
});

Deno.test("Razorpay plan amount ≠ server total → 409, no subscription created", async () => {
  resetSupaMock(); db(); const r = setEnv(LIVE); const f = rzp({ planAmount: 100000 });
  try {
    const res = await (await loadHandler(FN))(req({ plan: "starter", interval: "monthly" }));
    assertEquals(res.status, 409);
    assertEquals(fetchLog().map((x) => x.url), ["https://api.razorpay.com/v1/plans/plan_TEST123456"]);
    assert(!rpcs().includes("checkout_attach_subscription"));
  } finally { f(); r(); }
});

Deno.test("happy path: modal gets public key + subscription id only, org in notes, attached with the service role", async () => {
  resetSupaMock(); db(); const r = setEnv(LIVE); const f = rzp();
  try {
    const res = await (await loadHandler(FN))(req({ plan: "starter", interval: "yearly" }));
    assertEquals(res.status, 200);
    const j = await res.json();
    assertEquals(j, { key_id: "rzp_test_KEY", subscription_id: "sub_NEW123456" });
    assert(!JSON.stringify(j).includes("rzp_secret_XYZ"));
    const create = fetchLog().find((x) => x.url.endsWith("/v1/subscriptions"))!;
    const sent = JSON.parse(String(create.init!.body));
    assertEquals(sent.plan_id, "plan_TEST123456"); assertEquals(sent.notes.org_id, ORG); assertEquals(sent.total_count, 10);
    assertEquals((create.init!.headers as any).Authorization, "Basic " + btoa("rzp_test_KEY:rzp_secret_XYZ"));
    const att = supaLog().find((l) => l.rpc === "checkout_attach_subscription");
    assertEquals(att.key, "service-role-secret");
    assertEquals(att.args, { p_org: ORG, p_subscription_id: "sub_NEW123456", p_plan: "starter", p_interval: "yearly" });
  } finally { f(); r(); }
});

Deno.test("gateway refuses / returns a non-Razorpay URL → 502 declined", async () => {
  for (const o of [{ subStatus: 400, sub: { error: { code: "BAD_REQUEST_ERROR" } } }, { sub: { id: "evil<script>" } }]) {
    resetSupaMock(); db(); const r = setEnv(LIVE); const f = rzp(o);
    try {
      const res = await (await loadHandler(FN))(req({ plan: "starter", interval: "monthly" }));
      assertEquals(res.status, 502); assertEquals((await res.json()).kind, "declined");
      assert(!rpcs().includes("checkout_attach_subscription"));
    } finally { f(); r(); }
  }
});

Deno.test("attach fails → subscription cancelled at Razorpay, no link handed out; logs carry no secrets", async () => {
  resetSupaMock(); db(undefined, { data: false, error: null }); const r = setEnv(LIVE); const f = rzp();
  try {
    const { result: res, logs } = await captureConsoleError(async () => (await loadHandler(FN))(req({ plan: "starter", interval: "monthly" })));
    assertEquals(res.status, 409);
    const j = await res.json(); assert(!("subscription_id" in j));
    assert(fetchLog().some((x) => x.url.endsWith("/subscriptions/sub_NEW123456/cancel")));
    const all = logs.join("\n");
    for (const s of ["rzp_secret_XYZ", "service-role-secret", "user-jwt", ORG]) assert(!all.includes(s), "log leaked " + s);
  } finally { f(); r(); }
});

Deno.test("OPTIONS preflight + GET refused", async () => {
  resetSupaMock(); const r = setEnv(LIVE);
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(new Request("https://fn.local/", { method: "OPTIONS", headers: { Origin: "https://www.helm.events" } }))).status, 200);
    assertEquals((await h(new Request("https://fn.local/", { method: "GET" }))).status, 405);
  } finally { r(); }
});

async function sign(secret: string, raw: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function verifyDb(owner: string | null = ORG, mine: string | null = ORG) {
  g.__supaGetUser = (jwt: string) => ({ data: { user: jwt === "user-jwt" ? { id: "u1" } : null } });
  g.__supaRpc = (name: string) => name === "current_org_id" ? { data: mine, error: null } : { data: null, error: null };
  g.__supaResolver = (table: string) => table === "studio_subscriptions" ? { data: owner ? { org_id: owner } : null, error: null } : { data: null, error: null };
}
const vbody = async (secret = "rzp_secret_XYZ", sub = "sub_NEW123456") => ({ action: "verify", razorpay_payment_id: "pay_ABC123456",
  razorpay_subscription_id: sub, razorpay_signature: await sign(secret, "pay_ABC123456|" + sub) });

Deno.test("verify: valid HMAC for the caller's own subscription → verified; no money recorded", async () => {
  resetSupaMock(); verifyDb(); const r = setEnv(LIVE); const f = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const res = await (await loadHandler(FN))(req(await vbody()));
    assertEquals(res.status, 200); assertEquals(await res.json(), { verified: true });
    assert(!rpcs().includes("hq_settle_provider_payment") && !rpcs().includes("checkout_attach_subscription"));
  } finally { f(); r(); }
});

Deno.test("verify: wrong secret / tampered / malformed signature → 400 security (generic)", async () => {
  for (const b of [await vbody("other-secret"), { ...(await vbody()), razorpay_payment_id: "pay_ZZZ999999" }, { ...(await vbody()), razorpay_signature: "abc" }]) {
    resetSupaMock(); verifyDb(); const r = setEnv(LIVE); const f = installFetch(() => { throw new Error("no fetch expected"); });
    try {
      const res = await (await loadHandler(FN))(req(b));
      assertEquals(res.status, 400); const j = await res.json(); assertEquals(j.kind, "security"); assert(!/signature|hmac/i.test(j.error));
    } finally { f(); r(); }
  }
});

Deno.test("verify: another studio's subscription → 403 (Org A/B isolation)", async () => {
  resetSupaMock(); verifyDb("d0000000-0000-4000-8000-0000000000d1", ORG); const r = setEnv(LIVE);
  try {
    const res = await (await loadHandler(FN))(req(await vbody()));
    assertEquals(res.status, 403);
  } finally { r(); }
});

Deno.test("verify: dormant when disabled, even with a valid signature", async () => {
  resetSupaMock(); verifyDb(); const r = setEnv({ ...LIVE, HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED: "false" });
  try {
    const res = await (await loadHandler(FN))(req(await vbody()));
    assertEquals(res.status, 503); assertEquals(supaLog().length, 0);
  } finally { r(); }
});
