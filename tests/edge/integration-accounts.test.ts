// 0117 integration readiness — per-studio Razorpay creds (fallback to env), per-studio
// webhook secret + org cross-check, idempotent non-settle events, and the dormant
// wa-webhook (verify token GET, X-Hub-Signature-256 POST, statuses + opt-outs).
// Everything is mocked: no network, no DB.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, post, resetSupaMock, supaLog } from "./harness.ts";

const g = globalThis as any;
const CPL = "../../supabase/functions/create-payment-link/index.ts";
const RZW = "../../supabase/functions/razorpay-webhook/index.ts";
const WAW = "../../supabase/functions/wa-webhook/index.ts";
const TOKEN = "a0000000-0000-4000-8000-0000000000aa";
const ORG = "b0000000-0000-4000-8000-0000000000b1";
const QUOTE = "a0000000-0000-4000-8000-00000000da01";
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" };
const CREATE = { action: "create", payment_id: "11111111-1111-4111-8111-111111111111", quote_id: QUOTE, code: "A-0001",
  amount: 1000, expire_by: 1900000000, supersede: [], client: {} };

async function hmac(secret: string, raw: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const rzpReq = async (body: unknown, secret: string, qs = "", headers: Record<string, string> = {}) => {
  const raw = JSON.stringify(body);
  return new Request("https://fn.local/" + qs, { method: "POST", headers: { "x-razorpay-signature": await hmac(secret, raw), ...headers }, body: raw });
};

function cplDb(creds: unknown) {
  g.__supaResolver = (table: string) => table === "quotes" ? { data: { currency: "INR", org_id: ORG, pricing: {} }, error: null } : { data: null, error: null };
  g.__supaRpc = (name: string) => {
    if (name === "org_razorpay_creds") return creds as any;
    if (name === "payment_link_begin") return { data: CREATE, error: null };
    if (name === "payment_link_attach") return { data: true, error: null };
    return { data: null, error: null };
  };
}
function authOf(): string { return String((g.__fetchLog[0].init.headers as any).Authorization); }

Deno.test("cpl: connected studio account -> link created with the STUDIO's keys", async () => {
  resetSupaMock(); cplDb({ data: { key_id: "rzp_test_STUDIO1", key_secret: "studiosecret1" }, error: null });
  const rEnv = setEnv({ ...BASE, RAZORPAY_KEY_ID: "rzp_test_GLOBAL", RAZORPAY_KEY_SECRET: "globalsecret" });
  const rF = installFetch(() => jsonResponse({ id: "plink_S1", short_url: "https://rzp.io/i/s1" }));
  try {
    const res = await (await loadHandler(CPL))(post({ token: TOKEN }));
    assertEquals(res.status, 200);
    assertEquals(authOf(), "Basic " + btoa("rzp_test_STUDIO1:studiosecret1"));
    assert(supaLog().some((e) => e.rpc === "org_razorpay_creds" && (e.args as any).p_org === ORG));
  } finally { rF(); rEnv(); }
});

Deno.test("cpl: no studio account -> falls back to the global env keys (unchanged behaviour)", async () => {
  resetSupaMock(); cplDb({ data: null, error: null });
  const rEnv = setEnv({ ...BASE, RAZORPAY_KEY_ID: "rzp_test_GLOBAL", RAZORPAY_KEY_SECRET: "globalsecret" });
  const rF = installFetch(() => jsonResponse({ id: "plink_G1", short_url: "https://rzp.io/i/g1" }));
  try {
    assertEquals((await (await loadHandler(CPL))(post({ token: TOKEN }))).status, 200);
    assertEquals(authOf(), "Basic " + btoa("rzp_test_GLOBAL:globalsecret"));
  } finally { rF(); rEnv(); }
});

Deno.test("cpl: creds lookup error (0117 not applied) -> still falls back to env", async () => {
  resetSupaMock(); cplDb({ data: null, error: { code: "42883", message: "function does not exist" } });
  const rEnv = setEnv({ ...BASE, RAZORPAY_KEY_ID: "rzp_test_GLOBAL", RAZORPAY_KEY_SECRET: "globalsecret" });
  const rF = installFetch(() => jsonResponse({ id: "plink_G2", short_url: "https://rzp.io/i/g2" }));
  try { assertEquals((await (await loadHandler(CPL))(post({ token: TOKEN }))).status, 200); } finally { rF(); rEnv(); }
});

Deno.test("cpl: RAZORPAY_REQUIRE_STUDIO_ACCOUNT=1 + no studio account -> 503, nothing reserved", async () => {
  resetSupaMock(); cplDb({ data: null, error: null });
  const rEnv = setEnv({ ...BASE, RAZORPAY_KEY_ID: "rzp_test_GLOBAL", RAZORPAY_KEY_SECRET: "globalsecret", RAZORPAY_REQUIRE_STUDIO_ACCOUNT: "1" });
  const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    assertEquals((await (await loadHandler(CPL))(post({ token: TOKEN }))).status, 503);
    assert(!supaLog().some((e) => e.rpc === "payment_link_begin"));
  } finally { rF(); rEnv(); }
});

Deno.test("cpl: no studio account and no env keys -> 503", async () => {
  resetSupaMock(); cplDb({ data: null, error: null });
  const rEnv = setEnv({ ...BASE });
  const rF = installFetch(() => { throw new Error("no fetch"); });
  try { assertEquals((await (await loadHandler(CPL))(post({ token: TOKEN }))).status, 503); } finally { rF(); rEnv(); }
});

// ---- razorpay-webhook --------------------------------------------------------------------
const PAID = { event: "payment_link.paid", payload: { payment_link: { entity: { id: "plink_A1", amount_paid: 100000, notes: { quote_id: QUOTE } } }, payment: { entity: { id: "pay_A1", amount: 100000 } } } };
function rzDb(opts: { creds?: unknown; settle?: unknown; record?: unknown }) {
  g.__supaRpc = (name: string) => {
    if (name === "org_razorpay_creds") return opts.creds ?? { data: null, error: null };
    if (name === "razorpay_settle_for_org" || name === "razorpay_settle") return opts.settle ?? { data: { result: "replay" }, error: null };
    if (name === "razorpay_record_event") return opts.record ?? { data: { result: "recorded" }, error: null };
    return { data: null, error: null };
  };
  g.__supaResolver = () => ({ data: null, error: null });
}

Deno.test("rzp webhook ?org=: verified with the STUDIO's secret, settled via razorpay_settle_for_org", async () => {
  resetSupaMock(); rzDb({ creds: { data: { webhook_secret: "studio_whsec" }, error: null } });
  const rEnv = setEnv({ ...BASE, RAZORPAY_WEBHOOK_SECRET: "global_whsec" });
  const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(RZW);
    assertEquals((await h(await rzpReq(PAID, "global_whsec", "?org=" + ORG))).status, 401);   // global secret refused on a studio URL
    const res = await h(await rzpReq(PAID, "studio_whsec", "?org=" + ORG));
    assertEquals(res.status, 200);
    const call = supaLog().find((e) => e.rpc === "razorpay_settle_for_org");
    assert(call); assertEquals((call!.args as any).p_org, ORG);
    assert(!supaLog().some((e) => e.rpc === "razorpay_settle"));
  } finally { rF(); rEnv(); }
});

Deno.test("rzp webhook ?org=: studio not connected -> 401; bad org id -> 401, no DB", async () => {
  resetSupaMock(); rzDb({ creds: { data: null, error: null } });
  const rEnv = setEnv({ ...BASE, RAZORPAY_WEBHOOK_SECRET: "global_whsec" });
  const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(RZW);
    assertEquals((await h(await rzpReq(PAID, "global_whsec", "?org=" + ORG))).status, 401);
    resetSupaMock(); rzDb({});
    assertEquals((await h(await rzpReq(PAID, "global_whsec", "?org=not-a-uuid"))).status, 401);
    assertEquals(supaLog().filter((e) => e.rpc).length, 0);
  } finally { rF(); rEnv(); }
});

Deno.test("rzp webhook ?org=: payment of ANOTHER studio's quote -> ignored (200), no emails", async () => {
  resetSupaMock(); rzDb({ creds: { data: { webhook_secret: "studio_whsec" }, error: null }, settle: { data: { result: "org_mismatch" }, error: null } });
  const rEnv = setEnv({ ...BASE, RESEND_API_KEY: "re_x" });
  const rF = installFetch(() => { throw new Error("no fetch / no email"); });
  try {
    const res = await (await loadHandler(RZW))(await rzpReq(PAID, "studio_whsec", "?org=" + ORG));
    assertEquals(res.status, 200); assertEquals(await res.text(), "ignored");
  } finally { rF(); rEnv(); }
});

for (const [evt, payload, expect] of [
  ["payment.failed", { payment: { entity: { id: "pay_F1", amount: 5000, status: "failed", notes: { quote_id: QUOTE } } } }, { p_payment_ref: "pay_F1", p_amount_paise: 5000, p_status: "failed", p_quote_hint: QUOTE }],
  ["payment_link.cancelled", { payment_link: { entity: { id: "plink_C1", amount: 7000, status: "cancelled" } } }, { p_link_ref: "plink_C1", p_status: "cancelled" }],
  ["payment_link.expired", { payment_link: { entity: { id: "plink_E1", amount: 7000, status: "expired" } } }, { p_link_ref: "plink_E1", p_status: "expired" }],
  ["refund.processed", { refund: { entity: { id: "rfnd_R1", payment_id: "pay_P1", amount: 3000, status: "processed" } } }, { p_refund_ref: "rfnd_R1", p_payment_ref: "pay_P1", p_amount_paise: 3000 }],
] as const) {
  Deno.test(`rzp webhook: ${evt} -> recorded via razorpay_record_event (never settled)`, async () => {
    resetSupaMock(); rzDb({});
    const rEnv = setEnv({ ...BASE, RAZORPAY_WEBHOOK_SECRET: "global_whsec" });
    const rF = installFetch(() => { throw new Error("no fetch"); });
    try {
      const res = await (await loadHandler(RZW))(await rzpReq({ event: evt, payload }, "global_whsec", "", { "x-razorpay-event-id": "evt_ABC123" }));
      assertEquals(res.status, 200);
      const call = supaLog().find((e) => e.rpc === "razorpay_record_event");
      assert(call, "record rpc called");
      const a = call!.args as any;
      assertEquals(a.p_event_id, "evt_ABC123"); assertEquals(a.p_type, evt); assertEquals(a.p_org, null);
      for (const [k, v] of Object.entries(expect)) assertEquals(a[k], v, k);
      assert(!supaLog().some((e) => e.rpc === "razorpay_settle" || e.rpc === "razorpay_settle_for_org"));
    } finally { rF(); rEnv(); }
  });
}

Deno.test("rzp webhook: recorded event replay -> 200 idempotent; RPC error -> 500 (retry); no event id -> body hash id", async () => {
  resetSupaMock(); rzDb({ record: { data: { result: "replay" }, error: null } });
  const rEnv = setEnv({ ...BASE, RAZORPAY_WEBHOOK_SECRET: "w" });
  const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(RZW);
    const body = { event: "payment.failed", payload: { payment: { entity: { id: "pay_F2" } } } };
    const r1 = await h(await rzpReq(body, "w"));
    assertEquals(r1.status, 200); assertEquals(await r1.text(), "already recorded (idempotent)");
    assert(String((supaLog().find((e) => e.rpc === "razorpay_record_event")!.args as any).p_event_id).startsWith("body:"));
    resetSupaMock(); rzDb({ record: { data: null, error: { code: "40001" } } });
    assertEquals((await h(await rzpReq(body, "w"))).status, 500);
  } finally { rF(); rEnv(); }
});

// ---- wa-webhook --------------------------------------------------------------------------
const WA_ENV = { ...BASE, WHATSAPP_WEBHOOK_VERIFY_TOKEN: "verify-me-123", WHATSAPP_APP_SECRET: "app_secret_x" };
const waPost = async (body: unknown, secret = "app_secret_x") => {
  const raw = JSON.stringify(body);
  return new Request("https://fn.local/", { method: "POST", headers: { "x-hub-signature-256": "sha256=" + await hmac(secret, raw) }, body: raw });
};
const WA_BODY = { object: "whatsapp_business_account", entry: [{ id: "1234567", changes: [{ field: "messages", value: {
  metadata: { phone_number_id: "1098765432" },
  statuses: [{ id: "wamid.AAA", status: "delivered", recipient_id: "919800000001" }, { id: "wamid.BBB", status: "failed", recipient_id: "919800000002", errors: [{ code: 131026 }] }],
  messages: [{ id: "wamid.IN1", from: "919800000003", type: "text", text: { body: "STOP" } }, { id: "wamid.IN2", from: "919800000004", type: "text", text: { body: "my private reply" } }],
} }] }] };

Deno.test("wa-webhook: dormant (no secrets) -> 404 for GET and POST, no DB", async () => {
  resetSupaMock();
  const rEnv = setEnv({ ...BASE });
  try {
    const h = await loadHandler(WAW);
    assertEquals((await h(new Request("https://fn.local/?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1"))).status, 404);
    assertEquals((await h(await waPost(WA_BODY))).status, 404);
    assertEquals(supaLog().filter((e) => e.rpc).length, 0);
  } finally { rEnv(); }
});

Deno.test("wa-webhook: GET verify handshake echoes challenge only for the right token", async () => {
  resetSupaMock();
  const rEnv = setEnv(WA_ENV);
  try {
    const h = await loadHandler(WAW);
    const ok = await h(new Request("https://fn.local/?hub.mode=subscribe&hub.verify_token=verify-me-123&hub.challenge=CH4LL3NGE"));
    assertEquals(ok.status, 200); assertEquals(await ok.text(), "CH4LL3NGE");
    assertEquals((await h(new Request("https://fn.local/?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1"))).status, 403);
    assertEquals((await h(new Request("https://fn.local/?hub.mode=subscribe&hub.verify_token=verify-me-123&hub.challenge=%3Cscript%3E"))).status, 403);
  } finally { rEnv(); }
});

Deno.test("wa-webhook: bad X-Hub-Signature-256 -> 401, no DB", async () => {
  resetSupaMock();
  const rEnv = setEnv(WA_ENV);
  try {
    assertEquals((await (await loadHandler(WAW))(await waPost(WA_BODY, "wrong"))).status, 401);
    assertEquals(supaLog().filter((e) => e.rpc).length, 0);
  } finally { rEnv(); }
});

Deno.test("wa-webhook: statuses recorded, STOP -> opt-out, ordinary reply text never stored", async () => {
  resetSupaMock(); g.__supaRpc = () => ({ data: { result: "recorded" }, error: null });
  const rEnv = setEnv(WA_ENV);
  try {
    assertEquals((await (await loadHandler(WAW))(await waPost(WA_BODY))).status, 200);
    const rpcs = supaLog().filter((e) => e.rpc);
    const ev = rpcs.filter((e) => e.rpc === "wa_record_event").map((e) => e.args as any);
    assertEquals(ev.map((a) => a.p_event_id), ["status:wamid.AAA:delivered", "status:wamid.BBB:failed", "optout:wamid.IN1"]);
    assertEquals(ev[1].p_detail, { error_code: 131026 });
    const oo = rpcs.filter((e) => e.rpc === "wa_set_opt_out").map((e) => e.args as any);
    assertEquals(oo, [{ p_phone_number_id: "1098765432", p_phone: "919800000003", p_opted_out: true }]);
    assert(!JSON.stringify(rpcs).includes("my private reply"));
  } finally { rEnv(); }
});

Deno.test("wa-webhook: DB error -> 500 so Meta retries; non-WABA object ignored", async () => {
  resetSupaMock(); g.__supaRpc = () => ({ data: null, error: { code: "40001" } });
  const rEnv = setEnv(WA_ENV);
  try {
    const h = await loadHandler(WAW);
    assertEquals((await h(await waPost(WA_BODY))).status, 500);
    const r = await h(await waPost({ object: "page", entry: [] }));
    assertEquals(r.status, 200); assertEquals(await r.text(), "ignored");
  } finally { rEnv(); }
});
