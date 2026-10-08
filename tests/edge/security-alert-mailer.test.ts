// security-alert-mailer (0054) — dormant by default, shared-secret gate (fail closed),
// Resend-only provider, DB decides recipients, failure → retry, no PII in logs. Mock-only.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, resetSupaMock, supaLog, fetchLog, captureConsoleError, post } from "./harness.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/security-alert-mailer/index.ts";
const SECRET = "sec-alert-shared-secret";
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" };
const ON = { ...BASE, HELM_SECURITY_ALERTS_ENABLED: "true", HELM_SECURITY_ALERT_SECRET: SECRET, RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <alerts@helm.events>" };
const ID1 = "c0000000-0000-4000-8000-0000000054a1";
const ID2 = "c0000000-0000-4000-8000-0000000054a2";
const noFetch = () => installFetch(() => { throw new Error("no fetch expected"); });
const req = (secret?: string) => new Request("https://fn.local/", { method: "POST", headers: secret === undefined ? {} : { "x-helm-cron-secret": secret } });
const rpcs = () => supaLog().filter((l) => l.rpc);
const marks = () => rpcs().filter((l) => l.rpc === "security_alert_outbox_mark");

function db(rows: unknown[] = [
  { id: ID1, hq: false, type: "upload_rejected", label: "Upload rejected by the scanner", count: 4, studio: "Studio <A>", to: ["admin@studio-a.in"] },
  { id: ID2, hq: true, type: "hq_operator_added", label: "HQ operator added", count: 1, studio: null, to: [] },
]) {
  g.__supaRpc = (name: string) => name === "security_alert_outbox_claim" ? { data: rows, error: null } : { data: "ok", error: null };
}

Deno.test("security-alert-mailer: dormant by default -> 200 no-op, DB untouched", async () => {
  resetSupaMock(); db();
  const r = setEnv({ ...BASE, HELM_SECURITY_ALERT_SECRET: SECRET }); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const res = await h(req(SECRET));
    assertEquals(res.status, 200); assertEquals((await res.json()).status, "dormant");
    assertEquals(supaLog().length, 0);
  } finally { f(); r(); }
});

for (const [name, env, given] of [["wrong secret", ON, "nope"], ["missing header", ON, undefined], ["secret unset (fail closed)", { ...ON, HELM_SECURITY_ALERT_SECRET: "" }, ""]] as const) {
  Deno.test(`security-alert-mailer: ${name} -> 401, DB untouched`, async () => {
    resetSupaMock(); db();
    const r = setEnv(env as Record<string, string>); const f = noFetch();
    try {
      const h = await loadHandler(FN);
      assertEquals((await h(req(given as string | undefined))).status, 401);
      assertEquals(rpcs().length, 0);
    } finally { f(); r(); }
  });
}

Deno.test("security-alert-mailer: GET -> 405", async () => {
  resetSupaMock(); db();
  const r = setEnv(ON); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(new Request("https://fn.local/", { method: "GET" }))).status, 405);
  } finally { f(); r(); }
});

Deno.test("security-alert-mailer: sends to DB-chosen admins + HQ inbox via Resend only, no PII in logs", async () => {
  resetSupaMock(); db();
  const r = setEnv({ ...ON, HELM_SECURITY_ALERT_HQ_TO: "hq@helm.events" });
  const f = installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ id: "e1" }); throw new Error("unexpected " + url); });
  try {
    const h = await loadHandler(FN);
    const { result, logs } = await captureConsoleError(async () => await h(req(SECRET)));
    assertEquals(result.status, 200);
    assertEquals((await result.json()).sent, 2);
    assertEquals(fetchLog().length, 2);
    const b1 = JSON.parse(String(fetchLog()[0].init?.body)), b2 = JSON.parse(String(fetchLog()[1].init?.body));
    assertEquals(b1.to, ["admin@studio-a.in"]);
    assertEquals(b2.to, ["hq@helm.events"]);
    assert(b1.html.includes("Studio &lt;A&gt;") && b1.html.includes("4 times"));
    assert(!/https?:\/\//.test(b1.html) && !/token/i.test(b1.html), "no links / tokens in the e-mail");
    const m = marks();
    assertEquals(m.length, 2);
    assert(m.every((x) => x.args.p_status === "sent" && x.key === "service-role-secret"));
    assertEquals(rpcs()[0].args.p_limit, 25);
    assert(!logs.join(" ").includes("admin@studio-a.in") && !logs.join(" ").includes("hq@helm.events"));
  } finally { f(); r(); }
});

Deno.test("security-alert-mailer: no provider key / no HQ inbox -> marked skipped, no fetch", async () => {
  resetSupaMock(); db();
  const r = setEnv({ ...ON, RESEND_API_KEY: "" }); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    assertEquals((await (await h(req(SECRET))).json()).skipped, 2);
    assertEquals(fetchLog().length, 0);
    assert(marks().every((x) => x.args.p_status === "skipped"));
  } finally { f(); r(); }
});

Deno.test("security-alert-mailer: provider failure -> row released for retry", async () => {
  resetSupaMock(); db([{ id: ID1, hq: false, label: "x", count: 1, studio: "S", to: ["admin@studio-a.in"] }]);
  const r = setEnv(ON); const f = installFetch(() => jsonResponse({ error: "x" }, 500));
  try {
    const h = await loadHandler(FN);
    const { result } = await captureConsoleError(async () => await h(req(SECRET)));
    assertEquals((await result.json()).failed, 1);
    assertEquals(marks()[0].args.p_status, "retry");
  } finally { f(); r(); }
});

Deno.test("security-alert-mailer: malformed rows ignored, claim error -> 500", async () => {
  resetSupaMock(); db([{ id: "../etc", to: ["a@b.co"] }]);
  const r = setEnv(ON); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    assertEquals((await (await h(req(SECRET))).json()).invalid, 1);
    assertEquals(marks().length, 0);
    g.__supaRpc = () => ({ data: null, error: { code: "42501" } });
    const { result } = await captureConsoleError(async () => await h(req(SECRET)));
    assertEquals(result.status, 500);
  } finally { f(); r(); }
});

Deno.test("security-alert-mailer: per-IP limit -> 429 before the secret check", async () => {
  resetSupaMock(); db();
  const r = setEnv(ON); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    let s = 0;
    for (let i = 0; i < 31; i++) s = (await h(post({}, { "x-forwarded-for": "7.7.7.7" }))).status;
    assertEquals(s, 429);
  } finally { f(); r(); }
});
