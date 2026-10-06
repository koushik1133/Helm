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

// signed-in user; quote visible under RLS; whatsapp_authorize says yes
function allowAll(to = "919800000001") {
  g.__supaGetUser = (jwt: string) => jwt === "user-jwt" ? ({ data: { user: { id: "u1" } } }) : ({ data: { user: null } });
  g.__supaResolver = (table: string) => table === "quotes" ? ({ data: { id: QUOTE }, error: null }) : ({ data: null, error: null });
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
