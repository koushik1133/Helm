// r21 security: captcha-verify (Turnstile server check for Contact sales) + csp-report (CSP violation logs).
// Offline: fetch + supabase-js are mocked (harness.ts); no real Cloudflare / DB call.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchLog, installFetch, jsonResponse, loadHandler, post, resetSupaMock, setEnv, supaLog } from "./harness.ts";

const F = "../../supabase/functions/";
const g = globalThis as any;
const BASE = { SUPABASE_URL: "https://p.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "svc" };
const USER = { id: "11111111-1111-4111-8111-111111111111", email: "a@x.test" };
const TOKEN = "0.turnstile-token-abcdefghijklmnop";
const auth = { Authorization: "Bearer user-jwt", Origin: "https://www.helm.events" };

Deno.test("captcha-verify: no JWT / anon key -> 401; bad action / token -> 400 (before Cloudflare)", async () => {
  resetSupaMock(); const rEnv = setEnv({ ...BASE, TURNSTILE_SECRET_KEY: "sec" }); const rF = installFetch(() => { throw new Error("no fetch expected"); });
  g.__supaGetUser = () => ({ data: { user: USER } });
  try {
    const h = await loadHandler(F + "captcha-verify/index.ts");
    assertEquals((await h(post({ action: "sales", token: TOKEN }))).status, 401);
    assertEquals((await h(post({ action: "sales", token: TOKEN }, { Authorization: "Bearer anon" }))).status, 401);
    assertEquals((await h(post({ action: "trial", token: TOKEN }, auth))).status, 400);
    assertEquals((await h(post({ action: "sales", token: "x" }, auth))).status, 400);
    assertEquals(fetchLog().length, 0);
  } finally { rF(); rEnv(); delete g.__supaGetUser; }
});

Deno.test("captcha-verify: secret NOT configured -> fail OPEN { configured: false }, nothing recorded, no Cloudflare call", async () => {
  resetSupaMock(); const rEnv = setEnv({ ...BASE }); const rF = installFetch(() => { throw new Error("no fetch expected"); });
  g.__supaGetUser = () => ({ data: { user: USER } });
  try {
    const h = await loadHandler(F + "captcha-verify/index.ts");
    const r = await h(post({ action: "sales", token: TOKEN }, auth));
    assertEquals(r.status, 200);
    assertEquals(await r.json(), { ok: true, configured: false });
    assert(!supaLog().some((x: any) => x.rpc === "captcha_pass_record"));
  } finally { rF(); rEnv(); delete g.__supaGetUser; }
});

Deno.test("captcha-verify: configured + Cloudflare success -> pass recorded for THIS user with the service key", async () => {
  resetSupaMock(); const rEnv = setEnv({ ...BASE, TURNSTILE_SECRET_KEY: "sec", HELM_TURNSTILE_HOSTNAMES: "www.helm.events" });
  let form = "";
  const rF = installFetch(async (url, init) => {
    assertEquals(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    form = String(init?.body || "");
    return jsonResponse({ success: true, action: "sales", hostname: "www.helm.events" });
  });
  g.__supaGetUser = () => ({ data: { user: USER } });
  g.__supaRpc = () => ({ data: true, error: null });
  try {
    const h = await loadHandler(F + "captcha-verify/index.ts");
    const r = await h(post({ action: "sales", token: TOKEN }, auth));
    assertEquals(r.status, 200);
    assertEquals(await r.json(), { ok: true, configured: true, recorded: true });
    assert(form.includes("secret=sec") && form.includes("response=" + encodeURIComponent(TOKEN)));
    const rec = supaLog().find((x: any) => x.rpc === "captcha_pass_record");
    assertEquals(rec.args, { p_user: USER.id, p_action: "sales" });
    assertEquals(rec.key, "svc");
  } finally { rF(); rEnv(); delete g.__supaGetUser; delete g.__supaRpc; }
});

Deno.test("captcha-verify: configured -> rejected token / wrong action / wrong host = 403; Cloudflare down = 503 (fail CLOSED)", async () => {
  resetSupaMock(); const rEnv = setEnv({ ...BASE, TURNSTILE_SECRET_KEY: "sec", HELM_TURNSTILE_HOSTNAMES: "www.helm.events" });
  g.__supaGetUser = () => ({ data: { user: USER } });
  let answer: any = { success: false, "error-codes": ["invalid-input-response"] }, down = false;
  const rF = installFetch(() => { if (down) throw new Error("offline"); return jsonResponse(answer); });
  const origErr = console.error; const logs: string[] = []; console.error = (m: string) => logs.push(String(m));
  try {
    const h = await loadHandler(F + "captcha-verify/index.ts");
    assertEquals((await h(post({ action: "sales", token: TOKEN }, auth))).status, 403);
    answer = { success: true, action: "login", hostname: "www.helm.events" };
    assertEquals((await h(post({ action: "sales", token: TOKEN }, auth))).status, 403);
    answer = { success: true, action: "sales", hostname: "evil.example" };
    assertEquals((await h(post({ action: "sales", token: TOKEN }, auth))).status, 403);
    down = true;
    const r = await h(post({ action: "sales", token: TOKEN }, auth));
    assertEquals(r.status, 503);
    assert(!supaLog().some((x: any) => x.rpc === "captcha_pass_record"), "nothing recorded on any failure");
    assert(!logs.some((l) => l.includes(TOKEN) || l.includes("sec")), "no token / secret in logs");
  } finally { console.error = origErr; rF(); rEnv(); delete g.__supaGetUser; }
});

Deno.test("captcha-verify r26: signed-out public forms - no JWT needed, a one-use pass id comes back; unconfigured = fail open", async () => {
  resetSupaMock(); let rEnv = setEnv({ ...BASE });
  const PASS = "22222222-2222-4222-8222-222222222222";
  let calls = 0;
  const rF = installFetch(async (url) => { calls++; assertEquals(url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    return jsonResponse({ success: true, hostname: "www.helm.events" }); });
  g.__supaGetUser = () => { throw new Error("no sign-in check for public forms"); };
  g.__supaRpc = () => ({ data: PASS, error: null });
  const anon = { Authorization: "Bearer anon", Origin: "https://www.helm.events", "x-forwarded-for": "7.7.7.7" };
  try {
    let h = await loadHandler(F + "captcha-verify/index.ts");
    let r = await h(post({ action: "contact", token: TOKEN }, anon));
    assertEquals(r.status, 200); assertEquals(await r.json(), { ok: true, configured: false });
    assertEquals(calls, 0);
    rEnv(); rEnv = setEnv({ ...BASE, TURNSTILE_SECRET_KEY: "sec" });
    h = await loadHandler(F + "captcha-verify/index.ts");
    for (const action of ["contact", "enquiry", "suggest"]) {
      r = await h(post({ action, token: TOKEN }, { ...anon, "x-forwarded-for": "7.7.7." + action.length }));
      assertEquals(r.status, 200, action);
      assertEquals(await r.json(), { ok: true, configured: true, pass: PASS });
    }
    const rec = supaLog().filter((x: any) => x.rpc === "captcha_public_pass_record");
    assertEquals(rec.map((x: any) => x.args.p_action), ["contact", "enquiry", "suggest"]);
    assertEquals(rec[0].key, "svc");
    assert(!supaLog().some((x: any) => x.rpc === "captcha_pass_record"), "no per-user pass for visitors");
    // "sales" still needs a signed-in user
    assertEquals((await h(post({ action: "sales", token: TOKEN }, anon))).status, 401);
    // a database without 0276 -> the form can go on (pass null)
    g.__supaRpc = () => ({ data: null, error: { code: "PGRST202" } });
    r = await h(post({ action: "suggest", token: TOKEN }, { ...anon, "x-forwarded-for": "7.7.8.1" }));
    assertEquals(await r.json(), { ok: true, configured: true, pass: null });
  } finally { rF(); rEnv(); delete g.__supaGetUser; delete g.__supaRpc; }
});

Deno.test("captcha-verify r26: visitors - rejected token 403 (nothing recorded); 10 tries / 10 min / network then 429", async () => {
  resetSupaMock(); const rEnv = setEnv({ ...BASE, TURNSTILE_SECRET_KEY: "sec" });
  let ok = false;
  const rF = installFetch(() => jsonResponse(ok ? { success: true, action: "enquiry" } : { success: false, "error-codes": ["invalid-input-response"] }));
  g.__supaRpc = () => ({ data: "33333333-3333-4333-8333-333333333333", error: null });
  const anon = { Authorization: "Bearer anon", Origin: "https://www.helm.events", "x-forwarded-for": "8.8.4.4" };
  try {
    const h = await loadHandler(F + "captcha-verify/index.ts");
    assertEquals((await h(post({ action: "enquiry", token: TOKEN }, anon))).status, 403);
    assert(!supaLog().some((x: any) => x.rpc === "captcha_public_pass_record"));
    ok = true;
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await h(post({ action: "enquiry", token: TOKEN }, anon))).status;
    assertEquals(last, 429);
  } finally { rF(); rEnv(); delete g.__supaRpc; }
});

Deno.test("_shared/sentry.mjs r26: off without SENTRY_DSN; with it one envelope carrying ONLY the function name + error tag", async () => {
  const S = await import("../../supabase/functions/_shared/sentry.mjs");
  assertEquals(S.parseDsn(""), null);
  assertEquals(S.parseDsn("https://abc@evil.example/1"), null);
  const d = S.parseDsn("https://0123456789abcdef0123456789abcdef@o42.ingest.us.sentry.io/77");
  assertEquals(d.url, "https://o42.ingest.us.sentry.io/api/77/envelope/");
  assert(d.auth.includes("sentry_key=0123456789abcdef0123456789abcdef"));
  assertEquals(S.fnName("https://p.supabase.co/functions/v1/captcha-verify?x=1"), "captcha-verify");
  const sent: any[] = [];
  const f = (u: string, init: any) => { sent.push([u, init]); return Promise.resolve(new Response("{}")); };
  assertEquals(S.sentrySend(() => "", f, "https://x/functions/v1/a", "23505"), null);
  assertEquals(sent.length, 0);
  const env = (k: string) => ({ SENTRY_DSN: "https://0123456789abcdef0123456789abcdef@o42.ingest.us.sentry.io/77", SENTRY_ENVIRONMENT: "staging" } as any)[k] || "";
  await S.sentrySend(env, f, "https://x/functions/v1/comms-dispatch", "23505 priya@x.in");
  assertEquals(sent.length, 1);
  const body = String(sent[0][1].body);
  assert(body.includes('"function":"comms-dispatch"') && body.includes('"type":"error"'), body);
  sent.length = 0;
  await S.sentrySend(env, f, "https://x/functions/v1/comms-dispatch", "23505");
  assert(String(sent[0][1].body).includes('"type":"23505"'));
  assertEquals(sent[0][1].headers["Content-Type"], "application/x-sentry-envelope");
  assert(!/priya@|@x\.in/.test(body), "no e-mail in the event: " + body);
  assert(body.includes('"environment":"staging"'));
  assertEquals(body.split("\n").length, 4);
});

Deno.test("csp-report: logs one redacted line per violation, 204, no tokens / query strings; wrong type 415; GET 405", async () => {
  resetSupaMock(); const rEnv = setEnv({}); const rF = installFetch(() => { throw new Error("no fetch expected"); });
  const origLog = console.log; const logs: string[] = []; console.log = (m: string) => logs.push(String(m));
  try {
    const h = await loadHandler(F + "csp-report/index.ts");
    const legacy = new Request("https://fn.local/", { method: "POST", headers: { "Content-Type": "application/csp-report" },
      body: JSON.stringify({ "csp-report": { "document-uri": "https://www.helm.events/sharma/quote/9f1c2d3e-aaaa-4bbb-8ccc-123456789012?t=secret#x",
        "effective-directive": "script-src-elem", "blocked-uri": "https://evil.example/x.js?k=1", "script-sample": "alert(document.cookie)" } }) });
    assertEquals((await h(legacy)).status, 204);
    const modern = new Request("https://fn.local/", { method: "POST", headers: { "Content-Type": "application/reports+json" },
      body: JSON.stringify([{ type: "csp-violation", body: { documentURL: "https://www.helm.events/i/priya-wedding-abcdef0123456789", effectiveDirective: "img-src", blockedURL: "data", disposition: "enforce" } }]) });
    assertEquals((await h(modern)).status, 204);
    const all = logs.join("\n");
    assert(/csp-violation enforce script-src-elem blocked=https:\/\/evil\.example\/x\.js page=https:\/\/www\.helm\.events\/sharma\/quote\/:id/.test(all), all);
    assert(/img-src blocked=data page=https:\/\/www\.helm\.events\/i\/:id/.test(all), all);
    assert(!/secret|alert|9f1c2d3e|priya|k=1/.test(all), "nothing sensitive logged: " + all);
    assertEquals((await h(new Request("https://fn.local/", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" }))).status, 415);
    assertEquals((await h(new Request("https://fn.local/", { method: "GET" }))).status, 405);
  } finally { console.log = origLog; rF(); rEnv(); }
});

Deno.test("csp-report: 30 / minute / IP, then dropped quietly (204, no log); HELM_CSP_REPORTS_ENABLED=false logs nothing", async () => {
  resetSupaMock(); let rEnv = setEnv({});
  const origLog = console.log; const logs: string[] = []; console.log = (m: string) => logs.push(String(m));
  const rep = () => new Request("https://fn.local/", { method: "POST", headers: { "Content-Type": "application/csp-report", "x-forwarded-for": "9.9.9.9" },
    body: JSON.stringify({ "csp-report": { "document-uri": "https://www.helm.events/dashboard", "effective-directive": "img-src", "blocked-uri": "data" } }) });
  try {
    let h = await loadHandler(F + "csp-report/index.ts");
    for (let i = 0; i < 35; i++) assertEquals((await h(rep())).status, 204);
    assertEquals(logs.length, 30);
    rEnv(); rEnv = setEnv({ HELM_CSP_REPORTS_ENABLED: "false" }); logs.length = 0;
    h = await loadHandler(F + "csp-report/index.ts");
    assertEquals((await h(rep())).status, 204);
    assertEquals(logs.length, 0);
  } finally { console.log = origLog; rEnv(); }
});
