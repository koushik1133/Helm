// client-mailer + _shared/mailer - mocked Supabase + mocked fetch; NO real e-mail is sent.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, post, resetSupaMock, supaLog, fetchLog, captureConsoleError } from "./harness.ts";
import { brandMode, fromName, mailConfig, sendMail, senderHeader } from "../../supabase/functions/_shared/mailer.ts";
import { linkEmail, maskEmail } from "../../supabase/functions/client-mailer/logic.mjs";

const FN = "../../supabase/functions/client-mailer/index.ts";
const OTP = "../../supabase/functions/send-otp/index.ts";
const g = globalThis as any;
const QUOTE = "a0000000-0000-4000-8000-00000000da01";
const TOKEN = "a0000000-0000-4000-8000-0000000000aa";
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" };
const RESEND = { ...BASE, RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <mail@helm.events>" };
const auth = { Authorization: "Bearer user-jwt", Origin: "https://helm.events" };

// r56 (0297): client_mailer_check (quotes EDIT, asked as the caller) answers ok for these tests
const CHK = { data: { ok: true, link_live: true }, error: null };
function db(quote: any, booklet: any = null) {
  g.__supaGetUser = (jwt: string) => ({ data: { user: jwt === "user-jwt" ? { id: "u1" } : null } });
  g.__supaRpc = (name: string) => name === "client_mailer_check" ? CHK : { data: null, error: null };
  g.__supaResolver = (table: string, _c: unknown, key: string) => {
    if (table === "quotes") return { data: key === "anon" ? quote : null, error: null };
    if (table === "client_booklets") return { data: booklet, error: null };
    if (table === "organizations") return { data: { name: "Sparkle Events", business_email: "studio@sparkle.in" }, error: null };
    return { data: null, error: null };
  };
}
const Q = { id: QUOTE, org_id: "o1", client: { name: "Asha", email: "asha@example.com" }, approval_token: TOKEN };

Deno.test("mailer: provider order Resend > SMTP > not_configured; sender name", () => {
  const e = (m: Record<string, string>) => (k: string) => m[k];
  assertEquals(mailConfig(e({})).provider, null);
  assertEquals(mailConfig(e({ SMTP_HOST: "smtp.gmail.com", SMTP_USER: "me@gmail.com", SMTP_PASS: "x" })).provider, "smtp");
  assertEquals(mailConfig(e({ SMTP_HOST: "h", SMTP_USER: "u@x.com", SMTP_PASS: "p", SMTP_PORT: "587" })).smtp!.tls, false);
  assertEquals(mailConfig(e({ RESEND_API_KEY: "k", RESEND_FROM: "a@b.com", SMTP_HOST: "h", SMTP_USER: "u", SMTP_PASS: "p" })).provider, "resend");
  assertEquals(senderHeader("Helm <mail@helm.events>", "Sparkle\r\nBcc: x"), '"Helm Events" <mail@helm.events>');
  assertEquals(senderHeader("Helm <mail@helm.events>", "Sparkle\r\nBcc: x", "studio"), '"Sparkle Bcc: x via Helm" <mail@helm.events>');
  assertEquals(brandMode(e({})), "helm"); assertEquals(brandMode(e({ EMAIL_BRAND_MODE: "garbage" })), "helm");
  assertEquals(brandMode(e({ EMAIL_BRAND_MODE: " Studio " })), "studio");
  assertEquals(fromName("", "studio"), "Helm Events");
});

Deno.test("mailer: SMTP path uses injected client, from = 'Helm Events' (default), reply-to studio", async () => {
  let sent: any = null;
  const env = (k: string) => ({ SMTP_HOST: "smtp.gmail.com", SMTP_USER: "me@gmail.com", SMTP_PASS: "pw" } as any)[k];
  const r = await sendMail({ to: "c@example.com", subject: "Hi", text: "t", studio: "Sparkle", replyTo: "studio@sparkle.in" },
    { env, smtp: async (cfg, m) => { sent = { cfg, m }; } });
  assertEquals(r.status, "sent"); assertEquals(r.provider, "smtp");
  assertEquals(sent.m.from, '"Helm Events" <me@gmail.com>'); assertEquals(sent.m.replyTo, "studio@sparkle.in");
  await sendMail({ to: "c@example.com", subject: "Hi", text: "t", studio: "Sparkle" },
    { env: (k: string) => k === "EMAIL_BRAND_MODE" ? "studio" : env(k), smtp: async (cfg, m) => { sent = { cfg, m }; } });
  assertEquals(sent.m.from, '"Sparkle via Helm" <me@gmail.com>');
  assertEquals(sent.cfg.port, 465);
  const f = await sendMail({ to: "c@example.com", subject: "Hi", text: "t" }, { env, smtp: async () => { throw new Error("535 auth pw"); } });
  assertEquals(f.status, "failed"); assert(!String(f.reason).includes("pw"));
  assertEquals((await sendMail({ to: "bad", subject: "s", text: "t" }, { env })).status, "failed");
  assertEquals((await sendMail({ to: "c@example.com", subject: "s", text: "t" }, { env: () => undefined })).status, "not_configured");
});

Deno.test("client-mailer logic: masked e-mail, link escaping", () => {
  assertEquals(maskEmail("asha@example.com"), "a***@example.com");
  const m = linkEmail("approval", { client: "<b>A</b>", studio: "S", link: "https://helm.events/portal.html?token=x" });
  assert(m.html.includes("&lt;b&gt;A&lt;/b&gt;")); assert(m.text.includes("https://helm.events/portal.html?token=x"));
  let threw = false; try { linkEmail("booklet", { link: "javascript:alert(1)" }); } catch (_) { threw = true; } assert(threw);
  const b = linkEmail("booklet", { client: "Asha", studio: "Sparkle", link: "https://helm.events/booklet?t=x" });
  assert(b.html.startsWith("<!DOCTYPE html>") && b.html.includes("https://www.helm.events/email/helm-logo-v3.png"), "designed layout + logo");
  assert(b.html.includes("Open booklet") && b.html.includes("Mindspace IT Park, Madhapur, Hyderabad, Telangana 500081"), "button + address");
  assert(b.html.includes("Helm Events</strong>") && b.text.includes("\n\nHelm Events"), "Helm sign-off");
  assert(linkEmail("booklet", { studio: "Sparkle", link: "https://x.io/b", brand: "studio" }).text.includes("\n\nSparkle"), "studio sign-off");
});

Deno.test("mailer: designed html gets no second compliance footer", async () => {
  let sent: any = null;
  const env = (k: string) => ({ SMTP_HOST: "h", SMTP_USER: "me@gmail.com", SMTP_PASS: "pw" } as any)[k];
  const m = linkEmail("approval", { studio: "S", link: "https://helm.events/portal.html?token=x" });
  await sendMail({ to: "c@example.com", subject: m.subject, text: m.text, html: m.html }, { env, smtp: async (_c, x) => { sent = x; } });
  assertEquals((sent.html.match(/You received this because/g) || []).length, 1);
  assert(sent.text.includes("You received this because"));
});

Deno.test("client-mailer: no / anon JWT -> 401; bad body -> 400", async () => {
  resetSupaMock(); db(Q);
  const rEnv = setEnv(BASE); const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ quote_id: QUOTE }))).status, 401);
    assertEquals((await h(post({ quote_id: QUOTE }, { Authorization: "Bearer anon" }))).status, 401);
    assertEquals((await h(post({ quote_id: "x" }, auth))).status, 400);
    assertEquals((await h(post({ quote_id: QUOTE, kind: "spam" }, auth))).status, 400);
  } finally { rF(); rEnv(); }
});

Deno.test("client-mailer: quote not visible to caller (other studio) -> 403, nothing sent", async () => {
  resetSupaMock(); db(null);
  const rEnv = setEnv(RESEND); const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ quote_id: QUOTE }, auth))).status, 403);
    assertEquals(fetchLog().length, 0);
  } finally { rF(); rEnv(); }
});

Deno.test("client-mailer: recipient comes from the QUOTE, never the body; Resend sent", async () => {
  resetSupaMock(); db(Q);
  const rEnv = setEnv(RESEND);
  const rF = installFetch((url) => url === "https://api.resend.com/emails" ? jsonResponse({ id: "e1" }) : (() => { throw new Error(url); })());
  try {
    const h = await loadHandler(FN);
    const r = await h(post({ quote_id: QUOTE, kind: "approval", to: "attacker@evil.com", email: "attacker@evil.com" }, auth));
    assertEquals(r.status, 200);
    const j = await r.json(); assertEquals(j.status, "sent"); assertEquals(j.masked, "a***@example.com");
    const sent = JSON.parse(String(fetchLog()[0].init!.body));
    assertEquals(sent.to, ["asha@example.com"]);
    assertEquals(sent.from, '"Helm Events" <mail@helm.events>');
    assert(String(sent.html).includes("helm-logo-v3.png"), "designed layout");
    assertEquals(sent.reply_to, "studio@sparkle.in");
    assert(sent.text.includes("https://helm.events/portal.html?token=" + TOKEN));
    const log = supaLog().find((x) => x.table === "notifications");
    assert(log, "notification row written");
  } finally { rF(); rEnv(); }
});

Deno.test("client-mailer: not configured -> status not_configured (200), nothing sent", async () => {
  resetSupaMock(); db(Q);
  const rEnv = setEnv(BASE); const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(FN);
    const r = await h(post({ quote_id: QUOTE, kind: "approval" }, auth));
    assertEquals(r.status, 200); assertEquals((await r.json()).status, "not_configured");
  } finally { rF(); rEnv(); }
});

Deno.test("client-mailer: booklet needs a live booklet link; no approval token -> 409", async () => {
  resetSupaMock(); db({ ...Q, approval_token: null }, null);
  const rEnv = setEnv(RESEND); const rF = installFetch(() => jsonResponse({ id: "e" }));
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ quote_id: QUOTE, kind: "approval" }, auth))).status, 409);
    assertEquals((await h(post({ quote_id: QUOTE, kind: "booklet" }, auth))).status, 409);
    db(Q, { token: TOKEN, expires_at: new Date(Date.now() + 864e5).toISOString(), revoked_at: null });
    const r = await h(post({ quote_id: QUOTE, kind: "booklet" }, auth));
    assertEquals(r.status, 200);
    assert(JSON.parse(String(fetchLog().at(-1)!.init!.body)).text.includes("/booklet?t=" + TOKEN));
  } finally { rF(); rEnv(); }
});

Deno.test("client-mailer r56 (C-02): no quotes EDIT -> 403 before anything is read or sent; check asked AS THE CALLER", async () => {
  resetSupaMock(); db(Q, { token: TOKEN, expires_at: new Date(Date.now() + 864e5).toISOString(), revoked_at: null });
  const rEnv = setEnv(RESEND); const rF = installFetch((url) => { throw new Error("must not send: " + url); });
  try {
    const h = await loadHandler(FN);
    g.__supaRpc = (name: string) => name === "client_mailer_check" ? { data: null, error: { code: "42501", message: "not authorized" } } : { data: null, error: null };
    for (const kind of ["approval", "booklet"]) {
      const r = await h(post({ quote_id: QUOTE, kind }, auth));
      assertEquals(r.status, 403); assert(/permission to edit quotes/.test((await r.json()).error));
    }
    // a database without 0297 (function missing) or an odd answer also refuses - nothing is sent
    g.__supaRpc = (name: string) => name === "client_mailer_check" ? { data: null, error: { code: "PGRST202", message: "not found" } } : { data: null, error: null };
    assertEquals((await h(post({ quote_id: QUOTE, kind: "approval" }, auth))).status, 403);
    g.__supaRpc = (name: string) => name === "client_mailer_check" ? { data: { stored: true }, error: null } : { data: null, error: null };
    assertEquals((await h(post({ quote_id: QUOTE, kind: "approval" }, auth))).status, 403);
    assertEquals(fetchLog().length, 0);
    assert(!supaLog().some((x) => x.table === "notifications"), "no log row");
    const calls = supaLog().filter((x) => x.rpc === "client_mailer_check");
    assert(calls.length > 0 && calls.every((x) => x.key === "anon"), "asked with the caller's client (anon key + user JWT), never the service role");
    assertEquals(calls[0].args, { p_quote: QUOTE, p_kind: "approval" });
  } finally { rF(); rEnv(); }
});

Deno.test("client-mailer r56 (C-03): an expired / not-live approval link is never e-mailed -> 409", async () => {
  resetSupaMock(); db({ ...Q, approval_token_expires_at: new Date(Date.now() - 60_000).toISOString() });
  const rEnv = setEnv(RESEND); const rF = installFetch((url) => { throw new Error("must not send: " + url); });
  try {
    const h = await loadHandler(FN);
    let r = await h(post({ quote_id: QUOTE, kind: "approval" }, auth));
    assertEquals(r.status, 409); assertEquals((await r.json()).error, "create the approval link first");
    // stored expiry in the future, but the server says the link is no longer live (auto-expired / paused / cancelled)
    db({ ...Q, approval_token_expires_at: new Date(Date.now() + 864e5).toISOString() });
    g.__supaRpc = (name: string) => name === "client_mailer_check" ? { data: { ok: true, link_live: false }, error: null } : { data: null, error: null };
    r = await h(post({ quote_id: QUOTE, kind: "approval" }, auth));
    assertEquals(r.status, 409);
    assertEquals(fetchLog().length, 0);
  } finally { rF(); rEnv(); }
});

Deno.test("client-mailer: FREE TRIAL studio -> test_mode, NOTHING sent, row logged suppressed", async () => {
  resetSupaMock(); db(Q, { token: TOKEN, expires_at: new Date(Date.now() + 864e5).toISOString(), revoked_at: null });
  g.__supaRpc = (name: string) => name === "client_mailer_check" ? CHK : name === "_sample_outbound_blocked" ? { data: true, error: null } : { data: null, error: null };
  const rEnv = setEnv(RESEND); const rF = installFetch((url) => { throw new Error("must not send: " + url); });
  try {
    const h = await loadHandler(FN);
    for (const kind of ["booklet", "approval"]) {
      const r = await h(post({ quote_id: QUOTE, kind }, auth));
      assertEquals(r.status, 200); const j = await r.json();
      assertEquals(j.status, "test_mode"); assert(String(j.reason).startsWith("Test mode"));
    }
    assertEquals(fetchLog().length, 0);
    const rows = supaLog().filter((x) => x.table === "notifications");
    assert(rows.length === 2 && rows.every((x) => JSON.stringify(x.calls).includes('"suppressed"')), "suppressed rows");
  } finally { rF(); rEnv(); }
});

Deno.test("client-mailer: trial check falls back to studio_subscriptions, fails CLOSED when unknown", async () => {
  resetSupaMock();
  const B = { token: TOKEN, expires_at: new Date(Date.now() + 864e5).toISOString(), revoked_at: null };
  g.__supaGetUser = () => ({ data: { user: { id: "u1" } } });
  g.__supaRpc = (name: string) => name === "client_mailer_check" ? CHK : ({ data: null, error: { code: "42501", message: "permission denied" } });
  let subs: any = { data: { status: "trial" }, error: null };
  g.__supaResolver = (table: string) => table === "quotes" ? { data: Q, error: null } : table === "client_booklets" ? { data: B, error: null }
    : table === "organizations" ? { data: { name: "Sparkle" }, error: null } : table === "studio_subscriptions" ? subs : { data: null, error: null };
  const rEnv = setEnv(RESEND); const rF = installFetch((url) => { throw new Error("must not send: " + url); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await (await h(post({ quote_id: QUOTE, kind: "booklet" }, auth))).json()).status, "test_mode");
    subs = { data: null, error: { code: "XX000", message: "down" } };
    const r = await h(post({ quote_id: QUOTE, kind: "booklet" }, auth));
    assertEquals(r.status, 503); assertEquals((await r.json()).status, "failed");
    assertEquals(fetchLog().length, 0);
  } finally { rF(); rEnv(); }
});

Deno.test("send-otp e-mail: SMTP/Resend via shared mailer; OTP never logged", async () => {
  resetSupaMock();
  g.__supaRpc = (name: string) => name === "wa_otp_begin"
    ? { data: { quote_id: QUOTE, phone_key: "9800000001", to: "919800000001", email: "asha@example.com", masked: "a***@example.com", resends_left: 3 }, error: null }
    : { data: { ok: true }, error: null };
  g.__supaResolver = (t: string) => t === "quotes" ? { data: { org_id: "o1" }, error: null }
    : t === "organizations" ? { data: { name: "Sparkle Events", business_email: "studio@sparkle.in" }, error: null } : { data: null, error: null };
  const rEnv = setEnv(RESEND);
  const rF = installFetch((url) => url === "https://api.resend.com/emails" ? jsonResponse({ id: "e" }) : (() => { throw new Error(url); })());
  try {
    const h = await loadHandler(OTP);
    const { result, logs } = await captureConsoleError(async () => await h(post({ token: TOKEN, channel: "email" })));
    assertEquals(result.status, 200);
    const j = await result.json(); assertEquals(j.status, "sent");
    const body = JSON.parse(String(fetchLog()[0].init!.body));
    assertEquals(body.to, ["asha@example.com"]); assertEquals(body.from, '"Helm Events" <mail@helm.events>');
    assert(String(body.html).includes("Mindspace IT Park"), "otp footer address");
    const code = /(\d{6})/.exec(body.subject)![1];
    assert(!logs.join(" ").includes(code));
    const n = supaLog().find((x) => x.table === "notifications"); assert(n);
    assert(!JSON.stringify(n.calls).includes(code), "OTP not in outbox log");
  } finally { rF(); rEnv(); }
});
