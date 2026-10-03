// send-whatsapp — runtime-verified with mocked Meta Graph API + mocked Supabase auth/profiles.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  setEnv, installFetch, jsonResponse, textResponse, loadHandler, post,
  resetSupaMock, fetchLog, captureConsoleError,
} from "./harness.ts";

const FN = "../../supabase/functions/send-whatsapp/index.ts";
const g = globalThis as any;

const CONFIGURED = {
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  WHATSAPP_TOKEN: "meta-secret-token",
  WHATSAPP_PHONE_ID: "123456",
  WHATSAPP_API_VERSION: "v21.0",
};

// getUser/profiles behaviour by JWT value
function staffAuth() {
  g.__supaGetUser = (jwt: string) => jwt ? ({ data: { user: { id: "u1" } } }) : ({ data: { user: null } });
  g.__supaResolver = (table: string) => table === "profiles"
    ? ({ data: { role: "manager" }, error: null })
    : ({ data: null, error: null });
}
function nonStaffAuth() {
  g.__supaGetUser = () => ({ data: { user: { id: "u2" } } });
  g.__supaResolver = (table: string) => table === "profiles"
    ? ({ data: { role: "client" }, error: null })
    : ({ data: null, error: null });
}

Deno.test("send-whatsapp: not configured (no TOKEN) -> 500", async () => {
  resetSupaMock();
  const rEnv = setEnv({ SUPABASE_URL: "x", SUPABASE_SERVICE_ROLE_KEY: "y" });
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ ping: true }))).status, 500);
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: no JWT -> 401 denied, Meta never called", async () => {
  resetSupaMock();
  g.__supaGetUser = () => ({ data: { user: null } });
  const rEnv = setEnv(CONFIGURED);
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({}); });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ number: "919999999999", text: "hi" })); // no Authorization header
    assertEquals(res.status, 401);
    assert(!fetched, "Meta must not be called for anonymous caller");
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: non-staff JWT (role=client) -> 401 denied", async () => {
  resetSupaMock();
  nonStaffAuth();
  const rEnv = setEnv(CONFIGURED);
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({}); });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ number: "919999999999", text: "hi" }, { authorization: "Bearer usertoken" }));
    assertEquals(res.status, 401);
    assert(!fetched);
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: staff text message -> allowed, 200, Meta messages endpoint hit", async () => {
  resetSupaMock();
  staffAuth();
  const rEnv = setEnv(CONFIGURED);
  const rF = installFetch((url) => {
    assert(url.startsWith("https://graph.facebook.com/"), "only Meta Graph may be called");
    assert(url.endsWith("/messages"));
    return jsonResponse({ messages: [{ id: "wamid.abc" }] });
  });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ number: "91-99999 99999", text: "hi" }, { authorization: "Bearer usertoken" }));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).sent, true);
    const body = JSON.parse((fetchLog()[0].init as any).body);
    assertEquals(body.to, "919999999999"); // normalised digits
    assertEquals(body.type, "text");
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: provider failure -> 502 generic error, provider body NOT leaked", async () => {
  resetSupaMock();
  staffAuth();
  const rEnv = setEnv(CONFIGURED);
  const rF = installFetch(() => textResponse(JSON.stringify({ error: { message: "META_SECRET_REASON_42" } }), 400));
  try {
    const h = await loadHandler(FN);
    const { result: res, logs } = await captureConsoleError(async () =>
      h(post({ number: "919999999999", text: "hi" }, { authorization: "Bearer usertoken" })));
    assertEquals(res.status, 502);
    const body = await res.json();
    assertEquals(body.error, "whatsapp send failed");
    assert(!JSON.stringify(body).includes("META_SECRET_REASON_42"), "provider body must not leak to client");
    assert(logs.join(" ").includes("whatsapp send failed"), "logged server-side");
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: ping does credential check (GET), no message send", async () => {
  resetSupaMock();
  staffAuth();
  const rEnv = setEnv(CONFIGURED);
  const rF = installFetch((url, init) => {
    assert(!(init && init.method === "POST"), "ping must be a GET");
    assert(url.includes("fields=verified_name"));
    return jsonResponse({ display_phone_number: "+91..." });
  });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ ping: true }, { authorization: "Bearer usertoken" }));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).ok, true);
  } finally { rF(); rEnv(); }
});

Deno.test("send-whatsapp: missing text and template -> 400", async () => {
  resetSupaMock();
  staffAuth();
  const rEnv = setEnv(CONFIGURED);
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ number: "919999999999" }, { authorization: "Bearer usertoken" }));
    assertEquals(res.status, 400);
  } finally { rF(); rEnv(); }
});
