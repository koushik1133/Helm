// r59 (0300) audit fixes - edge functions, runtime-verified with mocked Supabase / Meta / Resend:
//   F-1  integrations-test WhatsApp: admins only (DB), a team member's own mobile only, STOP list (when the table
//        exists), free-trial guard, per-studio daily cap - Meta is never called when any of them says no
//   F-8  send-whatsapp {ping:true}: Settings view needed
//   E-01 razorpay-webhook: a record-only event while razorpay_record_event is missing (0117) -> 200 {ignored:true}
//   E-03 razorpay-webhook / billing-reminder: never an UNCONFIRMED studio e-mail
//   E-05 verify-upload: vendor-invoices bucket is checked by its first bytes
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, post, resetSupaMock, supaLog, fetchLog } from "./harness.ts";
import { verdict } from "../../supabase/functions/verify-upload/sniff.ts";

const g = globalThis as any;
const ORG = "a0000000-0000-4000-8000-000000000001";
const AUTH = { authorization: "Bearer user-jwt" };

// ---------------------------------------------------------------- integrations-test (F-1)
const ITEST = "../../supabase/functions/integrations-test/index.ts";
const ITEST_ENV = {
  SUPABASE_URL: "https://proj.supabase.co", SUPABASE_ANON_KEY: "anon-key", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  WHATSAPP_TOKEN: "meta-secret-token", WHATSAPP_PHONE_ID: "123456", COMMS_WHATSAPP_TEMPLATE: "helm_notice",
};
type WaOpts = { target?: any; targetErr?: any; trial?: boolean; optedOut?: boolean; optTableMissing?: boolean };
function waDb(o: WaOpts = {}) {
  g.__supaGetUser = (jwt: string) => jwt === "user-jwt" ? ({ data: { user: { id: "u1" } } }) : ({ data: { user: null } });
  g.__supaRpc = (name: string) => {
    if (name === "integrations_test_target") return { data: { org_id: ORG, email: "a@a.test", studio_name: "Studio A", studio_whatsapp: "919800000001" }, error: null };
    if (name === "integrations_wa_test_target") return o.targetErr ? { data: null, error: o.targetErr } : { data: o.target ?? { ok: true, studio_whatsapp: "919800000001", org_id: ORG }, error: null };
    if (name === "trial_send_blocked") return { data: o.trial === true, error: null };
    return { data: null, error: null };
  };
  g.__supaResolver = (table: string) => {
    if (table === "whatsapp_opt_outs") return o.optTableMissing ? { data: null, error: { code: "42P01" } } : { data: o.optedOut ? { id: 1 } : null, error: null };
    return { data: null, error: null };
  };
}
async function waTest(o: WaOpts) {
  resetSupaMock(); waDb(o);
  let meta = 0;
  const rEnv = setEnv(ITEST_ENV);
  const rF = installFetch((url) => { if (url.startsWith("https://graph.facebook.com/")) { meta++; return jsonResponse({ messages: [{ id: "w1" }] }); } throw new Error("unexpected " + url); });
  try {
    const h = await loadHandler(ITEST);
    const res = await h(post({ action: "test", channel: "whatsapp" }, AUTH));
    return { status: res.status, body: await res.json(), meta };
  } finally { rF(); rEnv(); }
}

Deno.test("r59 F-1: a non-admin (DB 42501) -> 403, Meta never called", async () => {
  const r = await waTest({ targetErr: { code: "42501" } });
  assertEquals(r.status, 403); assertEquals(r.meta, 0); assert(/admin/.test(r.body.error));
});
Deno.test("r59 F-1: before APPLY-0300 (function missing) -> 503, Meta never called", async () => {
  const r = await waTest({ targetErr: { code: "PGRST202" } });
  assertEquals(r.status, 503); assertEquals(r.meta, 0);
});
Deno.test("r59 F-1: the studio number is not a team member's mobile -> 400, Meta never called", async () => {
  const r = await waTest({ target: { ok: false, reason: "not_team_number" } });
  assertEquals(r.status, 400); assertEquals(r.meta, 0); assert(/team member/.test(r.body.error));
});
Deno.test("r59 F-1: free-trial studio -> 403 trial, Meta never called", async () => {
  const r = await waTest({ trial: true });
  assertEquals(r.status, 403); assertEquals(r.body.trial, true); assertEquals(r.meta, 0);
});
Deno.test("r59 F-1: the number replied STOP -> 409, Meta never called", async () => {
  const r = await waTest({ optedOut: true });
  assertEquals(r.status, 409); assertEquals(r.meta, 0);
});
Deno.test("r59 F-1: daily cap per studio (WA_TEST_PER_DAY) -> 429 after the cap, Meta not called again", async () => {
  resetSupaMock(); waDb({});
  let meta = 0;
  const rEnv = setEnv({ ...ITEST_ENV, WA_TEST_PER_DAY: "2" });
  const rF = installFetch(() => { meta++; return jsonResponse({ messages: [{ id: "w1" }] }); });
  try {
    const h = await loadHandler(ITEST);
    const st: number[] = [];
    for (let i = 0; i < 3; i++) st.push((await h(post({ action: "test", channel: "whatsapp" }, AUTH))).status);
    assertEquals(st, [200, 200, 429]); assertEquals(meta, 2);
  } finally { rF(); rEnv(); }
});
Deno.test("r59 F-1: admin + team number + not opted out (or no STOP table yet, 0117) -> one live send", async () => {
  for (const optTableMissing of [false, true]) {
    const r = await waTest({ optTableMissing });
    assertEquals(r.status, 200); assertEquals(r.body.mode, "live"); assertEquals(r.body.sent, true); assertEquals(r.meta, 1);
    assert(!JSON.stringify(r.body).includes("919800000001"), "the full number is never echoed");
  }
});
Deno.test("r59 F-1: the recipient comes from the DB, never from the request", async () => {
  resetSupaMock(); waDb({});
  let sentTo = "";
  const rEnv = setEnv(ITEST_ENV);
  const rF = installFetch((_url, init) => { sentTo = JSON.parse(String(init?.body || "{}")).to; return jsonResponse({ messages: [{ id: "w1" }] }); });
  try {
    const h = await loadHandler(ITEST);
    await h(post({ action: "test", channel: "whatsapp", to: "15550000000", number: "15550000000" }, AUTH));
    assertEquals(sentTo, "919800000001");
  } finally { rF(); rEnv(); }
});

// ---------------------------------------------------------------- send-whatsapp ping (F-8)
const SWA = "../../supabase/functions/send-whatsapp/index.ts";
async function ping(canSee: boolean | "err") {
  resetSupaMock();
  g.__supaGetUser = (jwt: string) => jwt === "user-jwt" ? ({ data: { user: { id: "u1" } } }) : ({ data: { user: null } });
  g.__supaRpc = (name: string) => name === "has_area" ? (canSee === "err" ? { data: null, error: { code: "42501" } } : { data: canSee, error: null }) : { data: null, error: null };
  let meta = 0;
  const rEnv = setEnv(ITEST_ENV);
  const rF = installFetch(() => { meta++; return jsonResponse({ verified_name: "x" }); });
  try {
    const h = await loadHandler(SWA);
    const res = await h(post({ ping: true }, AUTH));
    const call = supaLog().find((e: any) => e.rpc === "has_area");
    return { status: res.status, meta, call };
  } finally { rF(); rEnv(); }
}
Deno.test("r59 F-8: ping without Settings view -> 403, Meta never called", async () => {
  for (const v of [false, "err"] as const) { const r = await ping(v); assertEquals(r.status, 403); assertEquals(r.meta, 0); }
});
Deno.test("r59 F-8: ping with Settings view -> asked as the caller (controls / view), then the Meta check", async () => {
  const r = await ping(true);
  assertEquals(r.status, 200); assertEquals(r.meta, 1);
  assertEquals(r.call.args, { p_area: "controls", p_need: "view" });
  assertEquals(r.call.key, "anon-key", "the area check runs with the caller's JWT client, not the service role");
});

// ---------------------------------------------------------------- razorpay-webhook (E-01, E-03)
const RZP = "../../supabase/functions/razorpay-webhook/index.ts";
const SECRET = "whsec_test";
const QUOTE = "a0000000-0000-4000-8000-00000000da01";
const RZP_ENV = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", RAZORPAY_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <events@helm.events>" };
async function signed(body: unknown): Promise<Request> {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://fn.local/", { method: "POST", headers: { "x-razorpay-signature": sig }, body: raw });
}
Deno.test("r59 E-01: record-only events while razorpay_record_event is missing -> 200 {ignored:true} (no 500 retries)", async () => {
  for (const event of ["payment.failed", "payment_link.cancelled", "payment_link.expired", "refund.processed"]) {
    for (const code of ["PGRST202", "42883"]) {
      resetSupaMock();
      g.__supaRpc = (name: string) => name === "razorpay_record_event" ? { data: null, error: { code } } : { data: null, error: null };
      const rEnv = setEnv(RZP_ENV); const rF = installFetch(() => { throw new Error("no fetch"); });
      try {
        const h = await loadHandler(RZP);
        const res = await h(await signed({ event, created_at: Math.floor(Date.now() / 1000), payload: { payment: { entity: { id: "pay_X1", amount: 100, status: "failed" } } } }));
        assertEquals(res.status, 200, event + " " + code);
        assertEquals((await res.json()).ignored, true);
      } finally { rF(); rEnv(); }
    }
  }
});
Deno.test("r59 E-01: any OTHER record error still answers 500 (Razorpay retries)", async () => {
  resetSupaMock();
  g.__supaRpc = (name: string) => name === "razorpay_record_event" ? { data: null, error: { code: "40001" } } : { data: null, error: null };
  const rEnv = setEnv(RZP_ENV); const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(RZP);
    const res = await h(await signed({ event: "payment.failed", created_at: Math.floor(Date.now() / 1000), payload: { payment: { entity: { id: "pay_X2", amount: 100 } } } }));
    assertEquals(res.status, 500);
  } finally { rF(); rEnv(); }
});
const PAID = { event: "payment_link.paid", payload: { payment_link: { entity: { id: "plink_A1", amount_paid: 100000, notes: { quote_id: QUOTE } } }, payment: { entity: { id: "pay_A1", amount: 100000 } } } };
async function paidMails(billing: { data?: unknown; error?: unknown }, org: Record<string, unknown>) {
  resetSupaMock();
  g.__supaRpc = (name: string) => name === "razorpay_settle" ? { data: { result: "settled", quote_id: QUOTE }, error: null }
    : name === "studio_billing_email" ? billing : name === "notify_allowed" ? { data: true, error: null } : { data: null, error: null };
  g.__supaResolver = (table: string) => {
    if (table === "quotes") return { data: { id: QUOTE, code: "A-1", title: "Wedding", client: { email: "client@example.com" }, pricing: { total: 1000 }, org_id: ORG }, error: null };
    if (table === "organizations") return { data: { name: "Studio A", ...org }, error: null };
    return { data: null, error: null };
  };
  const tos: string[] = [];
  const rEnv = setEnv(RZP_ENV);
  const rF = installFetch((url, init) => { if (url === "https://api.resend.com/emails") { tos.push(...[].concat(JSON.parse(String(init?.body)).to)); return jsonResponse({ id: "e" }); } throw new Error("unexpected " + url); });
  try { const h = await loadHandler(RZP); const res = await h(await signed(PAID)); return { status: res.status, tos }; }
  finally { rF(); rEnv(); }
}
Deno.test("r59 E-03: the studio copy goes to studio_billing_email (owner when the studio e-mail is unconfirmed)", async () => {
  const r = await paidMails({ data: "owner-login@a.test", error: null }, { business_email: "attacker@evil.test", business_email_confirmed: false });
  assertEquals(r.status, 200);
  assert(r.tos.includes("owner-login@a.test")); assert(!r.tos.includes("attacker@evil.test"));
});
Deno.test("r59 E-03: before 0300 (function missing) an UNCONFIRMED studio e-mail is never mailed; a confirmed one is", async () => {
  const off = await paidMails({ data: null, error: { code: "PGRST202" } }, { business_email: "attacker@evil.test", business_email_confirmed: false });
  assertEquals(off.status, 200); assert(!off.tos.includes("attacker@evil.test"));
  assert(off.tos.includes("client@example.com"), "the client receipt still goes");
  const on = await paidMails({ data: null, error: { code: "PGRST202" } }, { business_email: "studio@a.test", business_email_confirmed: true });
  assert(on.tos.includes("studio@a.test"));
});

// ---------------------------------------------------------------- billing-reminder (E-03)
const REM = "../../supabase/functions/billing-reminder/index.ts";
Deno.test("r59 E-03: billing reminder goes to studio_billing_email, never the unconfirmed studio e-mail", async () => {
  resetSupaMock();
  g.__supaRpc = (name: string) => name === "studio_billing_email" ? { data: "owner-login@a.test", error: null } : { data: null, error: null };
  g.__supaResolver = (table: string, calls: any[]) => {
    if (table === "billing_reminders" && calls.some((c: any) => c[0] === "select")) return { data: [{ id: "c0000000-0000-4000-8000-0000000000c1", org_id: ORG, kind: "past_due", period_end: "2026-10-01" }], error: null };
    if (table === "organizations") return { data: { name: "Studio A", business_email: "attacker@evil.test", business_email_confirmed: false }, error: null };
    return { data: null, error: null };
  };
  const tos: string[] = [];
  const rEnv = setEnv({ SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "srk", HELM_BILLING_REMINDERS_ENABLED: "true", HELM_BILLING_CRON_SECRET: "cron-s", RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <billing@helm.events>" });
  const rF = installFetch((url, init) => { if (url === "https://api.resend.com/emails") { tos.push(...[].concat(JSON.parse(String(init?.body)).to)); return jsonResponse({ id: "e" }); } throw new Error("unexpected " + url); });
  try {
    const h = await loadHandler(REM);
    const res = await h(new Request("https://fn.local/", { method: "POST", headers: { "x-helm-cron-secret": "cron-s" } }));
    assertEquals(res.status, 200);
    assertEquals(tos, ["owner-login@a.test"]);
    assert(fetchLog().length >= 1);
  } finally { rF(); rEnv(); }
});

// ---------------------------------------------------------------- verify-upload (E-05)
Deno.test("r59 E-05: vendor-invoices objects are checked by their first bytes", () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0, 0, 0, 0, 0, 0, 0, 0]);
  const html = new TextEncoder().encode("<html><script>x</script></html>").subarray(0, 16);
  const key = "a0000000-0000-4000-8000-000000000001/b0000000-0000-4000-8000-000000000001/c0000000-0000-4000-8000-000000000001/d0000000-0000-4000-8000-000000000001";
  assertEquals(verdict("vendor-invoices", key + ".pdf", pdf, 2000, "application/pdf").ok, true);
  assertEquals(verdict("vendor-invoices", key + ".pdf", html, 2000, "application/pdf").ok, false);
  assertEquals(verdict("vendor-invoices", key + ".jpg", pdf, 2000, "image/jpeg").ok, false, "extension / content mismatch");
  assertEquals(verdict("vendor-invoices", key + ".pdf", pdf, 10485761, "application/pdf").ok, false, "over 10 MB");
});
