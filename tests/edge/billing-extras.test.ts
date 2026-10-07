// billing-reminder + razorpay-subscription-webhook — dormant mode, shared-secret gate,
// signature verification, org mapping, idempotent marking. Mock-only, no network.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, resetSupaMock, supaLog, fetchLog, captureConsoleError } from "./harness.ts";

const g = globalThis as any;
const SUB = "../../supabase/functions/razorpay-subscription-webhook/index.ts";
const REM = "../../supabase/functions/billing-reminder/index.ts";
const ORG = "b0000000-0000-4000-8000-0000000000a1";
const OTHER = "b0000000-0000-4000-8000-0000000000b2";
const SECRET = "whsec_sub_test";
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" };
const SUB_ENV = { ...BASE, HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED: "true", RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET: SECRET };
const noFetch = () => installFetch(() => { throw new Error("no fetch expected"); });

async function hex(secret: string, raw: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function charged(over: Record<string, unknown> = {}, notesOrg: string | null = ORG) {
  const now = Math.floor(Date.now() / 1000);
  return {
    event: "subscription.charged", created_at: now,
    payload: {
      subscription: { entity: { id: "sub_ABC123", current_start: now - 100, current_end: now + 2592000, notes: notesOrg ? { org_id: notesOrg } : {} } },
      payment: { entity: { id: "pay_XYZ789", amount: 117882, currency: "INR", status: "captured", created_at: now } },
    },
    ...over,
  };
}
async function signedReq(body: unknown, secret: string | null = SECRET, tamper = false) {
  const raw = JSON.stringify(body);
  const h: Record<string, string> = {};
  if (secret !== null) h["x-razorpay-signature"] = await hex(secret, raw);
  return new Request("https://fn.local/", { method: "POST", headers: h, body: tamper ? raw.replace("117882", "1") : raw });
}
function subDb(owner: string | null = ORG, settle: any = { data: { result: "settled" }, error: null }) {
  g.__supaResolver = (table: string) => table === "studio_subscriptions" ? { data: owner ? { org_id: owner } : null, error: null } : { data: null, error: null };
  g.__supaRpc = (name: string) => name === "hq_settle_provider_payment" ? settle : { data: null, error: null };
}
const rpcCalls = () => supaLog().filter((l) => l.rpc);

// ---------------- subscription webhook ----------------
Deno.test("sub-webhook: dormant by default -> 200, DB untouched (even unsigned)", async () => {
  resetSupaMock(); subDb();
  const r = setEnv({ ...BASE, RAZORPAY_SUBSCRIPTION_WEBHOOK_SECRET: SECRET }); const f = noFetch();
  try {
    const h = await loadHandler(SUB);
    const res = await h(await signedReq(charged(), null));
    assertEquals(res.status, 200); assertEquals(await res.text(), "dormant");
    assertEquals(supaLog().length, 0);
  } finally { f(); r(); }
});

Deno.test("sub-webhook: valid signature -> settles with payload amount + mapped org", async () => {
  resetSupaMock(); subDb();
  const r = setEnv(SUB_ENV); const f = noFetch();
  try {
    const h = await loadHandler(SUB);
    const res = await h(await signedReq(charged()));
    assertEquals(res.status, 200);
    const calls = rpcCalls();
    assertEquals(calls.length, 1);
    assertEquals(calls[0].rpc, "hq_settle_provider_payment");
    assertEquals(calls[0].args.p_provider_payment_id, "pay_XYZ789");
    assertEquals(calls[0].args.p_org, ORG);
    assertEquals(calls[0].args.p_amount, 1178.82);
    assertEquals(calls[0].key, "service-role-secret");
  } finally { f(); r(); }
});

for (const [name, secret, tamper] of [["invalid (wrong secret)", "other", false], ["missing", null, false], ["tampered body", SECRET, true]] as const) {
  Deno.test(`sub-webhook: signature ${name} -> 401, DB untouched`, async () => {
    resetSupaMock(); subDb();
    const r = setEnv(SUB_ENV); const f = noFetch();
    try {
      const h = await loadHandler(SUB);
      assertEquals((await h(await signedReq(charged(), secret, tamper))).status, 401);
      assertEquals(supaLog().length, 0);
    } finally { f(); r(); }
  });
}

Deno.test("sub-webhook: no secret configured -> 401 (fail closed)", async () => {
  resetSupaMock(); subDb();
  const r = setEnv({ ...BASE, HELM_RAZORPAY_SUBSCRIPTIONS_ENABLED: "true" }); const f = noFetch();
  try {
    const h = await loadHandler(SUB);
    assertEquals((await h(await signedReq(charged(), "anything"))).status, 401);
    assertEquals(supaLog().length, 0);
  } finally { f(); r(); }
});

Deno.test("sub-webhook: stale event -> 400, unknown event -> 200 no settle", async () => {
  resetSupaMock(); subDb();
  const r = setEnv(SUB_ENV); const f = noFetch();
  try {
    const h = await loadHandler(SUB);
    assertEquals((await h(await signedReq(charged({ created_at: Math.floor(Date.now() / 1000) - 200000 })))).status, 400);
    const u = await h(await signedReq(charged({ event: "refund.created" })));
    assertEquals(u.status, 200); assertEquals(await u.text(), "unknown event");
    assertEquals(rpcCalls().length, 0);
  } finally { f(); r(); }
});

Deno.test("sub-webhook: notes.org_id disagreeing with subscription owner -> refused, no settle", async () => {
  resetSupaMock(); subDb(ORG);
  const r = setEnv(SUB_ENV); const f = noFetch();
  try {
    const h = await loadHandler(SUB);
    const res = await h(await signedReq(charged({}, OTHER)));
    assertEquals(await res.text(), "org mismatch");
    assertEquals(rpcCalls().length, 0);
  } finally { f(); r(); }
});

Deno.test("sub-webhook: unknown subscription -> unmatched, no settle; DB error -> 500", async () => {
  resetSupaMock(); subDb(null);
  const r = setEnv(SUB_ENV); const f = noFetch();
  try {
    const h = await loadHandler(SUB);
    assertEquals(await (await h(await signedReq(charged()))).text(), "unmatched");
    assertEquals(rpcCalls().length, 0);
    subDb(ORG, { data: null, error: { code: "40001" } });
    assertEquals((await h(await signedReq(charged()))).status, 500);
  } finally { f(); r(); }
});

Deno.test("sub-webhook: replay -> 200 idempotent", async () => {
  resetSupaMock(); subDb(ORG, { data: { result: "replay" }, error: null });
  const r = setEnv(SUB_ENV); const f = noFetch();
  try {
    const h = await loadHandler(SUB);
    assertEquals(await (await h(await signedReq(charged()))).text(), "already recorded (idempotent)");
  } finally { f(); r(); }
});

// ---------------- billing reminder ----------------
const CRON = "cron-shared-secret-xyz";
const REM_ENV = { ...BASE, HELM_BILLING_REMINDERS_ENABLED: "true", HELM_BILLING_CRON_SECRET: CRON, RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <billing@helm.events>" };
const RID = "c0000000-0000-4000-8000-0000000000c1";
const cronReq = (secret?: string) => new Request("https://fn.local/", { method: "POST", headers: secret === undefined ? {} : { "x-helm-cron-secret": secret } });
function remDb() {
  g.__supaResolver = (table: string, calls: any[]) => {
    if (table === "billing_reminders" && calls.some((c: any) => c[0] === "select")) return { data: [{ id: RID, org_id: ORG, kind: "past_due", period_end: "2026-10-01" }], error: null };
    if (table === "organizations") return { data: { name: "Studio <A>", business_email: "owner@studio-a.in" }, error: null };
    return { data: null, error: null };
  };
}
const updates = () => supaLog().filter((l) => l.table === "billing_reminders" && l.calls.some((c: any) => c[0] === "update"));

Deno.test("billing-reminder: dormant by default -> 200 no-op", async () => {
  resetSupaMock(); remDb();
  const r = setEnv({ ...BASE, HELM_BILLING_CRON_SECRET: CRON }); const f = noFetch();
  try {
    const h = await loadHandler(REM);
    const res = await h(cronReq(CRON));
    assertEquals(res.status, 200); assertEquals((await res.json()).status, "dormant");
    assertEquals(supaLog().length, 0);
  } finally { f(); r(); }
});

for (const [name, env, given] of [["wrong secret", REM_ENV, "nope"], ["missing header", REM_ENV, undefined], ["secret unset (fail closed)", { ...REM_ENV, HELM_BILLING_CRON_SECRET: "" }, ""]] as const) {
  Deno.test(`billing-reminder: ${name} -> 401, DB untouched`, async () => {
    resetSupaMock(); remDb();
    const r = setEnv(env as Record<string, string>); const f = noFetch();
    try {
      const h = await loadHandler(REM);
      assertEquals((await h(cronReq(given as string | undefined))).status, 401);
      assertEquals(supaLog().length, 0);
    } finally { f(); r(); }
  });
}

Deno.test("billing-reminder: sends via Resend only, marks sent idempotently, no PII in logs", async () => {
  resetSupaMock(); remDb();
  const r = setEnv(REM_ENV);
  const f = installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ id: "e1" }); throw new Error("unexpected " + url); });
  try {
    const h = await loadHandler(REM);
    const { result, logs } = await captureConsoleError(async () => await h(cronReq(CRON)));
    assertEquals(result.status, 200);
    assertEquals((await result.json()).sent, 1);
    assertEquals(fetchLog().length, 1);
    const body = JSON.parse(String(fetchLog()[0].init?.body));
    assert(body.html.includes("Studio &lt;A&gt;"));
    const u = updates();
    assertEquals(u.length, 1);
    assert(u[0].calls.some((c: any) => c[0] === "is" && c[1][0] === "sent_at" && c[1][1] === null));
    assertEquals(u[0].calls.find((c: any) => c[0] === "update")[1][0].channel, "email");
    assert(!logs.join(" ").includes("owner@studio-a.in"));
  } finally { f(); r(); }
});

Deno.test("billing-reminder: no provider key -> marked skipped, no fetch", async () => {
  resetSupaMock(); remDb();
  const r = setEnv({ ...REM_ENV, RESEND_API_KEY: "" }); const f = noFetch();
  try {
    const h = await loadHandler(REM);
    const res = await h(cronReq(CRON));
    assertEquals((await res.json()).skipped, 1);
    assertEquals(fetchLog().length, 0);
    assertEquals(updates()[0].calls.find((c: any) => c[0] === "update")[1][0].channel, "skipped");
  } finally { f(); r(); }
});

Deno.test("billing-reminder: provider failure -> row left unsent for retry", async () => {
  resetSupaMock(); remDb();
  const r = setEnv(REM_ENV); const f = installFetch(() => jsonResponse({ error: "x" }, 500));
  try {
    const h = await loadHandler(REM);
    const { result } = await captureConsoleError(async () => await h(cronReq(CRON)));
    assertEquals((await result.json()).failed, 1);
    assertEquals(updates().length, 0);
  } finally { f(); r(); }
});
