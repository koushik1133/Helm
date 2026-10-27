// send-whatsapp — runtime-verified with mocked Meta Graph API + mocked Supabase.
// Audit Phase 8: no open relay — the caller's JWT (not the service role) proves the
// event + number; templates are allowlisted; sends are logged with channel 'whatsapp'.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  setEnv, installFetch, jsonResponse, loadHandler, post, resetSupaMock, supaLog, captureConsoleError,
} from "./harness.ts";

const FN = "../../supabase/functions/send-whatsapp/index.ts";
const g = globalThis as any;
const QUOTE = "a0000000-0000-4000-8000-00000000da01";
const AUTH = { authorization: "Bearer user-jwt" };

const CONFIGURED = {
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  WHATSAPP_TOKEN: "meta-secret-token",
  WHATSAPP_PHONE_ID: "123456",
  WHATSAPP_API_VERSION: "v21.0",
};

const ORG = "b0000000-0000-4000-8000-00000000da02";
// signed-in user; quote visible under RLS; whatsapp_authorize says yes; PAID studio,
// number not opted out (audit run-3 recipient binding - see the dedicated tests below)
function allowAll(to = "919800000001", opts: { paid?: boolean; optIn?: boolean; optedOut?: boolean } = {}) {
  const { paid = true, optIn = false, optedOut = false } = opts;
  g.__supaGetUser = (jwt: string) => jwt === "user-jwt" ? ({ data: { user: { id: "u1" } } }) : ({ data: { user: null } });
  g.__supaResolver = (table: string) => {
    if (table === "quotes") return { data: { id: QUOTE, org_id: ORG }, error: null };
    if (table === "studio_subscriptions") return { data: paid ? { status: "active" } : { status: "trial" }, error: null };
    if (table === "whatsapp_opt_outs") return { data: optedOut ? { id: 1 } : null, error: null };
    if (table === "wa_proposal_optins") return { data: optIn ? { id: 7 } : null, error: null };
    return { data: null, error: null };
  };
  g.__supaRpc = (name: string) => name === "whatsapp_authorize" ? ({ data: { ok: true, to }, error: null }) : ({ data: null, error: null });
}
const metaOk = () => installFetch((url) => {
  assert(url.startsWith("https://graph.facebook.com/"), "only Meta Graph may be called");
  return jsonResponse({ messages: [{ id: "wamid.abc" }] });
});

Deno.test("send-whatsapp: not configured (no TOKEN) -> 500", async () => {
  resetSupaMock();
  const rEnv = setEnv({ SUPABASE_URL: "x", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "y" });
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ ping: true }, AUTH))).status, 500);
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: no JWT / the anon key -> 401, Meta never called", async () => {
  resetSupaMock();
  allowAll();
  const rEnv = setEnv(CONFIGURED);
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({}); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update" }))).status, 401);
    assertEquals((await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update" }, { authorization: "Bearer anon-key" }))).status, 401);
    assert(!fetched);
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: OPEN RELAY attempt (no quote_id) -> 400, Meta never called", async () => {
  resetSupaMock();
  allowAll();
  const rEnv = setEnv(CONFIGURED);
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({}); });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ number: "447700900123", template: "event_update" }, AUTH));
    assertEquals(res.status, 400);
    assert(!fetched);
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: number not on the event (whatsapp_authorize refuses) -> 403, Meta never called", async () => {
  resetSupaMock();
  allowAll();
  g.__supaRpc = () => ({ data: null, error: { code: "42501", message: "that number is not on this event" } });
  const rEnv = setEnv(CONFIGURED);
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({}); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ quote_id: QUOTE, number: "447700900123", template: "event_update" }, AUTH))).status, 403);
    assert(!fetched);
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: other studio's quote (hidden by RLS) -> 403", async () => {
  resetSupaMock();
  allowAll();
  g.__supaResolver = () => ({ data: null, error: null });
  const rEnv = setEnv(CONFIGURED);
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update" }, AUTH))).status, 403);
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: studio rate limit -> 429", async () => {
  resetSupaMock();
  allowAll();
  g.__supaRpc = () => ({ data: null, error: { code: "HL429", message: "limit" } });
  const rEnv = setEnv(CONFIGURED);
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update" }, AUTH))).status, 429);
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: template not on the allowlist / free text by default -> 400", async () => {
  resetSupaMock();
  allowAll();
  const rEnv = setEnv(CONFIGURED);
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ quote_id: QUOTE, number: "919800000001", template: "marketing_blast" }, AUTH))).status, 400);
    assertEquals((await h(post({ quote_id: QUOTE, number: "919800000001", text: "buy now" }, AUTH))).status, 400);
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: authorization runs with the CALLER's JWT (never the service role)", async () => {
  resetSupaMock();
  allowAll();
  const rEnv = setEnv(CONFIGURED);
  const rF = metaOk();
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ quote_id: QUOTE, number: "+91 98000 00001", template: "event_update", params: ["A"] }, AUTH));
    assertEquals(res.status, 200);
    const log = supaLog();
    const authz = log.find((e) => e.rpc === "whatsapp_authorize");
    assert(authz, "whatsapp_authorize must be called");
    assertEquals(authz.key, "anon-key", "authorization must use the caller-scoped client");
    assert(log.some((e) => e.createClient === "anon-key" && e.authHeader === "Bearer user-jwt"), "caller client must carry the user JWT");
    const q = log.find((e) => e.table === "quotes");
    assertEquals(q.key, "anon-key", "quote ownership must be checked under RLS");
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: sends to the server-approved number; logged with channel 'whatsapp'", async () => {
  resetSupaMock();
  allowAll("919800000001");
  const rEnv = setEnv(CONFIGURED);
  let to = "";
  const rF = installFetch((url, init) => {
    assert(url.endsWith("/messages"));
    to = JSON.parse(String(init?.body)).to;
    return jsonResponse({ messages: [{ id: "wamid.abc" }] });
  });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ quote_id: QUOTE, number: "098000 00001", template: "event_update" }, AUTH));
    assertEquals(res.status, 200);
    assertEquals(to, "919800000001");
    const ins = supaLog().find((e) => e.table === "notifications");
    const row = ins.calls.find((c: any) => c[0] === "insert")[1][0];
    assertEquals(row.channel, "whatsapp");
    assertEquals(row.quote_id, QUOTE);
    assertEquals(ins.key, "service-role-secret");
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: token never echoed or logged; Meta failure -> 502 generic", async () => {
  resetSupaMock();
  allowAll();
  const rEnv = setEnv(CONFIGURED);
  const rF = installFetch(() => jsonResponse({ error: { message: "meta-secret-token invalid for 919800000001" } }, 400));
  try {
    const h = await loadHandler(FN);
    const { result: res, logs } = await captureConsoleError(() =>
      Promise.resolve(h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update" }, AUTH))));
    assertEquals(res.status, 502);
    const txt = JSON.stringify(await res.json()) + logs.join(" ");
    assert(!txt.includes("meta-secret-token") && !txt.includes("919800000001"));
  } finally { rF(); rEnv(); }
});

// ---- audit run-3 edge/send-whatsapp/staff-editable-recipient-binding-relay ----------
Deno.test("send-whatsapp: a number that sent STOP is refused (403), Meta never called", async () => {
  resetSupaMock();
  allowAll("919800000001", { optedOut: true });
  const rEnv = setEnv(CONFIGURED);
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({}); });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update" }, AUTH));
    assertEquals(res.status, 403);
    assert(!fetched);
    const oo = supaLog().find((e) => e.table === "whatsapp_opt_outs");
    assertEquals(oo.key, "service-role-secret");
    assert(oo.calls.some((c: any) => c[0] === "eq" && c[1][0] === "phone" && c[1][1] === "919800000001"));
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: UNPAID (trial) studio needs a recorded opt-in for this event", async () => {
  resetSupaMock();
  allowAll("919800000001", { paid: false, optIn: false });
  const rEnv = setEnv(CONFIGURED);
  let fetched = 0;
  const rF = installFetch(() => { fetched++; return jsonResponse({ messages: [{ id: "wamid.x" }] }); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update" }, AUTH))).status, 403);
    assertEquals(fetched, 0);
    allowAll("919800000001", { paid: false, optIn: true });
    assertEquals((await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update" }, AUTH))).status, 200);
    assertEquals(fetched, 1);
    const oi = supaLog().find((e) => e.table === "wa_proposal_optins");
    assert(oi.calls.some((c: any) => c[0] === "eq" && c[1][0] === "phone_e164" && c[1][1] === "+919800000001"));
    assert(oi.calls.some((c: any) => c[0] === "eq" && c[1][0] === "quote_id" && c[1][1] === QUOTE));
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: WHATSAPP_REQUIRE_OPTIN=1 applies the opt-in rule to paid studios too", async () => {
  resetSupaMock();
  allowAll("919800000001", { paid: true, optIn: false });
  const rEnv = setEnv({ ...CONFIGURED, WHATSAPP_REQUIRE_OPTIN: "1" });
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update" }, AUTH))).status, 403);
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: template params - links, line breaks, over-long, >10 and objects refused (400)", async () => {
  resetSupaMock();
  allowAll();
  const rEnv = setEnv(CONFIGURED);
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    for (const params of [["pay at https://evil.example/x"], ["visit www.evil.example"], ["wa.me/919800000001"], ["login at helm-pay.com now"],
      ["line one\nline two"], ["tab\there"], ["x".repeat(201)], Array(11).fill("a"), [{ a: 1 }], ["too     many spaces"]]) {
      const res = await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update", params }, AUTH));
      assertEquals(res.status, 400, JSON.stringify(params));
    }
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: ordinary params (names, dates, amounts) still send", async () => {
  resetSupaMock();
  allowAll();
  const rEnv = setEnv(CONFIGURED);
  let sentParams: any = null;
  const rF = installFetch((_u, init) => { sentParams = JSON.parse(String(init?.body)).template.components[0].parameters; return jsonResponse({ messages: [{ id: "w" }] }); });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ quote_id: QUOTE, number: "919800000001", template: "payment_reminder", params: ["Priya & Rahul", "12 Dec 2026, 7:30 PM", "Rs. 1,25,000.50", 3] }, AUTH));
    assertEquals(res.status, 200);
    assertEquals(sentParams.map((p: any) => p.text), ["Priya & Rahul", "12 Dec 2026, 7:30 PM", "Rs. 1,25,000.50", "3"]);
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: distinct recipients per studio per day are capped (429)", async () => {
  resetSupaMock();
  const rEnv = setEnv({ ...CONFIGURED, WHATSAPP_DISTINCT_PER_DAY_PAID: "2" });
  let fetched = 0;
  const rF = installFetch(() => { fetched++; return jsonResponse({ messages: [{ id: "w" }] }); });
  try {
    const h = await loadHandler(FN);
    const send = (to: string) => { allowAll(to); return h(post({ quote_id: QUOTE, number: to, template: "event_update" }, AUTH)); };
    assertEquals((await send("919800000001")).status, 200);
    assertEquals((await send("919800000002")).status, 200);
    const third = await send("919800000003");
    assertEquals(third.status, 429);
    assert(Number(third.headers.get("Retry-After")) > 0);
    assertEquals(fetched, 2);
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: unpaid studios have a low daily total", async () => {
  resetSupaMock();
  const rEnv = setEnv({ ...CONFIGURED, WHATSAPP_UNPAID_PER_DAY: "1" });
  const rF = installFetch(() => jsonResponse({ messages: [{ id: "w" }] }));
  try {
    const h = await loadHandler(FN);
    allowAll("919800000001", { paid: false, optIn: true });
    assertEquals((await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update" }, AUTH))).status, 200);
    assertEquals((await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update" }, AUTH))).status, 429);
  } finally { rF(); rEnv(); }
});

// ---- audit run-3 (0155) DB refusals are mapped; ONE param rule set (Helm links only, control chars rejected) ----
Deno.test("send-whatsapp: number replied STOP (HL451) -> 409, Meta never called", async () => {
  resetSupaMock();
  allowAll();
  g.__supaRpc = () => ({ data: null, error: { code: "HL451", message: "this person replied STOP", hint: "opted_out" } });
  const rEnv = setEnv(CONFIGURED);
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update" }, AUTH));
    assertEquals(res.status, 409);
    assert(/STOP/.test((await res.json()).error));
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: unpaid trial without opt-in -> 403 with the reason", async () => {
  resetSupaMock();
  allowAll();
  g.__supaRpc = () => ({ data: null, error: { code: "42501", message: "trial", hint: "trial_optin" } });
  const rEnv = setEnv(CONFIGURED);
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update" }, AUTH));
    assertEquals(res.status, 403);
    assert(/free trial/.test((await res.json()).error));
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: a template value linking to another site -> 400, Meta never called", async () => {
  resetSupaMock();
  allowAll();
  const rEnv = setEnv(CONFIGURED);
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    for (const bad of ["pay at https://evil.example/pay", "see www.evil.example", "go evil.example/login", "HTTPS://helm.events.evil.example/x"]) {
      const res = await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update", params: ["Hi", bad] }, AUTH));
      assertEquals(res.status, 400, bad);
    }
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: R32 free text (WHATSAPP_ALLOW_TEXT=1) may link only to the Helm site", async () => {
  resetSupaMock();
  allowAll();
  const rEnv = setEnv({ ...CONFIGURED, WHATSAPP_ALLOW_TEXT: "1" });
  let sent: any = null, calls = 0;
  const rF = installFetch((_url, init) => { calls++; sent = JSON.parse(String(init?.body)); return jsonResponse({ messages: [{ id: "wamid.t" }] }); });
  try {
    const h = await loadHandler(FN);
    for (const bad of ["Urgent: verify at https://evil-phishing.example/login", "see www.evil.example", "go evil.example/login",
                       "HTTPS://helm.events.evil.example/x", "https://user@evil.example/", "ftp://www.helm.events/x"]) {
      const res = await h(post({ quote_id: QUOTE, number: "919800000001", text: bad }, AUTH));
      assertEquals(res.status, 400, bad);
    }
    assertEquals(calls, 0, "Meta never called for an off-site link");
    const ok = await h(post({ quote_id: QUOTE, number: "919800000001",
      text: "Hi Priya,\nyour proposal: https://www.helm.events/p/abc\nSee you Saturday" }, AUTH));
    assertEquals(ok.status, 200);
    assertEquals(sent.type, "text");
    assertEquals(sent.text.body, "Hi Priya,\nyour proposal: https://www.helm.events/p/abc\nSee you Saturday");
    assertEquals((await h(post({ quote_id: QUOTE, number: "919800000001", text: "Thanks, confirmed for 5 pm" }, AUTH))).status, 200);
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: R32 SRV-3 bare domains with ANY ending (evil.ru, helm-pay.shop) are links too", async () => {
  resetSupaMock();
  allowAll();
  const rEnv = setEnv({ ...CONFIGURED, WHATSAPP_ALLOW_TEXT: "1" });
  let calls = 0;
  const rF = installFetch(() => { calls++; return jsonResponse({ messages: [{ id: "wamid.t" }] }); });
  try {
    const h = await loadHandler(FN);
    for (const bad of ["see evil.ru", "pay at helm-pay.shop", "evil.tk", "evil.ru/x", "verify on secure-login.top today"]) {
      assertEquals((await h(post({ quote_id: QUOTE, number: "919800000001", text: bad }, AUTH))).status, 400, "text: " + bad);
      assertEquals((await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update", params: [bad] }, AUTH))).status, 400, "param: " + bad);
    }
    assertEquals(calls, 0, "Meta never called");
    for (const ok of ["Hi Priya, see helm.events", "open app.helm.events/x", "Advance Rs. 500 received, thanks", "Starts 5.30 pm"]) {
      assertEquals((await h(post({ quote_id: QUOTE, number: "919800000001", text: ok }, AUTH))).status, 200, ok);
    }
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: a Helm proposal link is allowed; control characters are rejected, not cleaned", async () => {
  resetSupaMock();
  allowAll();
  const rEnv = setEnv(CONFIGURED);
  let sent: any = null;
  const rF = installFetch((_url, init) => { sent = JSON.parse(String(init?.body)); return jsonResponse({ messages: [{ id: "wamid.x" }] }); });
  try {
    const h = await loadHandler(FN);
    const ok = await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update",
      params: ["Priya", "https://www.helm.events/approve?token=x", "helm.events/p/abc"] }, AUTH));
    assertEquals(ok.status, 200);
    assertEquals(sent.template.components[0].parameters[1].text, "https://www.helm.events/approve?token=x");
    for (const bad of ["bell\u0007", "a\u0085b", "line sep", "https://user@evil.example/", "javascript://www.helm.events", "ftp://www.helm.events/x"]) {
      const res = await h(post({ quote_id: QUOTE, number: "919800000001", template: "event_update", params: [bad] }, AUTH));
      assertEquals(res.status, 400, JSON.stringify(bad));
    }
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: unpaid default is 3 new numbers a day; a current payment counts as paid", async () => {
  resetSupaMock();
  const rEnv = setEnv(CONFIGURED);
  let fetched = 0;
  const rF = installFetch(() => { fetched++; return jsonResponse({ messages: [{ id: "w" }] }); });
  try {
    const h = await loadHandler(FN);
    const send = (to: string) => { allowAll(to, { paid: false, optIn: true }); return h(post({ quote_id: QUOTE, number: to, template: "event_update" }, AUTH)); };
    for (const n of ["919800000011", "919800000012", "919800000013"]) assertEquals((await send(n)).status, 200);
    assertEquals((await send("919800000014")).status, 429);
    assertEquals(fetched, 3);
    // trial status but a current payment row -> paid rules (no opt-in needed)
    allowAll("919800000015", { paid: false, optIn: false });
    const base = g.__supaResolver;
    g.__supaResolver = (t: string, c: any, k: any) => t === "subscription_payments" ? { data: { id: 1 }, error: null } : base(t, c, k);
    assertEquals((await h(post({ quote_id: QUOTE, number: "919800000015", template: "event_update" }, AUTH))).status, 200);
  } finally { rF(); rEnv(); }
});

// ---- R32b: ONE link rule (R2-INJ-01 userinfo / backslash, R2-INJ-02 names, R2-SRV-01 separators / IDN / unicode dots) ----
// Every bypass string from both round-2 reports. Each must be refused - as a template value AND as free text.
const R32B_BYPASSES = [
  // R2-INJ-01: "@" after ?, #, \ - the old rule took the host after the first "@"
  "https://evil.com?@helm.events", "https://evil.com?@helm.events/pay", "https://evil.com#@helm.events", "https://evil.com#@www.helm.events",
  "https://evil.com\\@helm.events", "https://evil.com\\@helm.events/x", "http://evil.com\\@www.helm.events", "evil.com?@helm.events",
  "evil.ru", "helm-pay.shop", "evil.xn--p1ai", "evil。com", "https://1.2.3.4/x", "1.2.3.4/x", "1.2.3.4", "//evil.com", "hxxps://evil.com", "ftp://evil.com",
  // R2-SRV-01: round-1 originals, upper case, punctuation, userinfo
  "see evil.com", "see evil.ru", "pay at helm-pay.shop", "evil.tk", "https://evil.com", "evil.ru/x",
  "PAY AT EVIL.RU", "HTTPS://EVIL.COM/x", "evil.com.", "(evil.com)", "evil.com,", "*evil.com*", "~evil.com~",
  "helm.events@evil.com", "https://helm.events:443@evil.com/p", "https://helm.events.evil.com", "evilhelm.events",
  // unicode dots / IDN / homographs
  "evil。com", "evil．com", "evil｡com", "еvil.com", "һelm.events", "xn--e1afmkfd.xn--p1ai",
  "пример.рф", "evil.онлайн", "helm.events.рф",
  // separator tricks: a linkifier stops earlier than the old whitespace-token rule
  "evil.com,x@helm.events", "evil.com|x@helm.events", "evil.com)@helm.events", "evil.com\\@helm.events",
  "_evil.com_", "_pay at evil.ru_", "x_evil.com", "evil​.com", "ev­il.com", "evil.com-",
  // the earlier R32 cases stay refused
  "https://user@evil.example/", "javascript://www.helm.events", "ftp://www.helm.events/x", "go evil.example/login", "see www.evil.example",
];
const R32B_ALLOWED = [
  "https://www.helm.events/pay/abc", "www.helm.events/i/slug", "helm.events", "Pay: https://www.helm.events/q?t=1.", "app.helm.events/x",
  "(https://www.helm.events/p)", "Rs. 5,000.00 due", "v2.0 ready", "Hall No.5 at 6.30pm", "Call K.Srinivas", "Crew: K.Srinivas", "Dr.Rao",
  "Venue: Hotel.Grand", "Rs.5000", "10.30am", "No.5", "Advance Rs. 500 received, thanks", "Starts 5.30 pm", "Priya & Arjun",
];

async function waModule(): Promise<any> {
  const orig = (Deno as any).serve;
  (Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown() {}, ref() {}, unref() {} });
  try { return await import(`${FN}?v=${crypto.randomUUID()}`); } finally { (Deno as any).serve = orig; }
}

Deno.test("send-whatsapp: R32b every round-2 link bypass is refused; names / amounts / versions pass (unit)", async () => {
  const rEnv = setEnv(CONFIGURED);
  try {
    const m = await waModule();
    const missed = R32B_BYPASSES.filter((v) => !m.offSiteLink(v, "www.helm.events") || !m.paramProblem(v, "www.helm.events"));
    assertEquals(missed, [], "bypasses not refused");
    const blocked = R32B_ALLOWED.filter((v) => m.offSiteLink(v, "www.helm.events") || m.paramProblem(v, "www.helm.events"));
    assertEquals(blocked, [], "plain text wrongly refused");
  } finally { rEnv(); }
});

Deno.test("send-whatsapp: R32b bypasses refused end-to-end (free text + template value, Meta never called); names send", async () => {
  resetSupaMock();
  allowAll();
  const rEnv = setEnv({ ...CONFIGURED, WHATSAPP_ALLOW_TEXT: "1" });
  let calls = 0;
  const rF = installFetch(() => { calls++; return jsonResponse({ messages: [{ id: "wamid.t" }] }); });
  try {
    let h = await loadHandler(FN), n = 0;
    const send = async (body: Record<string, unknown>) => {
      if (++n % 12 === 0) h = await loadHandler(FN);   // stay under the per-user limit of 30 a minute
      return (await h(post({ quote_id: QUOTE, number: "919800000001", ...body }, AUTH))).status;
    };
    for (const bad of R32B_BYPASSES) {
      assertEquals(await send({ text: "Hi " + bad }), 400, "text: " + JSON.stringify(bad));
      assertEquals(await send({ template: "event_update", params: ["Priya", bad] }), 400, "param: " + JSON.stringify(bad));
    }
    assertEquals(calls, 0, "Meta never called");
    for (const ok of R32B_ALLOWED) {
      assertEquals(await send({ template: "event_update", params: [ok] }), 200, "param: " + ok);
    }
  } finally { rF(); rEnv(); }
});
