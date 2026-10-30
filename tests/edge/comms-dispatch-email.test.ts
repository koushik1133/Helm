// comms-dispatch e-mail transport (release 1018): SMTP (shared mailer, e.g. Gmail) first, Resend
// only when SMTP is not set, neither -> skipped. Invitation-site (0195), booklet (0200) and the
// other outbox / trial mails keep their compliance footer + List-Unsubscribe headers (0165) on
// both transports. Mock-only: Deno.connect is replaced by an in-memory fake SMTP server and
// fetch by a recorder - NO network, NO real e-mail is sent.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, resetSupaMock, fetchLog, captureConsoleError } from "./harness.ts";
import { mailConfig } from "../../supabase/functions/_shared/mailer.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/comms-dispatch/index.ts";
const CRON = "comms-shared-secret-xyz";
const TOKEN = "v1." + "1".repeat(32) + ".616e61406578616d706c652e636f6d." + "c".repeat(64);
const BOOKLET_TOKEN = "0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0";
const ID1 = "a0000000-0000-4000-8000-000000000001", ID2 = "a0000000-0000-4000-8000-000000000002", ID3 = "a0000000-0000-4000-8000-000000000003";
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  HELM_COMMS_SECRET: CRON, APP_URL: "https://www.helm.events" };
const SMTP = { SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", SMTP_USER: "owner@gmail.com", SMTP_PASS: "gmail-app-pass" };
const RESEND = { RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <hello@helm.events>" };

// ---- in-memory fake SMTP server behind Deno.connect --------------------------------------
type Sent = { from: string; rcpt: string; data: string };
function installFakeSmtp(): { sent: Sent[]; connects: { hostname: string; port: number }[]; restore: () => void } {
  const sent: Sent[] = [], connects: { hostname: string; port: number }[] = [];
  const orig = (Deno as any).connect, origTls = (Deno as any).connectTls, origStart = (Deno as any).startTls;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const fake = (o: { hostname: string; port: number }) => {
    connects.push({ hostname: o.hostname, port: o.port });
    let out = "220 fake ready\r\n", inbuf = "", inData = false, cur: Sent = { from: "", rcpt: "", data: "" };
    const pump = () => {
      for (;;) {
        if (inData) {
          const end = inbuf.indexOf("\r\n.\r\n"); if (end < 0) return;
          cur.data = inbuf.slice(0, end); inbuf = inbuf.slice(end + 5); inData = false;
          sent.push(cur); cur = { from: "", rcpt: "", data: "" }; out += "250 queued\r\n"; continue;
        }
        const i = inbuf.indexOf("\r\n"); if (i < 0) return;
        const line = inbuf.slice(0, i); inbuf = inbuf.slice(i + 2);
        if (line.startsWith("EHLO")) out += "250-fake\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n";   // R32 SRV-1: port 587 upgrades first
        else if (line === "STARTTLS") out += "220 go ahead\r\n";
        else if (line.startsWith("AUTH")) out += "235 ok\r\n";
        else if (line.startsWith("MAIL FROM:")) { cur.from = line.slice(10); out += "250 ok\r\n"; }
        else if (line.startsWith("RCPT TO:")) { cur.rcpt = line.slice(8); out += "250 ok\r\n"; }
        else if (line === "DATA") { out += "354 go\r\n"; inData = true; }
        else if (line === "QUIT") out += "221 bye\r\n";
      }
    };
    return {
      read: (buf: Uint8Array) => { const b = enc.encode(out); out = ""; buf.set(b.subarray(0, buf.length)); return Promise.resolve(b.length ? Math.min(b.length, buf.length) : null); },
      write: (d: Uint8Array) => { inbuf += dec.decode(d); pump(); return Promise.resolve(d.length); },
      close: () => {},
    };
  };
  (Deno as any).connect = (o: any) => Promise.resolve(fake(o));
  (Deno as any).connectTls = (o: any) => Promise.resolve(fake(o));
  (Deno as any).startTls = (conn: any) => Promise.resolve(conn);   // the in-memory fake is already "secure"
  return { sent, connects, restore: () => { (Deno as any).connect = orig; (Deno as any).connectTls = origTls; (Deno as any).startTls = origStart; } };
}
// decode the base64 text/plain part (+ the raw headers) of a fake-server message
function partsOf(raw: string): { headers: string; text: string; html: string } {
  const [headers] = raw.split("\r\n\r\n");
  const b64s = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--|$)/g)].map((m) => m[1].replace(/\r\n/g, ""));
  const d = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s || ""), (c) => c.charCodeAt(0)));
  return { headers, text: d(b64s[0]), html: d(b64s[1] || "") };
}

const ROWS = [
  { id: ID1, purpose: "invite_site", channel: "email", to: "client@example.com",
    payload: { body: "Hi Asha, here is your invitation website:", link_path: "i/asha-rahul", studio: "Sparkle Events" } },
  { id: ID2, purpose: "booklet_link", channel: "email", to: "client@example.com",
    payload: { body: "Hi Asha, here is your event booklet from Sparkle Events:", link_path: "booklet?t=" + BOOKLET_TOKEN, valid_until: "7 Nov 2026", studio: "Sparkle Events" } },
  { id: ID3, purpose: "follow_up", channel: "email", to: "lead@example.com",
    payload: { subject: "Following up", text: "Just checking in about your event.", studio: "Sparkle Events" } },
];
function wireDb(rows = ROWS) {
  resetSupaMock();
  const marks: Record<string, string> = {};
  g.__supaRpc = (name: string, args: any) => {
    if (name === "comms_outbox_claim") return { data: rows, error: null };
    if (name === "comms_outbox_email_identity") return { data: { from_name: "Sparkle Weddings", reply_to: "hello@sparkle.in" }, error: null };
    if (name === "comms_outbox_unsub") return { data: { ok: true, opted_out: false, token: TOKEN }, error: null };
    if (name === "comms_outbox_mark") { marks[args.p_id] = args.p_status; return { data: null, error: null }; }
    return { data: [], error: null };
  };
  return marks;
}
const run = async (env: Record<string, string>) => {
  const r = setEnv({ ...BASE, ...env });
  try {
    const h = await loadHandler(FN);
    const { result, logs } = await captureConsoleError(async () => await h(new Request("https://fn.local/", { method: "POST", headers: { "x-helm-cron-secret": CRON } })));
    return { out: await result.json(), logs };
  } finally { r(); }
};

Deno.test("transport choice: SMTP when its 3 secrets are set, else Resend key, else none", async () => {
  const origServe = (Deno as any).serve;
  (Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown() {}, ref() {}, unref() {} });
  const r = setEnv(BASE);
  try {
    const m: any = await import(FN + "?v=" + crypto.randomUUID());
    const e = (o: Record<string, string>) => (k: string) => o[k];
    assertEquals(m.emailTransport(e({ ...SMTP })), "smtp");
    assertEquals(m.emailTransport(e({ ...SMTP, ...RESEND })), "smtp");
    assertEquals(m.emailTransport(e({ ...RESEND })), "resend");
    assertEquals(m.emailTransport(e({ SMTP_HOST: "smtp.gmail.com", SMTP_USER: "u@gmail.com", ...RESEND })), "resend");   // no password -> not SMTP
    assertEquals(m.emailTransport(e({})), null);
  } finally { (Deno as any).serve = origServe; r(); }
  // shared mailer: prefer=smtp only changes the order for callers that ask; default order kept
  const both = (k: string) => ({ ...SMTP, ...RESEND } as any)[k];
  assertEquals(mailConfig(both).provider, "resend");
  assertEquals(mailConfig(both, "smtp").provider, "smtp");
  assertEquals(mailConfig((k: string) => (RESEND as any)[k], "smtp").provider, "resend");
});

Deno.test("sendEmailSmtp: footer + List-Unsubscribe passed, brand mode, Helm's own mail, failures", async () => {
  const origServe = (Deno as any).serve;
  (Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown() {}, ref() {}, unref() {} });
  const r = setEnv(BASE);
  try {
    const m: any = await import(FN + "?v=" + crypto.randomUUID());
    const env = (o: Record<string, string>) => (k: string) => ({ ...BASE, ...SMTP, ...o } as any)[k];
    const extra = { footer: { text: "-- footer text Unsubscribe", html: "<p>footer html Unsubscribe</p>" }, headers: { "List-Unsubscribe": "<https://x.example/u>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
    let got: any = null;
    const smtp = async (cfg: any, mail: any) => { got = { cfg, mail }; };
    assertEquals(await m.sendEmailSmtp("c@example.com", "Hi", "line1\nline2 <b>", "Sparkle", { from_name: "Sparkle Weddings", reply_to: "Hello@Sparkle.in" }, extra, { env: env({}), smtp }), "sent");
    assertEquals(got.mail.from, '"Helm Events" <owner@gmail.com>');                    // EMAIL_BRAND_MODE default helm
    assertEquals(got.mail.replyTo, "hello@sparkle.in");
    assertEquals(got.mail.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assert(got.mail.text.startsWith("line1\nline2 <b>") && got.mail.text.includes("footer text Unsubscribe"));
    assert(got.mail.html.includes("line1<br>line2 &lt;b&gt;") && got.mail.html.includes("footer html Unsubscribe"));
    assertEquals(got.cfg.host, "smtp.gmail.com");
    await m.sendEmailSmtp("c@example.com", "Hi", "t", "Sparkle", { from_name: "Sparkle Weddings" }, extra, { env: env({ EMAIL_BRAND_MODE: "studio" }), smtp });
    assertEquals(got.mail.from, '"Sparkle Weddings" <owner@gmail.com>');               // studio's own sender name (0150)
    await m.sendEmailSmtp("c@example.com", "Hi", "t", "Sparkle", {}, extra, { env: env({ EMAIL_BRAND_MODE: "studio" }), smtp });
    assertEquals(got.mail.from, '"Sparkle via Helm Events" <owner@gmail.com>');
    await m.sendEmailSmtp("c@example.com", "Hi", "t", "Helm", {}, { footer: extra.footer }, { env: env({ EMAIL_BRAND_MODE: "studio" }), smtp });
    assertEquals(got.mail.from, '"Helm Events" <owner@gmail.com>');                    // Helm's own trial mail
    assertEquals(got.mail.headers, undefined);                                          // transactional: no unsubscribe headers
    await m.sendEmailSmtp("c@example.com", "Hi", "t", "S", { from_name: 'Evil"\r\nBcc: x@y.com' }, extra, { env: env({ EMAIL_BRAND_MODE: "studio" }), smtp });
    assert(!/[\r\n]/.test(got.mail.from) && !got.mail.from.includes('Evil"'));
    const { result, logs } = await captureConsoleError(async () =>
      await m.sendEmailSmtp("c@example.com", "Hi", "t", "S", {}, extra, { env: env({}), smtp: async () => { throw new Error("535 bad gmail-app-pass"); } }));
    assertEquals(result, "failed");                                                     // -> row retried later
    assert(!logs.join(" ").includes("gmail-app-pass") && !logs.join(" ").includes("c@example.com"));
    assertEquals(await m.sendEmailSmtp("c@example.com", "Hi", "t", "S", {}, extra, { env: (k: string) => (BASE as any)[k], smtp }), "skipped");
  } finally { (Deno as any).serve = origServe; r(); }
});

Deno.test("handler, SMTP only: invite_site + booklet_link + follow_up go out over SMTP, Resend never called", async () => {
  const marks = wireDb();
  const smtp = installFakeSmtp();
  const f = installFetch((url) => { throw new Error("unexpected fetch " + url); });
  try {
    const { out, logs } = await run({ ...SMTP });
    assertEquals(out.sent, 3); assertEquals(out.failed, 0);
    assertEquals(fetchLog().length, 0);
    assertEquals(marks[ID1], "sent"); assertEquals(marks[ID2], "sent"); assertEquals(marks[ID3], "sent");
    assertEquals(smtp.connects[0], { hostname: "smtp.gmail.com", port: 587 });
    assertEquals(smtp.sent.length, 3);
    assertEquals(smtp.sent[0].from, "<owner@gmail.com>"); assertEquals(smtp.sent[0].rcpt, "<client@example.com>");
    const inv = partsOf(smtp.sent[0].data), bk = partsOf(smtp.sent[1].data), fu = partsOf(smtp.sent[2].data);
    assert(inv.text.includes("Hi Asha, here is your invitation website: https://www.helm.events/i/asha-rahul"));
    assert(inv.text.includes("You received this because"), "transactional footer on the invitation link");
    assert(!/List-Unsubscribe/.test(inv.headers), "client link mail is transactional");
    assert(/Reply-To: <hello@sparkle\.in>/.test(inv.headers));
    assert(bk.text.includes("https://www.helm.events/booklet?t=" + BOOKLET_TOKEN + " (valid until 7 Nov 2026)"));
    assert(bk.text.includes("You received this because"));
    // 0165: follow-up is non-transactional -> visible Unsubscribe + RFC 8058 headers on SMTP too
    assert(fu.html.includes("https://www.helm.events/unsubscribe?t=" + TOKEN));
    assert(/List-Unsubscribe: .*https:\/\/proj\.supabase\.co\/functions\/v1\/email-unsubscribe\?t=/.test(fu.headers));
    assert(/List-Unsubscribe-Post: List-Unsubscribe=One-Click/.test(fu.headers));
    const all = logs.join(" ");
    assert(!all.includes("client@example.com") && !all.includes("gmail-app-pass"));
  } finally { f(); smtp.restore(); }
});

Deno.test("handler, SMTP + Resend both set: SMTP wins, no Resend call", async () => {
  wireDb([ROWS[0]]);
  const smtp = installFakeSmtp();
  const f = installFetch((url) => { throw new Error("unexpected fetch " + url); });
  try {
    const { out } = await run({ ...SMTP, ...RESEND });
    assertEquals(out.sent, 1);
    assertEquals(smtp.sent.length, 1);
    assertEquals(fetchLog().length, 0);
  } finally { f(); smtp.restore(); }
});

Deno.test("handler, Resend only: falls back to Resend with idempotency key + headers; no SMTP connect", async () => {
  const marks = wireDb([ROWS[0], ROWS[2]]);
  const smtp = installFakeSmtp();
  const f = installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ id: "e1" }); throw new Error("unexpected " + url); });
  try {
    const { out } = await run({ ...RESEND });
    assertEquals(out.sent, 2);
    assertEquals(smtp.connects.length, 0);
    assertEquals(fetchLog().length, 2);
    assertEquals((fetchLog()[0].init?.headers as any)["Idempotency-Key"], "comms-" + ID1);
    const fu = JSON.parse(String(fetchLog()[1].init?.body));
    assertEquals(fu.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
    assertEquals(marks[ID3], "sent");
  } finally { f(); smtp.restore(); }
});

Deno.test("handler, no e-mail secrets: rows skipped, nothing sent", async () => {
  const marks = wireDb();
  const smtp = installFakeSmtp();
  const f = installFetch((url) => { throw new Error("unexpected fetch " + url); });
  try {
    const { out } = await run({});
    assertEquals(out.sent, 0); assertEquals(out.skipped, 3);
    assertEquals(smtp.connects.length, 0); assertEquals(fetchLog().length, 0);
    assertEquals(marks[ID1], "skipped");
  } finally { f(); smtp.restore(); }
});

Deno.test("handler, opted-out follow-up is skipped on SMTP too (0165 fail closed)", async () => {
  const marks = wireDb([ROWS[2]]);
  const prev = g.__supaRpc;
  g.__supaRpc = (n: string, a: any) => n === "comms_outbox_unsub" ? { data: { ok: true, opted_out: true, token: TOKEN }, error: null } : prev(n, a);
  const smtp = installFakeSmtp();
  const f = installFetch((url) => { throw new Error("unexpected fetch " + url); });
  try {
    const { out } = await run({ ...SMTP });
    assertEquals(out.skipped, 1); assertEquals(smtp.sent.length, 0);
    assertEquals(marks[ID3], "skipped");
  } finally { f(); smtp.restore(); }
});
