// Round 21 - security posture checklist, top-10 actions (code side). Every switch stays OFF.
//  1. HQ / admin two-step readiness: 0249 (readiness RPC, guard that refuses hq_require_mfa without enrolment), HQ card
//  2. Turnstile: config-driven (empty site key = off), login interaction-only + visible after N failures, checkout
//     Contact sales (captcha-verify edge function, fail-open unconfigured / fail-closed configured), CSP allowance
//  3. Rate limits fail closed by default; supabase/config.toml declares verify_jwt for every function
//  4. Legal pages: every [OWNER TO FILL] -> one data-fact spot fed by public/legal-facts.js
//  5. Monitoring: CSP report-uri (csp-report edge function), Sentry DSN from config.js (lazy read + exact connect-src)
//  6. CodeQL true positives fixed in website code
// The database behaviour is proven by tests/db/r21-security-0249.sql (29 checks); the edge runtime by
// tests/edge/captcha-csp.test.ts + tests/edge/limits.test.ts (deno, offline).
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import vm from "node:vm";
const stripComments = (s) => { let prev; do { prev = s; s = s.replace(/<!--[\s\S]*?-->/g, ''); } while (s !== prev); const open = s.indexOf('<!--'); return open < 0 ? s : s.slice(0, open); };   // repeat until stable; an unterminated "<!--" hides the rest (CodeQL js/incomplete-multi-character-sanitization)
const require = createRequire(import.meta.url);
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0; const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error("FAIL " + name); throw e; } };

const MIG = r("supabase/migrations/0249_security_readiness.sql"), APPLY = r("supabase/APPLY-0249.sql"), MAN = r("supabase/migrations/MANIFEST");
const TOML = r("supabase/config.toml"), LIM = r("supabase/functions/_shared/limits.ts");
const SA = r("public/store-api.js"), AUI = r("public/auth-ui.js"), LOGIN = r("public/login.html"), CFG = r("public/config.js");
const CO = r("public/checkout.js"), COH = r("public/checkout.html"), HQH = r("public/hq.html"), HQJ = r("public/hq.js");
const VJ = JSON.parse(r("vercel.json")), HDR = r("public/_headers"), SRV = r("server.js");

/* ------------------------------------------------------------------ 1. two-step readiness */
await t("1a 0249: readiness RPC is HQ-gated; guard refuses ON without enrolment; switches default OFF; additive only", () => {
  assert.match(MIG, /create or replace function public\.hq_mfa_readiness\(\)[\s\S]*?perform public\._hq_gate\('hq_mfa_readiness'\)/);
  assert.match(MIG, /if coalesce\(new\.hq_require_mfa, false\) and not coalesce\(old\.hq_require_mfa, false\)\s+and coalesce\(current_setting\('helm\.allow_hq_mfa_lockout', true\), ''\) <> 'on' then[\s\S]*?where o\.has_login and not o\.has_2step[\s\S]*?raise exception 'STOP:/);
  // the test-harness bypass is never set by the app or by the owner's APPLY file
  assert.doesNotMatch(APPLY.replace(/--.*$/gm, ""), /set_config\('helm\.allow_hq_mfa_lockout'|allow_hq_mfa_lockout\s*=\s*on/);
  assert.match(MIG, /create trigger a249_hq_require_mfa_guard before update on public\.helm_hq_settings/);
  assert.match(MIG, /add column if not exists rpc_captcha_required boolean not null default false/);
  assert.doesNotMatch(MIG, /\b(drop table|truncate|delete from)\b/i, "no destructive statement");
  assert.doesNotMatch(MIG, /update public\.helm_hq_settings set hq_require_mfa/i, "the migration never flips the HQ switch");
  assert.ok(!/[^\x00-\x7f]/.test(MIG + APPLY), "ASCII only");
});
await t("1b APPLY-0249 = begin + the migration verbatim + commit + VERIFY; MANIFEST + DB suite registered", () => {
  assert.ok(APPLY.includes("begin;\n" + MIG + "commit;"), "APPLY carries the migration body verbatim");
  assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.match(MAN, /\nforward  supabase\/migrations\/0249_security_readiness\.sql\n/);
  assert.match(r("scripts/db-test/run-all.sh"), /R21-SECURITY-0249: ALL PASS \\\(29\/29\\\)" psql -q -f tests\/db\/r21-security-0249\.sql/);
  assert.match(r("supabase/audit/R21-SECURITY-PREFLIGHT.sql"), /READ-ONLY/);
  assert.doesNotMatch(r("supabase/audit/R21-SECURITY-PREFLIGHT.sql").replace(/--.*$/gm, ""), /\b(insert|update|delete|alter|drop|create)\b/i);
});
await t("1c HQ readiness model: blocking / pending / safe / me-needs-setup; fallback without 0249", () => {
  const { model } = require("../public/hq-mfa.js");
  const notReady = model({ hq_require_mfa: false, operators: [
    { email: "admin@helm.events", has_login: true, has_2step: false, is_me: true },
    { email: "security@helm.events", has_login: false, has_2step: false }], studio_admins: { total: 4, with_2step: 1 } });
  assert.equal(notReady.safe, false); assert.equal(notReady.blocking, 1); assert.equal(notReady.pending, 1);
  assert.equal(notReady.showEnroll, true); assert.equal(notReady.state.tone, "warn");
  assert.deepEqual(notReady.lines.map((l) => l.label), ["needs set-up", "never signed in (asked at first sign-in)"]);
  assert.match(notReady.admins, /1 of 4/);
  const ready = model({ hq_require_mfa: false, operators: [{ email: "a@helm.events", has_login: true, has_2step: true, is_me: true }, { email: "s@helm.events", has_login: false }] });
  assert.equal(ready.safe, true); assert.equal(ready.showEnroll, false); assert.match(ready.state.text, /Ready/);
  const on = model({ hq_require_mfa: true, operators: [{ email: "a@helm.events", has_login: true, has_2step: true }] });
  assert.equal(on.on, true); assert.equal(on.state.text, "Required");
  const fb = model(null, [{ email: "a@helm.events", mfa_enabled: false, last_sign_in_at: "2026-10-01", is_me: true }]);
  assert.equal(fb.source, "fallback"); assert.equal(fb.blocking, 1); assert.equal(fb.admins, null);
});
await t("1d HQ page: readiness card + Set up two-step (auth-ui renderEnroll), loaded after the data; config flag stays OFF", () => {
  assert.match(HQH, /id="hMfaR">HQ two-step readiness</);
  assert.match(HQH, /<script src="auth-ui\.js\?v=\d+"><\/script>[\s\S]*<script src="hq-mfa\.js\?v=\d+"><\/script>\s*(<script src="hq-staff\.js\?v=\d+"><\/script>\s*)?<script src="hq\.js\?v=\d+"><\/script>/);
  assert.match(HQJ, /call\("hq_mfa_readiness"\)/);
  assert.match(HQJ, /window\.HelmAuthUI\.renderEnroll\(box,/);
  assert.match(HQJ, /on\("#btnMfaEnroll", "click", startMfaEnroll\)/);
  assert.match(CFG, /\n    mfaRequiredForAdmins: false,/);
});

/* ------------------------------------------------------------------ 2. Turnstile */
await t("2a config: site key EMPTY (off); login options; store-api only turns on with a well-formed key", () => {
  assert.match(CFG, /captcha: \{ provider: "turnstile", siteKey: "", login: \{ appearance: "interaction-only", alwaysAfterFailures: 3 \} \}/);
  assert.match(SA, /return \(c\.provider === "turnstile" && \/\^\[0-9A-Za-z_-\]\{8,128\}\$\/\.test\(key\)\) \? \{ provider: "turnstile", siteKey: key, login \} : null;/);
  assert.match(SA, /login: \(\) => \(CAPTCHA \? CAPTCHA\.login : \{ appearance: "interaction-only", alwaysAfterFailures: 3 \}\)/);
});
await t("2b login: invisible unless needed, escalates to a visible check after N wrong passwords (tab-scoped)", () => {
  assert.match(AUI, /appearance: appearance,/);
  assert.match(AUI, /escalate: function \(\) \{[\s\S]*?appearance = "always"[\s\S]*?global\.turnstile\.remove\(wid\)/);
  assert.match(LOGIN, /cap=HelmAuthUI\.mountCaptcha\(\$\("#captcha"\),\{action:"login", appearance:capLogin\(\)\.appearance\}\)/);
  assert.match(LOGIN, /err\.code==="invalid_credentials"\)\{ noteLoginFail\(\);/);
  assert.match(LOGIN, /sessionStorage\.setItem\("bp_login_fails"/);
});
await t("2c checkout Contact sales: widget via captcha.js, pass requested BEFORE the request is saved, one-use token reset", () => {
  assert.match(COH, /<div class="captcha" id="sdCaptcha" hidden><\/div>/);
  assert.match(COH, /<script src="captcha\.js\?v=\d+"><\/script>/);
  const send = CO.slice(CO.indexOf("async function sendSales"), CO.indexOf("/* ---------------- r21: pay by UPI"));
  assert.ok(send.indexOf("S.checkout.captchaPass(\"sales\", capTok)") > 0 && send.indexOf("S.checkout.captchaPass") < send.indexOf("S.checkout.requestSales("));
  assert.match(send, /if \(!capTok\) \{ \$\("#sdErr"\)\.textContent = "Please complete the security check\."; return; \}/);
  assert.match(SA, /captchaPass: async \(action, token\) => \{[\s\S]*?if \(mode !== "supabase" \|\| !supa \|\| !CAPTCHA \|\| !token\) return \{ ok: true, skipped: true \};[\s\S]*?res\.status === 403/);
});
await t("2d captcha.js: OFF without a site key (no script loaded), explicit render, DOM text only", () => {
  const src = r("public/captcha.js");
  const appended = [];
  const win = { document: { head: { appendChild: (x) => appended.push(x) }, createElement: () => ({}) }, BPStore: { auth: { captcha: { enabled: () => false } } } };
  vm.runInNewContext(src, { window: win });
  assert.equal(win.HelmCaptcha.mount({}, { action: "sales" }), null);
  assert.equal(appended.length, 0, "nothing loaded while off");
  assert.match(src, /turnstile\/v0\/api\.js\?render=explicit/);
  assert.doesNotMatch(src, /innerHTML/);
});
await t("2e captcha-verify logic: request validation, verdict fails closed, hostname/action checks", async () => {
  const L = await import("../supabase/functions/captcha-verify/logic.mjs");
  assert.deepEqual(L.validRequest({ action: "sales", token: "0.abcdefghijk" }), { ok: true, action: "sales", token: "0.abcdefghijk" });
  assert.equal(L.validRequest({ action: "trial", token: "0.abcdefghijk" }).ok, false);
  assert.equal(L.validRequest({ action: "sales", token: "short" }).ok, false);
  assert.equal(L.validRequest({ action: "sales", token: "has space in it" }).ok, false);
  assert.equal(L.judge(null).ok, false);
  assert.equal(L.judge({ success: "true" }).ok, false);
  assert.equal(L.judge({ success: false, "error-codes": ["timeout-or-duplicate"] }).reason, "rejected:timeout-or-duplicate");
  assert.equal(L.judge({ success: true, action: "login" }, { action: "sales" }).ok, false);
  assert.equal(L.judge({ success: true, hostname: "x.test" }, { hostnames: ["www.helm.events"] }).ok, false);
  assert.equal(L.judge({ success: true, action: "sales", hostname: "www.helm.events" }, { action: "sales", hostnames: L.hostList(" WWW.helm.events , helm.events") }).ok, true);
  const f = L.verifyForm("s", "tok", "1.2.3.4", "k");
  assert.equal(f.get("secret"), "s"); assert.equal(f.get("remoteip"), "1.2.3.4"); assert.equal(L.verifyForm("s", "t", "unknown").get("remoteip"), null);
  const idx = r("supabase/functions/captcha-verify/index.ts");
  assert.match(idx, /if \(!secret\) return json\(\{ ok: true, configured: false \}\);/);
  assert.match(idx, /auth\.getUser\(jwt\)/);
});
await t("2f CSP: Turnstile on /login, /reset-password and /checkout only (script-src + frame-src, never connect-src) - vercel, _headers, server.js", async () => {
  const { scriptSrcProblem } = require("../scripts/csp-hashes.cjs");
  const TS = "https://challenges.cloudflare.com";
  for (const rule of VJ.headers) for (const h of rule.headers || []) {
    if (h.key !== "Content-Security-Policy" || rule.has) continue;
    const d = Object.fromEntries(h.value.split(";").map((x) => x.trim().split(/\s+/)).map((p) => [p[0], p.slice(1)]));
    const allowed = /(login|reset|checkout)/.test(rule.source);
    assert.equal((d["script-src"] || []).includes(TS), allowed, rule.source + " script-src");
    assert.equal((d["frame-src"] || []).includes(TS), allowed, rule.source + " frame-src");
    assert.ok(!(d["connect-src"] || []).includes(TS), rule.source + " connect-src");
    assert.equal(scriptSrcProblem(h.value, rule.source), "", rule.source);
  }
  assert.match(SRV, /'script-src': baseDirective\('script-src'\)\.replace\(\/\^'self'\/, "'self' " \+ TURNSTILE \+ ' ' \+ RZP_SCRIPT\)/);
  assert.match(HDR, /\/checkout\n  ! Content-Security-Policy\n  Content-Security-Policy: [^\n]*frame-src 'self' https:\/\/challenges\.cloudflare\.com/);
});

/* ------------------------------------------------------------------ 3. edge: fail closed + config.toml */
await t("3a limits.ts: DB error fails CLOSED by default; 'false' = open; missing rate_hit = open (loud)", () => {
  assert.match(LIM, /if \(v === "true"\) return "strict";\s*if \(v === "false"\) return "open";\s*return "closed";/);
  assert.match(LIM, /const failClosed = mode === "strict" \|\| \(mode === "closed" && !isMissingRpc\(e\)\);/);
  assert.match(LIM, /return c === "PGRST202" \|\| c === "42883";/);
  assert.doesNotMatch(LIM, /envGet\("HELM_RATE_LIMIT_FAIL_CLOSED"\) === "true"/, "the old opt-in check is gone");
});
await t("3b config.toml: every function declared exactly once; verify_jwt=false ones authenticate in code", () => {
  const dir = new URL("../supabase/functions/", import.meta.url);
  const fns = readdirSync(dir).filter((f) => !f.startsWith("_") && statSync(new URL(f, dir)).isDirectory() && existsSync(new URL(f + "/index.ts", dir)));
  const sections = [...TOML.matchAll(/^\[functions\.([a-z0-9-]+)\][^\n]*\nverify_jwt = (true|false)$/gm)].map((m) => [m[1], m[2] === "true"]);
  const map = new Map(sections);
  assert.equal(map.size, sections.length, "no duplicates");
  assert.deepEqual([...map.keys()].sort(), fns.sort(), "config.toml lists exactly the functions in supabase/functions");
  assert.equal(fns.length, 24);
  const AUTH = {
    jwt: /auth\.getUser\(jwt\)/, cron: /secretMatches\(req\.headers\.get\("x-helm-cron-secret"\)/,
    rzp: /x-razorpay-signature/, meta: /x-hub-signature-256/, token: /admin\.rpc\("(booklet_snapshot_path|email_unsub_status|invite_account_state)"/,
  };
  const want = { "captcha-verify": "jwt", "client-mailer": "jwt", "invite-mailer": "jwt", "invite-signup": "token", "booklet-snapshot": "token",
    "email-unsubscribe": "token", "billing-reminder": "cron", "comms-dispatch": "cron", "pkg-client-notify": "cron", "security-alert-mailer": "cron",
    "verify-upload": "cron", "welcome-mailer": "cron", "razorpay-webhook": "rzp", "razorpay-subscription-webhook": "rzp", "wa-webhook": "meta" };
  for (const [fn, on] of map) {
    if (on) continue;
    const src = r("supabase/functions/" + fn + "/index.ts");
    if (fn === "csp-report") { assert.doesNotMatch(src, /createClient|\.rpc\(|\.from\(/, "csp-report touches no data"); continue; }
    assert.ok(want[fn], fn + " is verify_jwt=false without a known in-code check");
    assert.match(src, AUTH[want[fn]], fn + " must authenticate in code (" + want[fn] + ")");
  }
  for (const fn of ["razorpay-webhook", "razorpay-subscription-webhook", "wa-webhook", "csp-report", "booklet-snapshot", "email-unsubscribe"]) assert.equal(map.get(fn), false, fn);
  for (const fn of ["send-otp", "create-payment-link", "send-whatsapp", "wa-proposal", "render-photo"]) assert.equal(map.get(fn), true, fn);
});

/* ------------------------------------------------------------------ 4. legal facts */
await t("4a legal pages: no raw [OWNER TO FILL] / [BRACKETED] placeholder; every mark has a known data-fact key; legal-facts.js loaded first", () => {
  const LF = require("../public/legal-facts.js");
  const pages = readdirSync(new URL("../public/", import.meta.url)).filter((f) => f.endsWith(".html"));
  let marks = 0;
  for (const p of pages) {
    const s = r("public/" + p);
    assert.doesNotMatch(stripComments(s), /OWNER TO FILL/, p);
    if (!/class="lg-ph"/.test(s)) continue;
    assert.doesNotMatch(s, /<span class="lg-ph">\[/, p + " has an unconverted placeholder");
    for (const m of s.matchAll(/<span class="lg-ph" data-fact="([^"]+)">([^<]*)<\/span>/g)) {
      marks++;
      for (const k of m[1].split(",")) assert.ok(Object.prototype.hasOwnProperty.call(LF.FACTS, k), p + ": unknown key " + k);
      assert.equal(m[2], LF.CONFIRM[m[1]] ? "To be confirmed" : "To be updated", p + " " + m[1]);
    }
    assert.equal((s.match(/class="lg-ph"/g) || []).length, (s.match(/class="lg-ph" data-fact=/g) || []).length, p + ": every mark is data-driven");
    assert.match(s, /<script src="\/legal-facts\.js\?v=\d+" defer><\/script>\n  <script src="\/legal\.js\?v=\d+" defer><\/script>/, p);
  }
  assert.ok(marks >= 80, "all 84 spots converted (" + marks + ")");
  for (const v of Object.values(LF.FACTS)) assert.equal(v, "", "no legal fact is invented - every value starts empty");
});
await t("4b legal-facts resolve/apply: empty -> To be updated; e-mail -> mailto link; composite keys; confirm notes", () => {
  const LF = require("../public/legal-facts.js");
  const F = { ...LF.FACTS, grievanceOfficerName: "A. Rao", grievanceOfficerDesignation: "Director", privacyEmail: "privacy@helm.events", slaTargetConfirmed: true };
  assert.deepEqual(LF.resolve("gstin", F), { missing: true, text: "To be updated" });
  assert.equal(LF.resolve("grievanceOfficerName,grievanceOfficerDesignation", F).text, "A. Rao, Director");
  assert.equal(LF.resolve("privacyEmail", F).email, "privacy@helm.events");
  assert.deepEqual(LF.resolve("slaTargetConfirmed", F), { confirmed: true, text: "" });
  assert.equal(LF.resolve("backupPlanConfirmed", F).text, "To be confirmed");
  assert.equal(LF.resolve("legalEntityName", { ...F, legalEntityName: "Helm\u0000 <b>X</b>" }).text, "Helm <b>X</b>", "plain text (set with textContent)");
  // apply(): a tiny DOM stub
  const mk = (fact) => { const o = { fact, textContent: "To be updated", hidden: false, kids: [], classList: { set: new Set(["lg-ph"]), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); } },
    getAttribute: () => fact, appendChild(k) { this.kids.push(k); } }; return o; };
  const els = [mk("privacyEmail"), mk("gstin"), mk("slaTargetConfirmed")];
  const doc = { querySelectorAll: () => els, createElement: () => ({}) };
  assert.equal(LF.apply(doc, F), 2);
  assert.equal(els[0].kids[0].href, "mailto:privacy@helm.events"); assert.ok(!els[0].classList.set.has("lg-ph"));
  assert.equal(els[1].textContent, "To be updated"); assert.ok(els[1].classList.set.has("lg-ph"));
  assert.equal(els[2].hidden, true);
  assert.doesNotMatch(r("public/legal-facts.js"), /innerHTML/);
});

/* ------------------------------------------------------------------ 5. monitoring */
await t("5a CSP report-uri on every production policy (vercel + _headers + server.js prod hosts), none on staging", () => {
  const { withReporting, cspReportUri, sentryIngestOrigin } = require("../scripts/csp-hashes.cjs");
  const RU = "report-uri https://nqltzgiwznphugcfhmbm.supabase.co/functions/v1/csp-report";
  for (const rule of VJ.headers) for (const h of rule.headers || []) {
    if (h.key !== "Content-Security-Policy") continue;
    const staging = rule.has && rule.has[0].value === "helm-v01.vercel.app";
    assert.equal(h.value.includes(RU), !staging, rule.source + (staging ? " (staging)" : ""));
  }
  assert.equal((HDR.match(/Content-Security-Policy: /g) || []).length, (HDR.match(/report-uri https:\/\/nqltzgiwznphugcfhmbm\.supabase\.co\/functions\/v1\/csp-report/g) || []).length);
  assert.match(SRV, /if \(isProdHost\(req\)\) \{\s*h\['Content-Security-Policy'\] = withReporting\(stripStagingCsp/);
  assert.equal(cspReportUri("bad"), "");
  assert.equal(sentryIngestOrigin('window.HELM_TELEMETRY = Object.assign({\n  dsn: "",'), "", "no DSN -> no connect-src host");
  assert.equal(sentryIngestOrigin('window.HELM_TELEMETRY = Object.assign({ dsn: "https://abc123@o42.ingest.us.sentry.io/77" }'), "https://o42.ingest.us.sentry.io");
  assert.equal(sentryIngestOrigin('window.HELM_TELEMETRY = { dsn: "https://abc@evil.example/1" }'), "", "only a sentry.io ingest host");
  assert.equal(sentryIngestOrigin('window.HELM_TELEMETRY = { dsn: "https://1dc17f49258bac56dd0eb8e778842d7e@o4512062490738688.ingest.us.sentry.io/4512328815542272" }'),
    "https://o4512062490738688.ingest.us.sentry.io", "R45: 16-digit org / project ids (current Sentry format)");
  assert.equal(withReporting("connect-src 'self'; report-uri x", { reportUri: "https://r", sentryOrigin: "https://s" }), "connect-src 'self' https://s; report-uri https://r; report-to csp-endpoint");
});
await t("5b csp-report logic: redacted one-line summaries for both report formats", async () => {
  const L = await import("../supabase/functions/csp-report/logic.mjs");
  assert.equal(L.safeUrl("https://www.helm.events/sharma/portal/abcdefabcdef1234567890?t=1#x"), "https://www.helm.events/sharma/portal/:id");
  assert.equal(L.safeUrl("https://www.helm.events/x/0b8c2f1e-1111-4222-8333-944445555666/a@b.com"), "https://www.helm.events/x/:id/:email");
  assert.equal(L.safeUrl("inline"), "inline");
  assert.equal(L.safeUrl("javascript:alert(1)"), "javascript");
  assert.deepEqual(L.summarize("not json"), []);
  assert.equal(L.summarize(JSON.stringify(new Array(30).fill({ type: "csp-violation", body: { effectiveDirective: "img-src" } }))).length, 10);
  const s = L.summarize({ "csp-report": { "violated-directive": "script-src-elem 'self'", "blocked-uri": "eval", "document-uri": "https://www.helm.events/i/our-wedding-1234567890abcdef" } })[0];
  assert.equal(L.logLine(s), "csp-violation enforce script-src-elem blocked=eval page=https://www.helm.events/i/:id");
});
await t("5c telemetry: DSN read lazily (config.js loads after telemetry.js) - a DSN set later arms Sentry at DOMContentLoaded; empty = off", () => {
  const src = r("public/telemetry.js");
  const captured = {}; const handlers = {};
  const doc = { head: { appendChild: (s) => { captured.script = s; } }, createElement: () => ({}) };
  const w = { addEventListener(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); }, document: doc };
  vm.runInNewContext(src, { window: w, document: doc, location: { pathname: "/", reload() {} }, navigator: {}, console });
  assert.equal(captured.script, undefined, "no DSN yet -> nothing loaded");
  w.HELM_TELEMETRY = { dsn: "https://k9@o1.ingest.sentry.io/2", env: "production" };   // what config.js does next
  handlers.DOMContentLoaded.forEach((f) => f());
  assert.ok(captured.script && /sentry-cdn\.com\/8\.55\.2\/bundle\.min\.js/.test(captured.script.src), "armed after config.js");
  assert.equal(w.HelmTelemetry.enabled, true);
  assert.match(CFG, /window\.HELM_TELEMETRY = Object\.assign\(\{\n  dsn: "https:\/\/1dc17f49258bac56dd0eb8e778842d7e@o4512062490738688\.ingest\.us\.sentry\.io\/4512328815542272",/, "R45: DSN set");
});

/* ------------------------------------------------------------------ 6. CodeQL fixes */
await t("6a auth-confirm go(): only a fixed same-origin page (+ its query) reaches location.replace", () => {
  const src = r("public/auth-confirm.js");
  const m = /  var GO_PATHS = [\s\S]*?\n  function go\(path\) \{[\s\S]*?\n    location\.replace\(target\);\n  \}\n/.exec(src);
  assert.ok(m, "guarded go()");
  assert.doesNotMatch(src, /location\.(replace|assign)\((?!target\))/, "go() is the only navigation");
  const run = (origin, path) => { let to = null; const ctx = { URL, location: { origin, replace: (x) => { to = x; } } };
    vm.runInNewContext(m[0] + "\ngo(" + JSON.stringify(path) + ");", ctx); return to; };
  const W = "https://www.helm.events", A = "https://helm.events";
  for (const [inp, out] of [["/login", "/login"], ["/login?invite=ab12cd34ef56ab78", "/login?invite=ab12cd34ef56ab78"],
    ["/login.html?next=dashboard&invite=ab12cd34ef56ab78", "/login.html?next=dashboard&invite=ab12cd34ef56ab78"],
    ["/reset-password?via=confirm", "/reset-password?via=confirm"], ["/login?confirmed=1", "/login?confirmed=1"],
    ["/login?invite=ab12&error_code=otp_expired", "/login?invite=ab12&error_code=otp_expired"], ["/login?", "/login"]]) {
    assert.equal(run(W, inp), out, inp); assert.equal(run(A, inp), out, "apex " + inp);
  }
  for (const bad of ["//evil.example", "/\\evil.example", "https://evil.example/login", "javascript:alert(1)", "", "/x\ny", "/dashboard", "/auth/confirm?x=1", "/login/../../evil"])
    assert.equal(run(W, bad), "/login", JSON.stringify(bad));
  // whatever is passed, the string handed to location.replace starts with one of the fixed pages
  for (const x of ["//a.b/login", "/login?x=//evil", "\t/login", "https://www.helm.events/login?invite=ab12"]) assert.match(run(W, x), /^\/(login|reset-password)(\.html)?(\?|$)/, x);
});
await t("6b tag stripping runs to a fixed point (form-validate stripHtml, auth-ui noTags)", () => {
  const { stripHtml } = require("../public/form-validate.js");
  assert.match(r("public/form-validate.js"), /do \{ prev = s; s = s\.replace\(\/<\[\^>\]\*>\/g, ""\); \} while \(s !== prev\);/);
  assert.equal(stripHtml("<scr<script>ipt>alert(1)</script>"), "iptalert(1)");
  assert.equal(stripHtml("Priya & Arjun"), "Priya & Arjun");
  const noTags = vm.runInNewContext("(" + /function noTags\(v\) \{[\s\S]*?\n  \}/.exec(AUI)[0] + ")");
  assert.equal(noTags("<scr<script>ipt>x"), "iptx");
  assert.doesNotMatch(noTags("<<b>script>alert(1)<</b>/script>"), /[<>]/);
  assert.equal((AUI.match(/\.replace\(\/<\[\^>\]\*>\/g, ""\)/g) || []).length, 2, "tags are stripped only by the two fixed-point loops");
  assert.equal((AUI.match(/while \(s !== prev\)/g) || []).length, 2);
});
await t("6c calendar day / quotes / event / chat sinks escaped or validated", () => {
  const cal = r("public/events-calendar.js");
  assert.match(cal, /function openDay\(day\) \{ day = toD\(day\) \? toS\(toD\(day\)\) : null; if \(!day\) return;/);
  const Q = r("public/quotes.html"), E = r("public/event.html"), C = r("public/chat.html");
  assert.match(Q, /obj · \$\{esc\(fmtDate\(v\.createdAt\)\)\}<\/option>/);
  assert.match(Q, /"Quote V"\+esc\(full\.currentVersion\)/);
  assert.match(Q, /esc\(BPStore\.quoteDate\(full\.updatedAt,qTax\)\)/);
  assert.match(E, /sum:`Version v\$\{esc\(ev\.currentVersion\)\}/);
  assert.match(E, /href="\$\{esc\(a\.href\)\}">\$\{esc\(a\.t\)\}<\/a>/);
  assert.match(C, /if\(\/\^https:\\\/\\\/\/i\.test\(u\)\) el\.src=u;/);
  // r21 codeql #96: the storage path never round-trips through DOM text (data-media carries an index into a render list)
  assert.match(C, /data-media="\$\{media\.push\(String\(m\.media_path\|\|""\)\)-1\}" alt="Photo"/);
  assert.match(C, /<audio controls preload="none" data-media="\$\{media\.push\(String\(m\.media_path\|\|""\)\)-1\}">/);
  assert.match(C, /const i=parseInt\(el\.getAttribute\("data-media"\),10\); const p=\(i>=0&&i<media\.length\)\?media\[i\]:"";/);
  assert.doesNotMatch(C, /data-media="\$\{esc\(/);
  assert.match(r("tests/staging/lib/client.mjs"), /globalThis\.crypto\.getRandomValues\(b\)/);
  assert.doesNotMatch(r("tests/staging/lib/client.mjs"), /Math\.random/);
});

/* ------------------------------------------------------------------ 7. docs */
await t("7 owner docs: steps for every top-10 action + CodeQL triage covers all 35 alerts", () => {
  const D = r("docs/security/OWNER-DASHBOARD-STEPS-R21.md"), T = r("docs/security/CODEQL-TRIAGE-R21.md");
  for (const h of ["## A. GitHub", "## B. Default-password", "## C. Two-step", "## D. Cloudflare Turnstile", "## E. Edge functions", "## F. Monitoring",
    "## G. Legal facts", "## H. DNS and redirects", "## I. Backups", "## J. Staging lock-down"]) assert.ok(D.includes(h), h);
  for (const k of ["308", "hstspreload.org", "CAA", "api", "p=reject", "-all", "HELM-COM-ACCOUNTS-1-PREVIEW.sql", "Point in Time Recovery", "Dependabot"]) assert.ok(D.includes(k), k);
  const LF = require("../public/legal-facts.js");
  for (const k of Object.keys(LF.FACTS)) assert.ok(D.includes("`" + k + "`"), "legal key documented: " + k);
  const nums = [94, 93, 92, 91, 90, 89, 88, 87, 84, 83, 82, 81, 79, 78, 66, 64, 63, 62, 61, 60, 59, 58, 57, 56, 55, 54, 53, 48, 46, 45, 44, 37, 35, 34, 33];
  for (const x of nums) assert.match(T, new RegExp("\\| " + x + "\\b|\\b" + x + ", |, " + x + "\\b|" + x + " \\|"), "#" + x);
  assert.ok(existsSync(new URL("../docs/security/MONITORING-R21.md", import.meta.url)));
});

console.log(`\nr21-security: ${n} test(s) passed.`);
