// R45: Sentry error alerts ON (browser). Owner's project "helm", free plan.
//  1. config.js: the public DSN, env by host (production / staging / development / preview), tracing 0
//  2. telemetry.js: the DSN passes its validator (16-digit org + project ids); armed on prod + staging, never on localhost;
//     errors only - no tracing, no replay, no profiling
//  3. CSP: connect-src carries exactly the DSN ingest host (vercel.json + public/_headers), no wildcard, no other Sentry host
//  4. ?sentry_test=1 throws ONE test error on the staging host only (never helm.events / previews / localhost)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const r = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
let n = 0;
function t(name, fn) { try { fn(); n++; } catch (e) { console.error("✗ " + name); throw e; } }

const DSN = "https://1dc17f49258bac56dd0eb8e778842d7e@o4512062490738688.ingest.us.sentry.io/4512328815542272";
const HOST = "https://o4512062490738688.ingest.us.sentry.io";
const CFG = r("public/config.js");
const TEL = r("public/telemetry.js");

function cfgFor(host) {
  const w = {};
  const ctx = { window: w, location: { hostname: host, search: "" }, document: { currentScript: { src: "/config.js?v=7" }, write() {} }, navigator: {},
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} } };
  try { vm.runInNewContext(CFG, ctx); } catch (e) { /* HELM_TELEMETRY is set before the parts that need more browser */ }
  return w.HELM_TELEMETRY;
}
function loadTel(cfg, loc, store) {
  const captured = {}; const handlers = {}; const timers = [];
  const doc = { head: { appendChild: (s) => { captured.script = s; } }, createElement: () => ({}) };
  const ss = store || new Map();
  const w = { HELM_TELEMETRY: cfg, addEventListener(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); }, document: doc,
    sessionStorage: { getItem: (k) => (ss.has(k) ? ss.get(k) : null), setItem: (k, v) => ss.set(k, String(v)) } };
  vm.runInNewContext(TEL, { window: w, document: doc, location: Object.assign({ pathname: "/", search: "", hostname: "", reload() {} }, loc || {}),
    navigator: {}, console, setTimeout: (fn) => { timers.push(fn); return timers.length; } });
  let opts = null;
  w.Sentry = { init: (o) => { opts = o; }, captureException() {} };
  if (captured.script) captured.script.onload();
  return { w, captured, timers, opts: () => opts, store: ss };
}

/* 1 */
t("1 config.js: the public DSN on every host; env tag by host; tracing 0", () => {
  for (const [h, env] of [["www.helm.events", "production"], ["helm.events", "production"], ["helm-v01.vercel.app", "staging"],
    ["localhost", "development"], ["127.0.0.1", "development"], ["helm-v01-git-x.vercel.app", "preview"]]) {
    const c = cfgFor(h);
    assert.equal(c.dsn, DSN, h); assert.equal(c.env, env, h); assert.equal(c.tracesSampleRate, 0, h);
  }
  assert.doesNotMatch(r("public/config.staging.js"), /HELM_TELEMETRY|sentry/i, "staging uses the same DSN from config.js (env tag = staging)");
});

/* 2 */
t("2a telemetry: armed on production + staging, never on localhost", () => {
  for (const h of ["www.helm.events", "helm-v01.vercel.app"]) {
    const { captured, opts } = loadTel(cfgFor(h), { hostname: h });
    assert.ok(captured.script && /browser\.sentry-cdn\.com\/[\d.]+\/bundle\.min\.js$/.test(captured.script.src), h + " loads the plain errors-only bundle");
    assert.equal(opts().dsn, DSN); assert.equal(opts().environment, cfgFor(h).env);
  }
  assert.equal(loadTel(cfgFor("localhost"), { hostname: "localhost" }).captured.script, undefined, "localhost never sends");
});
t("2b telemetry: errors only - no tracing, no replay, no profiling (free plan)", () => {
  const o = loadTel(cfgFor("www.helm.events"), { hostname: "www.helm.events" }).opts();
  assert.equal(o.sampleRate, 1); assert.equal(o.tracesSampleRate, 0); assert.equal(o.sendDefaultPii, false);
  for (const k of ["integrations", "replaysSessionSampleRate", "replaysOnErrorSampleRate", "profilesSampleRate", "tracePropagationTargets"]) assert.equal(o[k], undefined, k);
  assert.doesNotMatch(TEL, /replayIntegration|browserTracingIntegration|browserProfilingIntegration|bundle\.tracing|bundle\.replay/i);
  assert.equal(o.beforeSend.name, "redactEvent"); assert.equal(o.beforeBreadcrumb.name, "redactBreadcrumb");
});
t("2c telemetry: redaction active (e-mail, phone, amount, token, query string)", () => {
  const T = loadTel(cfgFor("www.helm.events"), { hostname: "www.helm.events" }).w.HelmTelemetry;
  const s = T.redact("a@b.in 98765 43210 ₹1,25,000 eyJhbGciOiJIUzI1NiJ9.abc.def /x?token=zzz");
  assert.doesNotMatch(s, /a@b\.in|98765|1,25,000|eyJhbGci|zzz/);
  assert.equal(T.stripUrl("https://www.helm.events/q?sentry_test=1&email=a@b.in"), "https://www.helm.events/q");
});

/* 3 */
t("3 CSP: exactly the DSN ingest host in every connect-src (vercel.json + _headers), no wildcard", () => {
  const VJ = JSON.parse(r("vercel.json")); let k = 0;
  for (const rule of VJ.headers) for (const h of rule.headers || []) {
    if (!/^Content-Security-Policy(-Report-Only)?$/i.test(h.key)) continue;
    if (!/connect-src /.test(h.value)) continue;   // the Trusted Types report-only policy has no connect-src
    const cs = /connect-src ([^;]*)/.exec(h.value)[1];
    assert.deepEqual(cs.split(" ").filter((x) => /sentry/.test(x)), [HOST], rule.source); assert.ok(!cs.includes("*"), rule.source); k++;
  }
  assert.ok(k > 0);
  const HDR = r("public/_headers");
  const lines = HDR.split("\n").filter((l) => /connect-src/.test(l));
  assert.ok(lines.length > 0);
  for (const l of lines) { const cs = /connect-src ([^;]*)/.exec(l)[1]; assert.deepEqual(cs.split(" ").filter((x) => /sentry/.test(x)), [HOST]); assert.ok(!cs.includes("*")); }
  assert.ok(Buffer.byteLength(r("vercel.json")) < 200 * 1024, "vercel.json byte guard");
});

/* 4 */
t("4a ?sentry_test=1 on the staging host: ONE test error, once per tab", () => {
  const store = new Map();
  const a = loadTel(cfgFor("helm-v01.vercel.app"), { hostname: "helm-v01.vercel.app", search: "?sentry_test=1" }, store);
  assert.equal(a.timers.length, 1);
  assert.throws(() => a.timers[0](), /Helm Sentry test error \(staging/);
  const b = loadTel(cfgFor("helm-v01.vercel.app"), { hostname: "helm-v01.vercel.app", search: "?x=1&sentry_test=1" }, store);
  assert.equal(b.timers.length, 0, "already sent in this tab");
});
t("4b ?sentry_test=1 does nothing on production, previews, localhost, or without the flag", () => {
  for (const h of ["www.helm.events", "helm.events", "helm-v01-git-x.vercel.app"]) {
    assert.equal(loadTel(cfgFor(h), { hostname: h, search: "?sentry_test=1" }).timers.length, 0, h);
    // even a forced env tag cannot turn it on off the staging host
    assert.equal(loadTel(Object.assign({}, cfgFor(h), { env: "staging" }), { hostname: h, search: "?sentry_test=1" }).timers.length, 0, h + " forced");
  }
  assert.equal(loadTel(Object.assign({}, cfgFor("localhost"), { allowDev: true }), { hostname: "localhost", search: "?sentry_test=1" }).timers.length, 0);
  for (const q of ["", "?sentry_test=0", "?sentry_test=11", "?xsentry_test=1"])
    assert.equal(loadTel(cfgFor("helm-v01.vercel.app"), { hostname: "helm-v01.vercel.app", search: q }).timers.length, 0, q);
});

console.log(`✓ r45-sentry-dsn: ${n} checks passed`);
