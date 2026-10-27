// r26 Sentry + Turnstile: production-ready, switched on by keys (config.js DSN / site key, TURNSTILE_SECRET_KEY,
// SENTRY_DSN secrets); with the keys empty everything behaves exactly as before.
//  1. config.js: clearly marked placeholders, environment by host, release = config.js asset version, traces 0
//  2. telemetry.js: off on localhost, 100% errors / traces capped 10%, PII scrubbing (query strings, money, user),
//     browser-extension noise dropped, early errors queued (no hand-made beacon)
//  3. captcha.js: public forms - off without a key (no fetch), pass from captcha-verify with the anon key, errors mapped
//  4. the forms: widget host + captcha.js on /contact-sales, /enquiry, /suggest; home page loads it lazily
//  5. captcha-verify: public actions need no JWT; SQL 0276 wrappers; edge Sentry helper wired into serverError
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const r = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
let n = 0;
async function t(name, fn) { try { await fn(); n++; } catch (e) { console.error("✗ " + name); throw e; } }

const CFG = r("public/config.js");

/* ------------------------------------------------------------------ 1. config.js */
await t("1a config.js: R45 Sentry DSN set (public, project helm); site key still an empty, clearly marked placeholder (no secret anywhere)", () => {
  assert.match(CFG, /window\.HELM_TELEMETRY = Object\.assign\(\{\n  dsn: "https:\/\/1dc17f49258bac56dd0eb8e778842d7e@o4512062490738688\.ingest\.us\.sentry\.io\/4512328815542272",/);
  assert.match(CFG, />>> TURNSTILE SITE KEY GOES HERE <<</);
  assert.match(CFG, /captcha: \{ provider: "turnstile", siteKey: "",/);
  assert.doesNotMatch(CFG, /TURNSTILE_SECRET|secret\s*:/i);
  assert.match(CFG, /put the site key here and deploy FIRST/, "safe order documented");
});
await t("1b config.js: environment by host, release = helm-web@<config.js ?v=>, tracing off", () => {
  const run = (host, src) => {
    const w = {};
    const ctx = { window: w, location: { hostname: host, search: "" }, document: { currentScript: { src }, write() {} }, navigator: {}, console: { log() {}, warn() {}, error() {}, info() {}, debug() {} } };
    try { vm.runInNewContext(CFG, ctx); } catch (e) { /* later parts of config.js may need more browser; HELM_TELEMETRY is set first */ }
    return w.HELM_TELEMETRY;
  };
  assert.equal(run("www.helm.events", "/config.js?v=109").env, "production");
  assert.equal(run("helm.events", "/config.js?v=109").env, "production");
  assert.equal(run("helm-v01.vercel.app", "/config.js?v=109").env, "staging");
  assert.equal(run("localhost", "/config.js?v=1").env, "development");
  assert.equal(run("helm-v01-git-x.vercel.app", "/config.js?v=1").env, "preview");
  assert.equal(run("www.helm.events", "https://www.helm.events/config.js?v=123").release, "helm-web@123");
  assert.equal(run("www.helm.events", "").release, "helm-web@0");
  assert.equal(run("www.helm.events", "/config.js?v=5").tracesSampleRate, 0);
  assert.equal(run("www.helm.events", "/config.js?v=5").dsn, "https://1dc17f49258bac56dd0eb8e778842d7e@o4512062490738688.ingest.us.sentry.io/4512328815542272");
  assert.equal(run("helm-v01.vercel.app", "/config.js?v=5").dsn, run("www.helm.events", "/config.js?v=5").dsn, "one project; env tag splits prod / staging");
});

/* ------------------------------------------------------------------ 2. telemetry.js */
function loadTel(cfg, loc) {
  const captured = {}; const handlers = {};
  const doc = { head: { appendChild: (s) => { captured.script = s; } }, createElement: () => ({}) };
  const w = { HELM_TELEMETRY: cfg, addEventListener(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); }, document: doc };
  const beacons = [];
  vm.runInNewContext(r("public/telemetry.js"), { window: w, document: doc, location: loc || { pathname: "/", reload() {} },
    navigator: { sendBeacon: (u, b) => { beacons.push([u, b]); return true; } }, console });
  return { T: w.HelmTelemetry, w, captured, handlers, beacons };
}
const DSN = "https://k9@o1.ingest.sentry.io/2";
await t("2a telemetry: never sends from a developer machine (env development) unless allowDev", () => {
  assert.equal(loadTel({ dsn: DSN, env: "development" }).captured.script, undefined);
  assert.ok(loadTel({ dsn: DSN, env: "development", allowDev: true }).captured.script);
  assert.ok(loadTel({ dsn: DSN, env: "staging" }).captured.script);
});
await t("2b telemetry: Sentry.init - every error, tracing capped at 10%, no default PII, noise filters", () => {
  for (const [rate, want] of [[0, 0], [0.05, 0.05], [1, 0.1], [undefined, 0], ["x", 0]]) {
    const { w, captured } = loadTel({ dsn: DSN, env: "production", tracesSampleRate: rate });
    let o = null; w.Sentry = { init: (x) => { o = x; }, captureException() {} };
    captured.script.onload();
    assert.equal(o.sampleRate, 1); assert.equal(o.tracesSampleRate, want, String(rate)); assert.equal(o.sendDefaultPii, false);
    assert.ok(o.ignoreErrors.some((x) => String(x).includes("ResizeObserver")));
    assert.ok(o.denyUrls.some((x) => x.test("chrome-extension://abc/x.js")) && o.denyUrls.some((x) => x.test("moz-extension://a/b.js")));
  }
});
await t("2c telemetry: scrubbing - URL fields lose their whole query (asset ?v= kept), money, user, request body", () => {
  const { T, w, captured } = loadTel({ dsn: DSN, env: "production" });
  let o = null; w.Sentry = { init: (x) => { o = x; }, captureException() {} }; captured.script.onload();
  const ev = o.beforeSend({
    message: "Payment of ₹1,25,000 failed for Rs. 4500 / USD 120 / $12.50",
    request: { url: "https://www.helm.events/aurora/quotes?quote=Q-2026-0012&tab=open#x", data: '{"amount":5000}' },
    user: { id: "u-1", email: "a@b.in", ip_address: "1.2.3.4", username: "Priya" },
    extra: { note: "call 98765 43210 or a@b.in" },
    breadcrumbs: [{ category: "fetch", data: { url: "https://p.supabase.co/rest/v1/quotes?select=*&client_email=eq.a@b.in", method: "GET" } },
      { category: "navigation", data: { from: "/dashboard?search=Priya", to: "/aurora/quotes" } }],
  });
  const s = JSON.stringify(ev);
  assert.ok(!/1,25,000|4500|USD 120|12\.50|Q-2026|a@b\.in|1\.2\.3\.4|Priya|98765|5000/.test(s), s);
  assert.equal(ev.request.url, "https://www.helm.events/aurora/quotes");
  assert.equal(JSON.stringify(ev.user), "{\"id\":\"u-1\"}");
  assert.equal(ev.breadcrumbs[0].data.url, "https://p.supabase.co/rest/v1/quotes");
  assert.equal(ev.breadcrumbs[1].data.from, "/dashboard");
  assert.equal(T.stripUrl("/store-api.js?v=12"), "/store-api.js?v=12", "asset version kept");
  assert.equal(T.redact("/dashboard?tab=events"), "/dashboard?tab=events", "free text keeps an ordinary query");
  assert.equal(T.redact("/quotes?quote=abc123&tab=x"), "/quotes?quote=[REDACTED]&tab=x");
  assert.equal(T.redact("5 Users"), "5 Users", "no false money match");
});
await t("2d telemetry: errors from browser add-ons are dropped; early errors wait for the SDK (no hand-made beacon)", () => {
  const { w, captured, handlers, beacons } = loadTel({ dsn: DSN, env: "production" });
  handlers.error.forEach((f) => f({ error: { message: "boom", stack: "at x (https://www.helm.events/app.js:1:1)" }, message: "boom" }));
  assert.equal(beacons.length, 0, "never sendBeacon to the DSN");
  const sent = []; let o = null;
  w.Sentry = { init: (x) => { o = x; }, captureException: (e, x) => sent.push([e, x]) };
  captured.script.onload();
  assert.equal(sent.length, 1, "the early error is sent once the SDK is ready");
  assert.equal(o.beforeSend({ exception: { values: [{ stacktrace: { frames: [{ filename: "chrome-extension://abc/content.js" }] } }] } }), null);
  handlers.error.forEach((f) => f({ error: { message: "later", stack: "x" }, message: "later" }));
  assert.equal(sent.length, 1, "once Sentry runs it records window errors itself (no double report)");
});

/* ------------------------------------------------------------------ 3. captcha.js */
function loadCap(cfg, fetchImpl) {
  const appended = [];
  const win = { document: { head: { appendChild: (x) => appended.push(x) }, createElement: () => ({}) }, SUPABASE_CONFIG: cfg,
    fetch: fetchImpl || (() => { throw new Error("no fetch expected"); }) };
  vm.runInNewContext(r("public/captcha.js"), { window: win });
  return { C: win.HelmCaptcha, appended, win };
}
const SUPA = { url: "https://p.supabase.co", anonKey: "anon-key" };
await t("3a captcha.js: no site key = off - no widget, no script, publicPass answers {ok, pass:null} without a request", async () => {
  const { C, appended } = loadCap({ ...SUPA, captcha: { provider: "turnstile", siteKey: "" } });
  assert.equal(C.enabled(), false);
  assert.equal(C.guard({}, "contact"), null);
  assert.deepEqual(JSON.parse(JSON.stringify(await C.publicPass("contact", "tok"))), { ok: true, pass: null });
  assert.equal(appended.length, 0);
});
await t("3b captcha.js: with a site key - captcha-verify with the anon key; pass / unconfigured / refused / busy", async () => {
  const calls = []; let answer = { status: 200, body: { ok: true, configured: true, pass: "11111111-1111-4111-8111-111111111111" } };
  const f = (url, init) => { calls.push([url, init]); return Promise.resolve({ status: answer.status, json: () => Promise.resolve(answer.body) }); };
  const { C } = loadCap({ ...SUPA, captcha: { provider: "turnstile", siteKey: "0x4AAAAAAAtestkey" } }, f);
  assert.equal(C.enabled(), true); assert.equal(C.siteKey(), "0x4AAAAAAAtestkey");
  let x = await C.publicPass("contact", "tok-123");
  assert.equal(x.pass, "11111111-1111-4111-8111-111111111111");
  assert.equal(calls[0][0], "https://p.supabase.co/functions/v1/captcha-verify");
  assert.equal(calls[0][1].headers.apikey, "anon-key"); assert.equal(calls[0][1].credentials, "omit");
  assert.deepEqual(JSON.parse(calls[0][1].body), { action: "contact", token: "tok-123" });
  answer = { status: 200, body: { ok: true, configured: false } }; x = await C.publicPass("enquiry", "tok"); assert.equal(x.ok, true); assert.equal(x.pass, null);
  answer = { status: 403, body: { code: "captcha_failed" } }; x = await C.publicPass("suggest", "tok"); assert.equal(x.ok, false); assert.match(x.message, /security check failed/);
  answer = { status: 429, body: {} }; x = await C.publicPass("suggest", "tok"); assert.match(x.message, /Too many tries/);
  x = await C.publicPass("contact", null); assert.equal(x.ok, false); assert.match(x.message, /complete the security check/);
  x = await C.publicPass("sales", "tok"); assert.equal(x.ok, false, "only the public actions");
  assert.equal(calls.length, 4);
});
await t("3c captcha.js: the app's store decides on signed-in pages (checkout keeps working as in r21)", () => {
  const win = { document: { head: { appendChild() {} }, createElement: () => ({}) }, SUPABASE_CONFIG: { captcha: { provider: "turnstile", siteKey: "0x4AAAAAAAtestkey" } },
    BPStore: { auth: { captcha: { enabled: () => false, siteKey: () => "" } } } };
  vm.runInNewContext(r("public/captcha.js"), { window: win });
  assert.equal(win.HelmCaptcha.enabled(), false);
});

/* ------------------------------------------------------------------ 4. the forms */
await t("4a pages: a hidden check box above the button + captcha.js before the page script", () => {
  for (const [page, host, js] of [["contact-sales", "cs-captcha", "contact-sales"], ["enquiry", "eq-captcha", "enquiry"], ["suggest", "sg-captcha", "suggest"]]) {
    const h = r("public/" + page + ".html");
    assert.match(h, new RegExp('<div class="(cs|eq)-captcha" id="' + host + '" hidden></div>'), page);
    assert.match(h, new RegExp('<script src="/captcha\\.js\\?v=\\d+"></script>\\n<script src="/' + js + '\\.js\\?v=\\d+"></script>'), page);
  }
});
await t("4b scripts: the pass goes in the existing \"captcha\" field; no key = the same request as before", () => {
  const cs = r("public/contact-sales.js"), eq = r("public/enquiry.js"), sg = r("public/suggest.js"), home = r("public/home.js");
  assert.match(cs, /HelmCaptcha\.guard\(\$\("cs-captcha"\), "contact"\)/);
  assert.match(eq, /HelmCaptcha\.guard\(\$\("eq-captcha"\), "enquiry"\)/);
  assert.match(sg, /HelmCaptcha\.guard\(\$\("sg-captcha"\), "suggest"\)/);
  for (const s of [cs, eq, sg, home]) {
    assert.match(s, /if \(c\.pass\) body\.captcha = c\.pass;/);
    assert.match(s, /cap \? cap\.pass\(\) : (Promise\.resolve\()?\{ ok: true, pass: null \}/);
  }
  assert.match(home, /'\/captcha\.js\?v=' \+ CAPTCHA_V/);
  assert.match(home, /CAPTCHA_V = '\d+'/);
  assert.match(home, /c\.provider !== 'turnstile' \|\| !\/\^\[0-9A-Za-z_-\]\{8,128\}\$\/\.test/, "home loads nothing without a key");
});
await t("4c CSP: Turnstile allowed on the public form routes only (scripts/csp-hashes.cjs + server.js)", () => {
  const H = require("../scripts/csp-hashes.cjs");
  const csp = "script-src 'self' https://browser.sentry-cdn.com/8.55.2/ https://challenges.cloudflare.com";
  for (const route of ["/", "/contact-sales", "/suggest.html", "/:studio/enquiry", "/(login|reset-password|signup|contact-sales|suggest|enquiry|index|[a-z0-9-]+/enquiry)?"])
    assert.equal(H.scriptSrcProblem(csp, route), "", route);
  for (const route of ["/dashboard", "/quotes", "/(booklet|portal)"]) assert.notEqual(H.scriptSrcProblem(csp, route), "", route);
  assert.match(r("server.js"), /index: 'auth', 'contact-sales': 'auth', enquiry: 'auth', suggest: 'auth'/);
});

/* ------------------------------------------------------------------ 5. server side */
await t("5a captcha-verify: public actions (no JWT, IP + overall limits) record a public pass; sales still needs sign-in", async () => {
  const L = await import("../supabase/functions/captcha-verify/logic.mjs");
  assert.deepEqual(L.PUBLIC_ACTIONS, ["contact", "enquiry", "suggest"]);
  assert.equal(L.validRequest({ action: "enquiry", token: "0.abcdefghijklmnop" }).ok, true);
  assert.equal(L.isPublicAction("sales"), false); assert.equal(L.isPublicAction("contact"), true);
  const idx = r("supabase/functions/captcha-verify/index.ts");
  assert.match(idx, /checkLimits\(\[\["cap:pub:ip:" \+ ip, 10, 10 \* 60_000\], \["cap:pub:all", 600, 60_000\]\]\)/);
  assert.match(idx, /admin\.rpc\("captcha_public_pass_record", \{ p_action: v\.action \}\)/);
  assert.match(idx, /auth\.getUser\(jwt\)/, "sales keeps the sign-in check");
  assert.ok(idx.indexOf('if (!secret) return json({ ok: true, configured: false })') > 0, "unconfigured = fail open");
});
await t("5b SQL 0276: additive table + wrappers, checked only for anon callers while the switch is on; MANIFEST + suite", () => {
  const m = r("supabase/migrations/0276_public_captcha.sql");
  assert.match(m, /create table if not exists public\.captcha_public_passes/);
  assert.match(m, /if not coalesce\(\(select s\.rpc_captcha_required from public\.helm_hq_settings s where s\.id\), false\) then return true; end if;/);
  assert.match(m, /if coalesce\(auth\.jwt\(\) ->> 'role', ''\) <> 'anon' then return true; end if;/);
  assert.match(m, /c\.created_at > now\(\) - interval '10 minutes'/);
  assert.doesNotMatch(m.replace(/--[^\n]*/g, ""), /\bdelete\s+from\b|\btruncate\b|drop\s+table/i, "nothing deleted");
  assert.equal((m.match(/-- r26-captcha-0276/g) || []).length, 5);
  assert.match(r("supabase/migrations/MANIFEST"), /\nforward  supabase\/migrations\/0276_public_captcha\.sql\n/);
  assert.match(r("scripts/db-test/run-all.sh"), /R26-CAPTCHA-0276: ALL PASS \\\(30\/30\\\)/);
  const a = r("supabase/APPLY-0276.sql");
  assert.ok(a.includes(m.trim()), "APPLY-0276 carries the migration unchanged");
  assert.match(a, /^begin;$/m); assert.match(a, /^commit;$/m); assert.match(a, /-- VERIFY \(every row must say ok = true\)/);
  assert.doesNotMatch(a, /[^\x00-\x7f]/, "ASCII only");
});
await t("5c edge functions: optional Sentry (only with SENTRY_DSN) from serverError - function name + error tag only", async () => {
  const cors = r("supabase/functions/_shared/cors.ts");
  assert.match(cors, /import \{ sentrySend \} from "\.\/sentry\.mjs";/);
  assert.match(cors, /reportToSentry\(req, e\);/);
  const S = await import("../supabase/functions/_shared/sentry.mjs");
  assert.equal(S.sentrySend(() => "", () => { throw new Error("no send"); }, "https://x/functions/v1/a", "23505"), null, "off without the secret");
  const sent = [];
  await S.sentrySend((k) => (k === "SENTRY_DSN" ? "https://0123456789abcdef0123456789abcdef@o9.ingest.de.sentry.io/5" : ""),
    (u, init) => { sent.push([u, init]); return Promise.resolve({}); }, "https://x/functions/v1/send-otp", "boom for a@b.in");
  assert.equal(sent[0][0], "https://o9.ingest.de.sentry.io/api/5/envelope/");
  const body = String(sent[0][1].body);
  assert.ok(!/a@b\.in|boom/.test(body), body);
  assert.match(body, /"function":"send-otp"/);
});

console.log(`r26-sentry-turnstile: ${n} checks passed`);
