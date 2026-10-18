// client-mailer + _shared/mailer - mocked Supabase + mocked fetch; NO real e-mail is sent.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, post, resetSupaMock, supaLog, fetchLog, captureConsoleError } from "./harness.ts";
import { mailConfig, sendMail, senderHeader } from "../../supabase/functions/_shared/mailer.ts";
import { linkEmail, maskEmail } from "../../supabase/functions/client-mailer/logic.mjs";

const FN = "../../supabase/functions/client-mailer/index.ts";
const OTP = "../../supabase/functions/send-otp/index.ts";
const g = globalThis as any;
const QUOTE = "a0000000-0000-4000-8000-00000000da01";
const TOKEN = "a0000000-0000-4000-8000-0000000000aa";
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_ANON_KEY: "anon", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" };
const RESEND = { ...BASE, RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <mail@helm.events>" };
const auth = { Authorization: "Bearer user-jwt", Origin: "https://helm.events" };

function db(quote: any, booklet: any = null) {
  g.__supaGetUser = (jwt: string) => ({ data: { user: jwt === "user-jwt" ? { id: "u1" } : null } });
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
  assertEquals(senderHeader("Helm <mail@helm.events>", "Sparkle\r\nBcc: x"), '"Sparkle Bcc: x via Helm" <mail@helm.events>');
});

Deno.test("mailer: SMTP path uses injected client, from = '<Studio> via Helm', reply-to studio", async () => {
  let sent: any = null;
  const env = (k: string) => ({ SMTP_HOST: "smtp.gmail.com", SMTP_USER: "me@gmail.com", SMTP_PASS: "pw" } as any)[k];
  const r = await sendMail({ to: "c@example.com", subject: "Hi", text: "t", studio: "Sparkle", replyTo: "studio@sparkle.in" },
    { env, smtp: async (cfg, m) => { sent = { cfg, m }; } });
  assertEquals(r.status, "sent"); assertEquals(r.provider, "smtp");
  assertEquals(sent.m.from, '"Sparkle via Helm" <me@gmail.com>'); assertEquals(sent.m.replyTo, "studio@sparkle.in");
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
    assertEquals(sent.from, '"Sparkle Events via Helm" <mail@helm.events>');
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
    assertEquals(body.to, ["asha@example.com"]); assertEquals(body.from, '"Sparkle Events via Helm" <mail@helm.events>');
    const code = /(\d{6})/.exec(body.subject)![1];
    assert(!logs.join(" ").includes(code));
    const n = supaLog().find((x) => x.table === "notifications"); assert(n);
    assert(!JSON.stringify(n.calls).includes(code), "OTP not in outbox log");
  } finally { rF(); rEnv(); }
});
