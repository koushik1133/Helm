// welcome-mailer (0057 + R119 0327) — dormant by default, shared-secret gate (fail closed), the DATABASE switch
// (welcome_email_switch) checked before any claim, sent through the SHARED mailer (_shared/mailer.ts: SMTP first,
// else Resend), rows without the 0327 safe marker released (never sent), marks rows sent/skipped, provider failure ->
// retry, no PII in logs. Mock-only: no network, no real e-mail.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, resetSupaMock, supaLog, fetchLog, captureConsoleError, post } from "./harness.ts";
import { ownerEmail, memberEmail, LINKS } from "../../supabase/functions/welcome-mailer/templates.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/welcome-mailer/index.ts";
const SECRET = "welcome-shared-secret";
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" };
const ON = { ...BASE, HELM_WELCOME_EMAILS_ENABLED: "true", HELM_WELCOME_EMAIL_SECRET: SECRET, RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <hello@helm.events>" };
const ID1 = "c0000000-0000-4000-8000-0000000057a1";
const ID2 = "c0000000-0000-4000-8000-0000000057a2";
const SAFE = "r119-0327";
const noFetch = () => installFetch(() => { throw new Error("no fetch expected"); });
const req = (secret?: string) => new Request("https://fn.local/", { method: "POST", headers: secret === undefined ? {} : { "x-helm-cron-secret": secret } });
const rpcs = () => supaLog().filter((l) => l.rpc);
const marks = () => rpcs().filter((l) => l.rpc === "welcome_email_outbox_mark");
const claims = () => rpcs().filter((l) => l.rpc === "welcome_email_outbox_claim");

function db(rows: unknown[] = [
  { id: ID1, kind: "studio_owner", to: "owner@studio-a.in", studio: "Studio <A>", name: "Asha Rao", trial: false, trial_ends_at: null, safe: SAFE },
  { id: ID2, kind: "member", to: "member@studio-a.in", studio: "Studio <A>", name: null, trial: false, trial_ends_at: null, safe: SAFE },
], sw: unknown = { data: true, error: null }) {
  g.__supaRpc = (name: string) => name === "welcome_email_switch" ? sw
    : name === "welcome_email_outbox_claim" ? { data: rows, error: null } : { data: "ok", error: null };
}

Deno.test("welcome-mailer: dormant by default -> 200 no-op, DB untouched", async () => {
  resetSupaMock(); db();
  const r = setEnv({ ...BASE, HELM_WELCOME_EMAIL_SECRET: SECRET }); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const res = await h(req(SECRET));
    assertEquals(res.status, 200); assertEquals((await res.json()).status, "dormant");
    assertEquals(supaLog().length, 0);
  } finally { f(); r(); }
});

for (const [name, env, given] of [["wrong secret", ON, "nope"], ["missing header", ON, undefined], ["secret unset (fail closed)", { ...ON, HELM_WELCOME_EMAIL_SECRET: "" }, ""]] as const) {
  Deno.test(`welcome-mailer: ${name} -> 401, DB untouched`, async () => {
    resetSupaMock(); db();
    const r = setEnv(env as Record<string, string>); const f = noFetch();
    try {
      const h = await loadHandler(FN);
      assertEquals((await h(req(given as string | undefined))).status, 401);
      assertEquals(rpcs().length, 0);
    } finally { f(); r(); }
  });
}

Deno.test("welcome-mailer: GET -> 405", async () => {
  resetSupaMock(); db();
  const r = setEnv(ON); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(new Request("https://fn.local/", { method: "GET" }))).status, 405);
  } finally { f(); r(); }
});

Deno.test("welcome-mailer: database switch OFF -> nothing claimed, nothing sent", async () => {
  resetSupaMock(); db(undefined, { data: false, error: null });
  const r = setEnv(ON); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const res = await h(req(SECRET));
    assertEquals(res.status, 200); assertEquals((await res.json()).status, "switched_off");
    assertEquals(claims().length, 0); assertEquals(marks().length, 0);
  } finally { f(); r(); }
});

Deno.test("welcome-mailer: database without 0327 (no switch function) -> 500, the old claim is never called", async () => {
  resetSupaMock(); db(undefined, { data: null, error: { code: "PGRST202" } });
  const r = setEnv(ON); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const { result } = await captureConsoleError(async () => await h(req(SECRET)));
    assertEquals(result.status, 500);
    assertEquals(claims().length, 0);
  } finally { f(); r(); }
});

Deno.test("welcome-mailer: sends owner + member welcomes through the shared mailer (Resend fallback), marks sent, no PII in logs", async () => {
  resetSupaMock(); db();
  const r = setEnv(ON);
  const f = installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ id: "e1" }); throw new Error("unexpected " + url); });
  try {
    const h = await loadHandler(FN);
    const { result, logs } = await captureConsoleError(async () => await h(req(SECRET)));
    assertEquals(result.status, 200);
    assertEquals((await result.json()).sent, 2);
    assertEquals(fetchLog().length, 2);
    const b1 = JSON.parse(String(fetchLog()[0].init?.body)), b2 = JSON.parse(String(fetchLog()[1].init?.body));
    assertEquals(b1.to, ["owner@studio-a.in"]);
    assertEquals(b2.to, ["member@studio-a.in"]);
    assertEquals(b1.from, '"Helm Events" <hello@helm.events>');
    assert(b1.subject.startsWith("Welcome to Helm"));
    assert(b1.html.includes("Studio &lt;A&gt;") && !b1.html.includes("Studio <A>"), "studio name escaped");
    assert(b1.html.includes("Hi Asha,"));
    for (const l of [LINKS.leads, LINKS.floorPlan, LINKS.team, LINKS.manual]) assert(b1.html.includes(l), "owner link " + l);
    assert(b2.html.includes(LINKS.signIn) && b2.subject.includes("joined"));
    assert(b1.text.includes("You received this because you created a Helm studio account"), "compliance footer (text)");
    assert(b2.text.includes("You received this because you joined a studio's team on Helm"));
    assert(!b1.html.includes("free trial") && !b1.text.includes("000000"), "paid studio: no trial wording");
    const m = marks();
    assertEquals(m.length, 2);
    assert(m.every((x) => x.args.p_status === "sent" && x.key === "service-role-secret"));
    assertEquals(claims()[0].args.p_limit, 25);
    const all = logs.join(" ");
    assert(!all.includes("owner@studio-a.in") && !all.includes("member@studio-a.in") && !all.includes("Asha"));
  } finally { f(); r(); }
});

Deno.test("welcome-mailer: no provider at all / bad address / unknown kind -> marked skipped, no fetch", async () => {
  resetSupaMock(); db();
  let r = setEnv({ ...ON, RESEND_API_KEY: "" }); let f = noFetch();
  try {
    const h = await loadHandler(FN);
    assertEquals((await (await h(req(SECRET))).json()).skipped, 2);
    assertEquals(fetchLog().length, 0);
    assert(marks().every((x) => x.args.p_status === "skipped"));
  } finally { f(); r(); }
  resetSupaMock(); db([{ id: ID1, kind: "member", to: "not-an-email", studio: "S", safe: SAFE }, { id: ID2, kind: "weird", to: "a@b.co", studio: "S", safe: SAFE }]);
  r = setEnv(ON); f = noFetch();
  try {
    const h = await loadHandler(FN);
    assertEquals((await (await h(req(SECRET))).json()).skipped, 2);
    assertEquals(fetchLog().length, 0);
  } finally { f(); r(); }
});

Deno.test("welcome-mailer: a row without the 0327 safe marker is released (retry), never sent", async () => {
  resetSupaMock(); db([{ id: ID1, kind: "studio_owner", to: "owner@studio-a.in", studio: "S" }]);
  const r = setEnv(ON); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    assertEquals((await (await h(req(SECRET))).json()).sent, 0);
    assertEquals(fetchLog().length, 0);
    assertEquals(marks()[0].args.p_status, "retry");
  } finally { f(); r(); }
});

Deno.test("welcome-mailer: provider failure -> row released for retry", async () => {
  resetSupaMock(); db([{ id: ID1, kind: "member", to: "member@studio-a.in", studio: "S", safe: SAFE }]);
  const r = setEnv(ON); const f = installFetch(() => jsonResponse({ error: "x" }, 500));
  try {
    const h = await loadHandler(FN);
    const { result, logs } = await captureConsoleError(async () => await h(req(SECRET)));
    assertEquals((await result.json()).failed, 1);
    assertEquals(marks()[0].args.p_status, "retry");
    assert(!logs.join(" ").includes("member@studio-a.in"));
  } finally { f(); r(); }
});

Deno.test("welcome-mailer: malformed rows ignored, claim error -> 500", async () => {
  resetSupaMock(); db([{ id: "../etc", kind: "member", to: "a@b.co", safe: SAFE }]);
  const r = setEnv(ON); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    assertEquals((await (await h(req(SECRET))).json()).invalid, 1);
    assertEquals(marks().length, 0);
    g.__supaRpc = (name: string) => name === "welcome_email_switch" ? { data: true, error: null } : { data: null, error: { code: "42501" } };
    const { result } = await captureConsoleError(async () => await h(req(SECRET)));
    assertEquals(result.status, 500);
  } finally { f(); r(); }
});

Deno.test("welcome-mailer: per-IP limit -> 429 before the secret check", async () => {
  resetSupaMock(); db();
  const r = setEnv(ON); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    let s = 0;
    for (let i = 0; i < 31; i++) s = (await h(post({}, { "x-forwarded-for": "8.8.5.7" }))).status;
    assertEquals(s, 429);
  } finally { f(); r(); }
});

Deno.test("welcome templates: escape names, strip control chars, sane fallbacks", () => {
  const o = ownerEmail({ name: "<b>x</b>", studio: "A\r\nBcc: evil@x.co" });
  assert(!o.subject.includes("\n") && !o.subject.includes("\r"), "no header injection");
  assert(o.html.includes("&lt;b&gt;x&lt;/b&gt;") || o.html.includes("Hi &lt;b&gt;x&lt;/b&gt;,"));
  const m = memberEmail({});
  assert(m.subject.includes("your studio") && m.html.includes("Hi there,"));
  assert(m.text.includes(LINKS.signIn));
});
