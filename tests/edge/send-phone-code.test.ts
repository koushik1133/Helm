// send-phone-code - audit run-3 edge/send-phone-code/uncapped-paid-auth-messages.
// Mocked Meta Graph + mocked Supabase: aggregate spend caps (global, per destination
// country, per studio), confirmed-account requirement and optional country allowlist.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, post, resetSupaMock, supaLog } from "./harness.ts";

const FN = "../../supabase/functions/send-phone-code/index.ts";
const g = globalThis as any;
const AUTH = { authorization: "Bearer user-jwt" };
const ORG = "c0000000-0000-4000-8000-0000000000aa";
const CONFIGURED = {
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  WHATSAPP_TOKEN: "meta-secret-token",
  WHATSAPP_PHONE_ID: "123456",
};

function signedIn(opts: { confirmed?: boolean; org?: string | null; uid?: string } = {}) {
  const { confirmed = true, org = ORG, uid = "u1" } = opts;
  g.__supaGetUser = (jwt: string) => jwt === "user-jwt"
    ? ({ data: { user: { id: uid, email_confirmed_at: confirmed ? "2026-10-01T00:00:00Z" : null } } }) : ({ data: { user: null } });
  g.__supaResolver = (table: string) => table === "profiles" ? ({ data: { org_id: org }, error: null }) : ({ data: null, error: null });
  g.__supaRpc = (name: string, args: any) => name === "phone_verify_request"
    ? ({ data: { code: "123456", phone: args.p_phone, expires_in: 600, resend_after: 60 }, error: null }) : ({ data: null, error: null });
}
const meta = () => { const sent: string[] = []; const r = installFetch((url, init) => {
  assert(url.startsWith("https://graph.facebook.com/"), "only Meta Graph may be called");
  sent.push(JSON.parse(String(init?.body)).to); return jsonResponse({ messages: [{ id: "wamid.1" }] }); }); return { sent, restore: r }; };

Deno.test("send-phone-code: happy path sends one code", async () => {
  resetSupaMock(); signedIn();
  const rEnv = setEnv(CONFIGURED); const m = meta();
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ phone: "+919800000001" }, AUTH));
    assertEquals(res.status, 200);
    assertEquals(m.sent, ["919800000001"]);
    const p = supaLog().find((e) => e.table === "profiles");
    assertEquals(p.key, "service-role-secret");
  } finally { m.restore(); rEnv(); }
});

Deno.test("send-phone-code: an account with no confirmed e-mail / phone is refused (403), no code minted", async () => {
  resetSupaMock(); signedIn({ confirmed: false });
  const rEnv = setEnv(CONFIGURED); const m = meta();
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ phone: "+919800000001" }, AUTH))).status, 403);
    assertEquals(m.sent.length, 0);
    assert(!supaLog().some((e) => e.rpc === "phone_verify_request"));
  } finally { m.restore(); rEnv(); }
});

Deno.test("send-phone-code: PHONE_CODE_ALLOWED_CC refuses other countries (400)", async () => {
  resetSupaMock(); signedIn();
  const rEnv = setEnv({ ...CONFIGURED, PHONE_CODE_ALLOWED_CC: "91,971" }); const m = meta();
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ phone: "+447700900123" }, AUTH))).status, 400);
    assertEquals((await h(post({ phone: "+971501234567" }, AUTH))).status, 200);
    assertEquals(m.sent, ["971501234567"]);
  } finally { m.restore(); rEnv(); }
});

Deno.test("send-phone-code: per-country cap for non-home countries (429)", async () => {
  resetSupaMock();
  const rEnv = setEnv({ ...CONFIGURED, PHONE_CODE_COUNTRY_PER_DAY: "1" }); const m = meta();
  try {
    const h = await loadHandler(FN);
    signedIn({ uid: "u1" }); assertEquals((await h(post({ phone: "+447700900001" }, AUTH))).status, 200);
    signedIn({ uid: "u2", org: "c0000000-0000-4000-8000-0000000000bb" });
    const r = await h(post({ phone: "+447700900002" }, AUTH));
    assertEquals(r.status, 429);
    assert(Number(r.headers.get("Retry-After")) > 0);
    // a home country (India) is under its own, larger bucket
    signedIn({ uid: "u3", org: "c0000000-0000-4000-8000-0000000000cc" });
    assertEquals((await h(post({ phone: "+919800000003" }, AUTH))).status, 200);
    assertEquals(m.sent.length, 2);
  } finally { m.restore(); rEnv(); }
});

Deno.test("send-phone-code: per-studio daily cap across members (429)", async () => {
  resetSupaMock();
  const rEnv = setEnv({ ...CONFIGURED, PHONE_CODE_ORG_PER_DAY: "2" }); const m = meta();
  try {
    const h = await loadHandler(FN);
    for (const [uid, ph] of [["u1", "+919800000011"], ["u2", "+919800000012"]]) { signedIn({ uid }); assertEquals((await h(post({ phone: ph }, AUTH))).status, 200); }
    signedIn({ uid: "u3" });
    assertEquals((await h(post({ phone: "+919800000013" }, AUTH))).status, 429);
    assertEquals(m.sent.length, 2);
  } finally { m.restore(); rEnv(); }
});

Deno.test("send-phone-code: Helm-wide daily cap (429)", async () => {
  resetSupaMock();
  const rEnv = setEnv({ ...CONFIGURED, PHONE_CODE_GLOBAL_PER_DAY: "1" }); const m = meta();
  try {
    const h = await loadHandler(FN);
    signedIn({ uid: "u1" }); assertEquals((await h(post({ phone: "+919800000021" }, AUTH))).status, 200);
    signedIn({ uid: "u9", org: "c0000000-0000-4000-8000-0000000000dd" });
    assertEquals((await h(post({ phone: "+971501234599" }, AUTH))).status, 429);
    assertEquals(m.sent.length, 1);
  } finally { m.restore(); rEnv(); }
});

Deno.test("send-phone-code: callingCode buckets E.164 numbers by country", async () => {
  const rEnv = setEnv(CONFIGURED);
  const origServe = (Deno as any).serve;
  (Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown() {}, ref() {}, unref() {} });
  let mod: any;
  try { mod = await import(FN + "?cc=" + crypto.randomUUID()); } finally { (Deno as any).serve = origServe; rEnv(); }
  const { callingCode } = mod;
  assertEquals(callingCode("+14155550100"), "1");
  assertEquals(callingCode("+79161234567"), "7");
  assertEquals(callingCode("+919800000001"), "91");
  assertEquals(callingCode("+971501234567"), "971");
  assertEquals(callingCode("+447700900123"), "44");
  assertEquals(callingCode("+2348012345678"), "234");
  assertEquals(callingCode("12"), "");
});
