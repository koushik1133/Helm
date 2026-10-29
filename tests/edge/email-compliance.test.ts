// E-mail compliance (0165): footers, RFC 8058 List-Unsubscribe headers, the public
// email-unsubscribe endpoint and the shared mailer passing headers. Mock-only, no network,
// NO real e-mail is sent.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, loadHandler, resetSupaMock, supaLog, captureConsoleError } from "./harness.ts";
import { listUnsubHeaders, mktFooter, DEFAULT_POSTAL_ADDRESS, POSTAL_PLACEHOLDER, postalAddress, txFooter, unsubLinks, withFooter, UNSUB_TOKEN_RE } from "../../supabase/functions/_shared/email-compliance.mjs";
import { sendMail } from "../../supabase/functions/_shared/mailer.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/email-unsubscribe/index.ts";
const TOKEN = "v1." + "1".repeat(32) + ".616e61406578616d706c652e636f6d." + "c".repeat(64);
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", APP_URL: "https://www.helm.events" };

Deno.test("headers: RFC 2369 mailto + https, RFC 8058 one-click post", () => {
  const h = listUnsubHeaders("https://proj.supabase.co/functions/v1/email-unsubscribe?t=" + TOKEN, "unsubscribe@helm.events");
  assertEquals(h["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assertEquals(h["List-Unsubscribe"], "<mailto:unsubscribe@helm.events?subject=unsubscribe>, <https://proj.supabase.co/functions/v1/email-unsubscribe?t=" + TOKEN + ">");
  assertEquals(listUnsubHeaders("http://insecure/x", ""), {});
  assert(listUnsubHeaders("https://a.b/x", "bad\r\nBcc: x")["List-Unsubscribe"].startsWith("<mailto:unsubscribe@helm.events"));
});

Deno.test("links: page + one-click endpoint; malformed token -> null", () => {
  const l = unsubLinks(TOKEN, { app: "https://www.helm.events/", functionsUrl: "https://proj.supabase.co/functions/v1" })!;
  assertEquals(l.page, "https://www.helm.events/unsubscribe?t=" + TOKEN);
  assertEquals(l.oneClick, "https://proj.supabase.co/functions/v1/email-unsubscribe?t=" + TOKEN);
  assertEquals(unsubLinks("v1.x", {}), null);
  assert(UNSUB_TOKEN_RE.test(TOKEN));
});

Deno.test("footers: transactional has reason + privacy + postal, no unsubscribe; marketing has unsubscribe", () => {
  const t = txFooter("otp", { app: "https://www.helm.events" });
  // codeql[js/incomplete-url-substring-sanitization] -- false positive: test asserts the footer text contains an expected URL; not a security sanitizer on untrusted input.
  assert(t.text.includes("You received this because") && t.text.includes("https://www.helm.events/privacy") && t.text.includes(POSTAL_PLACEHOLDER));
  assertEquals(DEFAULT_POSTAL_ADDRESS, "Mindspace IT Park, Madhapur, Hyderabad, Telangana 500081"); assertEquals(postalAddress(() => undefined), DEFAULT_POSTAL_ADDRESS);
  assert(!/unsubscribe/i.test(t.html + t.text));
  const s = txFooter("security", { noLinks: true });
  assert(!/https?:\/\//.test(s.html));
  const m = mktFooter("https://www.helm.events/unsubscribe?t=" + TOKEN, { sender: "Sparkle <b>", address: "1 Main St" });
  assert(m.html.includes(">Unsubscribe</a>") && m.html.includes("1 Main St") && !m.html.includes("<b>"));
  assert(m.text.includes("Unsubscribe: https://www.helm.events/unsubscribe?t="));
  assertEquals(postalAddress((k: string) => (k === "HELM_POSTAL_ADDRESS" ? " 12 Road,\r\nCity " : undefined)), "12 Road, City");
  const w = withFooter({ text: "hi", html: "<html><body><p>hi</p></body></html>" }, t);
  assert(w.html!.indexOf("You received this") < w.html!.indexOf("</body>"));
  assertEquals(withFooter({ text: "hi" }, t).html, undefined);
});

Deno.test("mailer: transactional footer added; headers passed to Resend and SMTP", async () => {
  const env = (k: string) => ({ RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <mail@helm.events>", APP_URL: "https://www.helm.events" } as any)[k];
  let body: any = null;
  const f = installFetch((url, init) => { if (url === "https://api.resend.com/emails") { body = JSON.parse(String(init?.body)); return new Response("{}"); } throw new Error("unexpected " + url); });
  try {
    await sendMail({ to: "c@example.com", subject: "s", text: "Your code", html: "<p>x</p>", txReason: "otp" }, { env });
    assert(body.text.includes("a one-time code was requested") && body.html.includes("/privacy"));
    assertEquals(body.headers, undefined);
    const h = listUnsubHeaders("https://a.example/x", "");
    await sendMail({ to: "c@example.com", subject: "s", text: "t", footer: mktFooter("https://a.example/u"), headers: h }, { env });
    assertEquals(body.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  } finally { f(); }
  let smtpMail: any = null;
  const senv = (k: string) => ({ SMTP_HOST: "smtp.gmail.com", SMTP_USER: "me@gmail.com", SMTP_PASS: "pw" } as any)[k];
  await sendMail({ to: "c@example.com", subject: "s", text: "t", headers: { "List-Unsubscribe": "<https://a.example/x>" } }, { env: senv, smtp: async (_c, m) => { smtpMail = m; } });
  assertEquals(smtpMail.headers["List-Unsubscribe"], "<https://a.example/x>");
  assert(smtpMail.text.includes("You received this because"));
});

function rpcMock(optedOut = false) {
  g.__supaRpc = (name: string, args: any) => {
    if (args.p_token !== TOKEN) return { data: { ok: false }, error: null };
    if (name === "email_unsub_status") return { data: { ok: true, sender: "Sparkle", email: "a***@example.com", opted_out: optedOut }, error: null };
    if (name === "email_unsub_set") return { data: { ok: true, sender: "Sparkle", email: "a***@example.com", opted_out: args.p_opt_out }, error: null };
    return { data: null, error: null };
  };
}

Deno.test("email-unsubscribe: RFC 8058 one-click POST unsubscribes (source one_click)", async () => {
  resetSupaMock(); rpcMock();
  const r = setEnv(BASE); const f = installFetch((u) => { throw new Error("unexpected " + u); });
  try {
    const h = await loadHandler(FN);
    const { result, logs } = await captureConsoleError(async () => await h(new Request("https://fn.local/email-unsubscribe?t=" + TOKEN,
      { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" })));
    assertEquals(result.status, 200); assertEquals(await result.text(), "unsubscribed");
    const call = supaLog().find((l: any) => l.rpc === "email_unsub_set" || l.name === "email_unsub_set" || JSON.stringify(l).includes("email_unsub_set"));
    assert(call, "email_unsub_set called");
    assert(JSON.stringify(call).includes("one_click") && JSON.stringify(call).includes('"p_opt_out":true'));
    assert(!logs.join(" ").includes(TOKEN));
  } finally { f(); r(); }
});

Deno.test("email-unsubscribe: page JSON status / unsubscribe / resubscribe; forged token -> ok false", async () => {
  resetSupaMock(); rpcMock(true);
  const r = setEnv(BASE); const f = installFetch((u) => { throw new Error("unexpected " + u); });
  const post = (b: unknown) => new Request("https://fn.local/email-unsubscribe", { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://www.helm.events" }, body: JSON.stringify(b) });
  try {
    const h = await loadHandler(FN);
    assertEquals((await (await h(post({ t: TOKEN, action: "status" }))).json()).opted_out, true);
    assertEquals((await (await h(post({ t: TOKEN, action: "resubscribe" }))).json()).opted_out, false);
    assertEquals((await (await h(post({ t: TOKEN, action: "unsubscribe" }))).json()).opted_out, true);
    const bad = TOKEN.slice(0, -1) + "d";
    assertEquals((await (await h(post({ t: bad, action: "unsubscribe" }))).json()).ok, false);
    assertEquals((await (await h(post({ t: "nope", action: "unsubscribe" }))).json()).ok, false);
    assertEquals((await h(post({ t: TOKEN, action: "delete" }))).status, 400);
  } finally { f(); r(); }
});

Deno.test("email-unsubscribe: GET never changes anything, redirects to the page", async () => {
  resetSupaMock(); let called = false; g.__supaRpc = () => { called = true; return { data: null, error: null }; };
  const r = setEnv(BASE);
  try {
    const h = await loadHandler(FN);
    const res = await h(new Request("https://fn.local/email-unsubscribe?t=" + TOKEN));
    assertEquals(res.status, 303);
    assertEquals(res.headers.get("Location"), "https://www.helm.events/unsubscribe?t=" + TOKEN);
    assertEquals(called, false);
    assertEquals((await h(new Request("https://fn.local/?t=<script>"))).headers.get("Location"), "https://www.helm.events/unsubscribe");
  } finally { r(); }
});

Deno.test("comms-dispatch: follow-up needs a token + not opted out; trial uses Helm scope", async () => {
  const origServe = (Deno as any).serve;
  (Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown() {}, ref() {}, unref() {} });
  const r = setEnv(BASE);
  try {
    const m: any = await import("../../supabase/functions/comms-dispatch/index.ts?v=" + crypto.randomUUID());
    assert(m.NON_TRANSACTIONAL.has("follow_up") && !m.NON_TRANSACTIONAL.has("pay_reminder"));
    const e = (k: string) => (BASE as any)[k];
    assertEquals(m.marketingExtra(null, "S", "r", "https://www.helm.events", e), null);                       // 0165 missing
    assertEquals(m.marketingExtra({ ok: true, opted_out: true, token: TOKEN }, "S", "r", "https://www.helm.events", e), null);
    const x = m.marketingExtra({ ok: true, opted_out: false, token: TOKEN }, "Sparkle", "you asked Sparkle about an event", "https://www.helm.events", e);
    assert(x.footer.html.includes("https://www.helm.events/unsubscribe?t=" + TOKEN));
    assert(x.headers["List-Unsubscribe"].includes("https://proj.supabase.co/functions/v1/email-unsubscribe?t=" + TOKEN));
    assertEquals(x.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  } finally { (Deno as any).serve = origServe; r(); }
});
