// 0212 free-trial client e-mail: client-mailer and send-otp send a real e-mail for an ACTIVE trial only when the
// database gate allows it (caps), never WhatsApp / SMS; a gate that gives no clear answer falls back to the
// pre-0212 rule (nothing sent). comms-dispatch skips a trial-marked row that is not a link e-mail.
// Mocked Supabase + mocked fetch only - NO real message is sent.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { installFetch, jsonResponse, loadHandler, post, resetSupaMock, setEnv, supaLog } from "./harness.ts";
import { trialEmailGate } from "../../supabase/functions/_shared/trial-guard.ts";
import { trialRowAllowed } from "../../supabase/functions/comms-dispatch/trial-row.mjs";

const g = globalThis as any;
const OTP = "../../supabase/functions/send-otp/index.ts";
const MAILER = "../../supabase/functions/client-mailer/index.ts";
const TOKEN = "a0000000-0000-4000-8000-0000000000aa";
const QUOTE = "a0000000-0000-4000-8000-00000000da01";
const ORG = "b0000000-0000-4000-8000-00000000da02";
const ENV = {
  SUPABASE_URL: "https://proj.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  MSG91_AUTHKEY: "ak", MSG91_SENDER: "HELMEV", MSG91_OTP_TEMPLATE_ID: "tpl",
  WHATSAPP_TOKEN: "meta-secret", WHATSAPP_PHONE_ID: "123456", RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <mail@helm.events>",
};
const AUTH = { Authorization: "Bearer user-jwt", Origin: "https://helm.events" };
const DEST = { quote_id: QUOTE, phone_key: "9800000001", to: "919800000001", email: "asha@client.test", masked: "a***@client.test", resends_left: 3, trial_email: true };

// gate = the trial_email_gate answer; trialOtp = the trial_email_otp_begin answer
function db(gate: unknown, trialOtp: { data?: unknown; error?: unknown } = { data: DEST, error: null }) {
  g.__supaGetUser = (jwt: string) => ({ data: { user: jwt === "user-jwt" ? { id: "u1" } : null } });
  g.__supaRpc = (name: string) => {
    if (name === "client_mailer_check") return { data: { ok: true, link_live: true }, error: null };   // r56 (0297)
    if (name === "trial_email_gate") return { data: gate, error: null };
    if (name === "trial_send_blocked") return { data: true, error: null };
    if (name === "_sample_outbound_blocked") return { data: true, error: null };
    if (name === "trial_email_otp_begin") return trialOtp;
    if (name === "wa_otp_begin" || name === "otp_send_authorize") return { data: null, error: { code: "42501", hint: "trial_no_send", message: "x" } };
    return { data: { stored: true }, error: null };
  };
  g.__supaResolver = (table: string) => {
    if (table === "quotes") return { data: { id: QUOTE, org_id: ORG, client: { name: "Asha", email: "asha@client.test" }, approval_token: TOKEN }, error: null };
    if (table === "studio_subscriptions") return { data: { status: "trial" }, error: null };
    if (table === "organizations") return { data: { name: "Sparkle", business_email: "s@sparkle.in" }, error: null };
    return { data: null, error: null };
  };
}
const providers = () => installFetch((url) => {
  if (!/msg91|graph\.facebook|resend/.test(url)) throw new Error("unexpected fetch " + url);
  return jsonResponse({ messages: [{ id: "wamid.x" }], id: "re_1" });
});
const calls = (re: RegExp) => ((g.__fetchLog || []) as Array<{ url: string }>).filter((f) => re.test(f.url)).length;

Deno.test("trialEmailGate: clear answers pass through; error / odd reply -> null (pre-0212 rule)", async () => {
  const mk = (r: any) => ({ rpc: () => Promise.resolve(r) });
  assertEquals(await trialEmailGate(mk({ data: { allowed: true, trial: true }, error: null }), { org: ORG }, "a@b.co", "approval_link"), { allowed: true, trial: true, reason: undefined });
  assertEquals(await trialEmailGate(mk({ data: { allowed: false, trial: true, reason: "cap_studio" }, error: null }), { org: ORG }, "a@b.co", "otp"),
    { allowed: false, trial: true, reason: "cap_studio" });
  assertEquals(await trialEmailGate(mk({ data: null, error: { code: "PGRST202" } }), { org: ORG }, "a@b.co", "otp"), null, "0212 missing");
  assertEquals(await trialEmailGate(mk({ data: null, error: { code: "XX000" } }), { org: ORG }, "a@b.co", "otp"), null, "db error");
  assertEquals(await trialEmailGate(mk({ data: { stored: true }, error: null }), { org: ORG }, "a@b.co", "otp"), null, "odd reply");
  assertEquals(await trialEmailGate({ rpc: () => Promise.reject(new Error("down")) }, { org: ORG }, "a@b.co", "otp"), null, "throws");
});

Deno.test("client-mailer: ACTIVE trial + gate allows -> the e-mail really goes out (trial: true), logged sent", async () => {
  resetSupaMock(); db({ allowed: true, trial: true });
  const rEnv = setEnv(ENV); const rF = providers();
  try {
    const h = await loadHandler(MAILER);
    const res = await h(post({ quote_id: QUOTE, kind: "approval" }, AUTH));
    assertEquals(res.status, 200);
    const j = await res.json();
    assertEquals(j.status, "sent"); assertEquals(j.trial, true);
    assertEquals(calls(/resend/), 1); assertEquals(calls(/msg91|graph\.facebook/), 0);
    const gate = supaLog().find((e) => e.rpc === "trial_email_gate");
    assert(gate && gate.key === "service-role-secret", "gate asked with the service role");
    assertEquals(gate.args.p_kind, "approval_link"); assertEquals(gate.args.p_recipient, "asha@client.test");
    assert(supaLog().some((e) => e.table === "notifications" && JSON.stringify(e.calls).includes('"sent"')));
  } finally { rF(); rEnv(); }
});

Deno.test("client-mailer: trial over the cap -> 429 limit; demo -> demo; ended trial -> test_mode; nothing sent", async () => {
  const rEnv = setEnv(ENV); const rF = providers();
  try {
    resetSupaMock(); db({ allowed: false, trial: true, reason: "cap_recipient" });
    let h = await loadHandler(MAILER);
    let res = await h(post({ quote_id: QUOTE, kind: "approval" }, AUTH));
    assertEquals(res.status, 429); let j = await res.json(); assertEquals(j.status, "limit"); assert(/limit/i.test(j.reason));
    resetSupaMock(); db({ allowed: false, trial: true, reason: "demo" });
    h = await loadHandler(MAILER);
    res = await h(post({ quote_id: QUOTE, kind: "approval" }, AUTH));
    j = await res.json(); assertEquals(j.status, "demo");
    resetSupaMock(); db({ allowed: false, trial: true, reason: "trial_no_send" });
    h = await loadHandler(MAILER);
    res = await h(post({ quote_id: QUOTE, kind: "approval" }, AUTH));
    j = await res.json(); assertEquals(j.status, "test_mode");
    assertEquals(calls(/resend|msg91|graph\.facebook/), 0);
  } finally { rF(); rEnv(); }
});

Deno.test("client-mailer: gate gives no clear answer -> pre-0212 rule, the trial sends nothing", async () => {
  resetSupaMock(); db(null);
  const rEnv = setEnv(ENV); const rF = providers();
  try {
    const h = await loadHandler(MAILER);
    const j = await (await h(post({ quote_id: QUOTE, kind: "booklet" }, AUTH))).json();
    assert(j.status === "test_mode" || j.status === "failed", j.status);
    assertEquals(calls(/resend|msg91|graph\.facebook/), 0);
  } finally { rF(); rEnv(); }
});

// R113 (0322, owner decision): a free trial (active or ended) gets NO approval code on any channel - test mode instead
// (the client uses the test code 000000 on the approval page). The 0212 trial e-mail code path is no longer called.
Deno.test("send-otp: R113 trial -> NO code on any channel (e-mail / WhatsApp / SMS): 403 test_mode, nothing stored or sent", async () => {
  resetSupaMock(); db(null);
  const rEnv = setEnv(ENV); const rF = providers();
  try {
    const h = await loadHandler(OTP);
    for (const body of [{ token: TOKEN, channel: "email" }, { token: TOKEN, channel: "whatsapp" }, { token: TOKEN, phone: "+91 98000 00001" }]) {
      const r = await h(post(body));
      assertEquals(r.status, 403);
      const j = await r.json(); assertEquals(j.trial, true); assertEquals(j.test_mode, true);
      assert(/000000/.test(String(j.error)), "says to use the test code");
    }
    assert(!supaLog().some((e) => e.rpc === "trial_email_otp_begin"), "0212 trial e-mail code path not called");
    assert(!supaLog().some((e) => e.rpc === "admin_store_otp"), "no code stored");
    assertEquals(calls(/resend|msg91|graph\.facebook/), 0);
  } finally { rF(); rEnv(); }
});

Deno.test("send-otp: R113 - a database refusal of the store step (0322 trigger, trial_no_send) -> 403 test_mode, nothing sent", async () => {
  const rEnv = setEnv(ENV); const rF = providers();
  try {
    resetSupaMock();
    g.__supaGetUser = () => ({ data: { user: null } });
    g.__supaRpc = (name: string) => {
      if (name === "trial_send_blocked") return { data: false, error: null };   // e.g. the trial started a moment ago
      if (name === "public_quote_ready") return { data: { priced: true, studio: "S" }, error: null };
      if (name === "wa_otp_begin") return { data: DEST, error: null };
      if (name === "otp_send_authorize") return { data: { ok: true }, error: null };
      if (name === "admin_store_otp") return { data: null, error: { code: "42501", hint: "trial_no_send", message: "x" } };
      return { data: null, error: null };
    };
    g.__supaResolver = () => ({ data: null, error: null });
    const h = await loadHandler(OTP);
    const res = await h(post({ token: TOKEN, channel: "email" }));
    assertEquals(res.status, 403); const j = await res.json(); assertEquals(j.trial, true); assertEquals(j.test_mode, true);
    assertEquals(calls(/resend|msg91|graph\.facebook/), 0);
  } finally { rF(); rEnv(); }
});

Deno.test("comms-dispatch: a trial-marked row is sent only as a link e-mail", () => {
  assert(trialRowAllowed("booklet_link", "email", { trial_email: true }));
  assert(trialRowAllowed("invite_site", "email", { trial_email: true }));
  assert(!trialRowAllowed("invite_site", "whatsapp", { trial_email: true }));
  assert(!trialRowAllowed("pay_reminder", "email", { trial_email: true }));
  assert(!trialRowAllowed("booklet_link", "email", { trial_email: "true" }), "only the boolean mark");
  assert(trialRowAllowed("pay_reminder", "whatsapp", { text: "x" }), "unmarked rows unaffected");
  assert(trialRowAllowed("wa_forward", "whatsapp", {}));
});
