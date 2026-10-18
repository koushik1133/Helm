// 0179 trial no-send: send-otp / client-mailer / send-whatsapp / wa-proposal never reach a provider
// (MSG91 / Meta / Resend) for a free-trial studio; paid studios unchanged; the guard falls back to the
// tables before 0179 is applied and fails CLOSED when nothing can be read. Mocked Supabase + fetch only.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { installFetch, jsonResponse, loadHandler, post, resetSupaMock, setEnv, supaLog } from "./harness.ts";
import { isTrialNoSend, trialSendBlocked } from "../../supabase/functions/_shared/trial-guard.ts";

const g = globalThis as any;
const OTP = "../../supabase/functions/send-otp/index.ts";
const MAILER = "../../supabase/functions/client-mailer/index.ts";
const WA = "../../supabase/functions/send-whatsapp/index.ts";
const WAP = "../../supabase/functions/wa-proposal/index.ts";
const TOKEN = "a0000000-0000-4000-8000-0000000000aa";
const QUOTE = "a0000000-0000-4000-8000-00000000da01";
const ORG = "b0000000-0000-4000-8000-00000000da02";
const ENV = {
  SUPABASE_URL: "https://proj.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  MSG91_AUTHKEY: "ak", MSG91_SENDER: "HELMEV", MSG91_OTP_TEMPLATE_ID: "tpl",
  WHATSAPP_TOKEN: "meta-secret", WHATSAPP_PHONE_ID: "123456", RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <mail@helm.events>",
};
const AUTH = { Authorization: "Bearer user-jwt", Origin: "https://helm.events" };

// trial = true: trial_send_blocked answers true; every other RPC would allow the send
function db(trial: boolean) {
  g.__supaGetUser = (jwt: string) => ({ data: { user: jwt === "user-jwt" ? { id: "u1" } : null } });
  g.__supaRpc = (name: string) => {
    if (name === "trial_send_blocked") return { data: trial, error: null };
    if (name === "otp_send_authorize") return { data: { quote_id: QUOTE, org_id: ORG, mobile: "919800000001" }, error: null };
    if (name === "wa_otp_begin") return { data: { quote_id: QUOTE, phone_key: "9800000001", to: "919800000001", email: "c@example.com", masked: "x" }, error: null };
    if (name === "whatsapp_authorize") return { data: { ok: true, to: "919800000001", org_id: ORG }, error: null };
    if (name === "wa_proposal_prepare") return { data: { audit_id: 9, to: "919800000001", vars: {}, token: TOKEN, status: "simulated" }, error: null };
    return { data: { stored: true }, error: null };
  };
  g.__supaResolver = (table: string) => {
    if (table === "quotes") return { data: { id: QUOTE, org_id: ORG, client: { name: "Asha", email: "asha@example.com" }, approval_token: TOKEN }, error: null };
    if (table === "studio_subscriptions") return { data: { status: "active" }, error: null };
    if (table === "organizations") return { data: { name: "Sparkle", business_email: "s@sparkle.in" }, error: null };
    return { data: null, error: null };
  };
}
const providers = () => installFetch((url) => {
  if (!/msg91|graph\.facebook|resend/.test(url)) throw new Error("unexpected fetch " + url);
  return jsonResponse({ messages: [{ id: "wamid.x" }], id: "re_1" });
});
const providerCalls = () => ((g.__fetchLog || []) as Array<{ url: string }>).filter((f) => /msg91|graph\.facebook|resend/.test(f.url)).length;

Deno.test("trial-guard: rpc answer, table fallback, fail closed", async () => {
  resetSupaMock();
  const mk = (rpc: any, tables: Record<string, any>) => ({
    rpc: () => Promise.resolve(rpc),
    from: (t: string) => {
      const b: any = { select: () => b, eq: () => b, limit: () => b, maybeSingle: () => Promise.resolve(tables[t] || { data: null, error: null }) };
      return b;
    },
  });
  assertEquals(await trialSendBlocked(mk({ data: true, error: null }, {}), { org: ORG }), true);
  assertEquals(await trialSendBlocked(mk({ data: false, error: null }, {}), { org: ORG }), false);
  assertEquals(await trialSendBlocked(mk({ data: { stored: true }, error: null }, {}), { org: ORG }), false, "only a literal true blocks");
  // 0179 not applied yet: function missing -> read the subscription status
  const missing = { data: null, error: { code: "PGRST202", message: "not found" } };
  assertEquals(await trialSendBlocked(mk(missing, { studio_subscriptions: { data: { status: "trial" }, error: null } }), { org: ORG }), true);
  assertEquals(await trialSendBlocked(mk(missing, { quotes: { data: { org_id: ORG }, error: null }, studio_subscriptions: { data: { status: "trial" }, error: null } }), { token: TOKEN }), true);
  assertEquals(await trialSendBlocked(mk(missing, { organizations: { data: { is_sample_master: false }, error: null } }), { org: ORG }), false, "paid studio");
  assertEquals(await trialSendBlocked(mk(missing, { organizations: { data: { is_sample_master: true }, error: null } }), { org: ORG }), true, "sample master");
  assertEquals(await trialSendBlocked(mk(missing, { studio_subscriptions: { data: null, error: { message: "down" } } }), { org: ORG }), true, "fail closed");
  assert(isTrialNoSend({ code: "42501", hint: "trial_no_send" }) && !isTrialNoSend({ code: "42501", hint: "trial_optin" }) && !isTrialNoSend(null));
});

Deno.test("send-otp: trial studio -> 403 trial, no code stored, no SMS / WhatsApp / e-mail", async () => {
  resetSupaMock(); db(true);
  const rEnv = setEnv(ENV); const rF = providers();
  try {
    const h = await loadHandler(OTP);
    for (const body of [{ token: TOKEN, phone: "+91 98000 00001" }, { token: TOKEN, channel: "whatsapp" }, { token: TOKEN, channel: "email" }]) {
      const res = await h(post(body));
      assertEquals(res.status, 403);
      const j = await res.json();
      assertEquals(j.trial, true); assert(/free trial/i.test(j.error));
    }
    assertEquals(providerCalls(), 0);
    assert(!supaLog().some((e) => e.rpc === "admin_store_otp"), "no code stored");
    assert(supaLog().filter((e) => e.rpc === "trial_send_blocked").every((e) => e.key === "service-role-secret"), "asked with the service role");
  } finally { rF(); rEnv(); }
});

Deno.test("send-otp: database trial refusal (42501 trial_no_send) is shown as the trial answer", async () => {
  resetSupaMock(); db(false);
  const base = g.__supaRpc;
  g.__supaRpc = (n: string, a: unknown, k: string) => n === "otp_send_authorize" ? { data: null, error: { code: "42501", hint: "trial_no_send", message: "x" } } : base(n, a, k);
  const rEnv = setEnv(ENV); const rF = providers();
  try {
    const h = await loadHandler(OTP);
    const res = await h(post({ token: TOKEN, phone: "+91 98000 00001" }));
    assertEquals(res.status, 403); assertEquals((await res.json()).trial, true);
    assertEquals(providerCalls(), 0);
  } finally { rF(); rEnv(); }
});

Deno.test("send-otp: paid studio still sends the SMS", async () => {
  resetSupaMock(); db(false);
  const rEnv = setEnv(ENV); const rF = providers();
  try {
    const h = await loadHandler(OTP);
    const res = await h(post({ token: TOKEN, phone: "+91 98000 00001" }));
    assertEquals(res.status, 200);
    assertEquals(providerCalls(), 1);
  } finally { rF(); rEnv(); }
});

Deno.test("client-mailer: trial studio -> not sent (status not_configured, trial), logged as simulated", async () => {
  resetSupaMock(); db(true);
  const rEnv = setEnv(ENV); const rF = providers();
  try {
    const h = await loadHandler(MAILER);
    const res = await h(post({ quote_id: QUOTE, kind: "approval" }, AUTH));
    assertEquals(res.status, 200);
    const j = await res.json();
    assertEquals(j.status, "not_configured"); assertEquals(j.trial, true);
    assertEquals(providerCalls(), 0);
    const log = supaLog().find((e) => e.table === "notifications");
    assert(log && JSON.stringify(log.calls).includes("simulated"), "log row says simulated");
  } finally { rF(); rEnv(); }
});

Deno.test("client-mailer: paid studio still e-mails", async () => {
  resetSupaMock(); db(false);
  const rEnv = setEnv(ENV); const rF = providers();
  try {
    const h = await loadHandler(MAILER);
    const res = await h(post({ quote_id: QUOTE, kind: "approval" }, AUTH));
    assertEquals((await res.json()).status, "sent");
    assertEquals(providerCalls(), 1);
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: trial studio -> 403 trial, Meta never called; DB hint mapped", async () => {
  resetSupaMock(); db(true);
  const rEnv = setEnv(ENV); const rF = providers();
  try {
    const h = await loadHandler(WA);
    const res = await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update" }, AUTH));
    assertEquals(res.status, 403); assertEquals((await res.json()).trial, true);
    resetSupaMock(); db(false);
    const base = g.__supaRpc;
    g.__supaRpc = (n: string, a: unknown, k: string) => n === "whatsapp_authorize" ? { data: null, error: { code: "42501", hint: "trial_no_send", message: "x" } } : base(n, a, k);
    const res2 = await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update" }, AUTH));
    assertEquals(res2.status, 403); assert(/free trial/i.test((await res2.json()).error));
    assertEquals(providerCalls(), 0);
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: paid studio still sends", async () => {
  resetSupaMock(); db(false);
  const rEnv = setEnv(ENV); const rF = providers();
  try {
    const h = await loadHandler(WA);
    const res = await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update" }, AUTH));
    assertEquals(res.status, 200);
    assertEquals(providerCalls(), 1);
  } finally { rF(); rEnv(); }
});

Deno.test("wa-proposal: trial studio -> simulated prepare (p_simulate true), Meta never called", async () => {
  resetSupaMock(); db(true);
  const rEnv = setEnv(ENV); const rF = providers();
  try {
    const h = await loadHandler(WAP);
    const res = await h(post({ quote_id: QUOTE, kind: "proposal_sent", phone: "+919800000001", opt_in: true, consent_text: "ok" }, AUTH));
    assertEquals(res.status, 200);
    const j = await res.json();
    assertEquals(j.simulated, true); assertEquals(j.trial, true);
    const prep = supaLog().find((e) => e.rpc === "wa_proposal_prepare");
    assertEquals(prep.args.p_simulate, true);
    assertEquals(providerCalls(), 0);
  } finally { rF(); rEnv(); }
});

Deno.test("wa-proposal: paid studio still sends for real", async () => {
  resetSupaMock(); db(false);
  const rEnv = setEnv(ENV); const rF = providers();
  try {
    const h = await loadHandler(WAP);
    const res = await h(post({ quote_id: QUOTE, kind: "proposal_sent", phone: "+919800000001", opt_in: true, consent_text: "ok" }, AUTH));
    const j = await res.json();
    assertEquals(j.sent, true, JSON.stringify(j));
    assertEquals(supaLog().find((e) => e.rpc === "wa_proposal_prepare").args.p_simulate, false);
    assertEquals(providerCalls(), 1);
  } finally { rF(); rEnv(); }
});
