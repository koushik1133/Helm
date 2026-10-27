// R32 SRV-1: on any port other than 465 the SMTP client must upgrade with STARTTLS before it
// sends the login (AUTH PLAIN = base64 of the password). No STARTTLS offered -> no login at all.
// In-memory fake server (no network). Port 465 (implicit TLS, Gmail today) is unchanged.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { smtpReason, smtpSend, SmtpError } from "../../supabase/functions/_shared/smtp.ts";
import { mailConfig } from "../../supabase/functions/_shared/mailer.ts";

type Opts = { starttls?: boolean; starttlsReply?: string; pad?: number };
function fakeConn(o: Opts, log: string[], tag: { tls: boolean }) {
  const e = new TextEncoder(), d = new TextDecoder();
  let out = "220 fake ESMTP\r\n", buf = "", inData = false, closed = false;
  let wake: (() => void) | null = null;
  const say = (s: string) => { out += s + "\r\n"; if (wake) { const w = wake; wake = null; w(); } };
  const conn = {
    async write(p: Uint8Array) {
      buf += d.decode(p);
      for (;;) {
        if (inData) { const end = buf.indexOf("\r\n.\r\n"); if (end < 0) break; buf = buf.slice(end + 5); inData = false; say("250 queued"); continue; }
        const i = buf.indexOf("\r\n"); if (i < 0) break;
        const line = buf.slice(0, i); buf = buf.slice(i + 2); log.push((tag.tls ? "[tls] " : "[plain] ") + line);
        if (line.startsWith("EHLO")) { say("250-fake"); for (let k = 0; k < (o.pad || 0); k++) say("250-X-EXTENSION-" + k + " SOME LONG CAPABILITY TEXT"); say(o.starttls && !tag.tls ? "250-STARTTLS" : "250-SIZE 1000"); say("250 AUTH PLAIN LOGIN"); }
        else if (line === "STARTTLS") say(o.starttlsReply || "220 go ahead");
        else if (line.startsWith("AUTH")) say("235 ok");
        else if (line.startsWith("MAIL") || line.startsWith("RCPT")) say("250 ok");
        else if (line === "DATA") { say("354 go"); inData = true; }
        else if (line === "QUIT") say("221 bye");
      }
      return p.length;
    },
    async read(p: Uint8Array): Promise<number | null> {
      while (!out) { if (closed) return null; await new Promise<void>((r) => { wake = r; }); }
      const b = e.encode(out); const n = Math.min(b.length, p.length); p.set(b.subarray(0, n)); out = d.decode(b.subarray(n)); return n;
    },
    close() { closed = true; if (wake) wake(); },
  };
  return conn as unknown as Deno.Conn;
}
const mail = { from: "notifications@helm.events", to: "client@example.com", subject: "S", text: "T" };
const cfg = (host: string, port = 587) => ({ host, port, user: "u@example.com", pass: "app-pass-SECRET", tls: false });

Deno.test("SRV-1: port 587 + STARTTLS offered -> upgrade first, AUTH only on the secure connection", async () => {
  const log: string[] = []; const tag = { tls: false };
  await smtpSend(cfg("smtp.example.com"), mail, { connect: async () => fakeConn({ starttls: true }, log, tag), startTls: async (c) => { tag.tls = true; return c; } });
  assertEquals(log.slice(0, 4), ["[plain] EHLO helm.events", "[plain] STARTTLS", "[tls] EHLO helm.events", log[3]]);
  assertMatch(log[3], /^\[tls\] AUTH PLAIN /);
  assert(!log.some((l) => l.startsWith("[plain] AUTH")), "no AUTH over the plain connection");
});

Deno.test("SRV-1: port 587 and NO STARTTLS -> refuses to send the login (stage tls)", async () => {
  const log: string[] = []; const tag = { tls: false };
  const err = await smtpSend(cfg("smtp.example.com"), mail, { connect: async () => fakeConn({ starttls: false }, log, tag) }).then(() => null, (x) => x);
  assert(err instanceof SmtpError); assertEquals(err.stage, "tls");
  assert(!log.some((l) => l.includes("AUTH")), "AUTH never sent: " + JSON.stringify(log));
  assert(!String(err.message).includes("app-pass-SECRET"));
  assertMatch(smtpReason(err), /secure connection/);
});

Deno.test("SRV-1: STARTTLS refused by the server -> no AUTH", async () => {
  const log: string[] = []; const tag = { tls: false };
  const err = await smtpSend(cfg("smtp.example.com"), mail, { connect: async () => fakeConn({ starttls: true, starttlsReply: "454 TLS not available" }, log, tag) }).then(() => null, (x) => x);
  assert(err instanceof SmtpError); assertEquals(err.stage, "tls");
  assert(!log.some((l) => l.includes("AUTH")));
});

Deno.test("SRV-1: TLS handshake failure -> no AUTH", async () => {
  const log: string[] = []; const tag = { tls: false };
  const err = await smtpSend(cfg("smtp.example.com"), mail, { connect: async () => fakeConn({ starttls: true }, log, tag), startTls: async () => { throw new Error("bad cert"); } }).then(() => null, (x) => x);
  assert(err instanceof SmtpError); assertEquals(err.stage, "tls");
  assert(!log.some((l) => l.includes("AUTH")));
});

Deno.test("SRV-1: port 465 (Gmail today) unchanged - implicit TLS, no STARTTLS step", async () => {
  assertEquals(mailConfig((k) => ({ SMTP_HOST: "smtp.gmail.com", SMTP_USER: "u@gmail.com", SMTP_PASS: "p" } as Record<string, string>)[k]).smtp!.tls, true);
  const log: string[] = []; const tag = { tls: true };
  await smtpSend({ ...cfg("smtp.gmail.com", 465), tls: true }, mail, { connect: async () => fakeConn({ starttls: false }, log, tag) });
  assertEquals(log[0], "[tls] EHLO helm.events");
  assertMatch(log[1], /^\[tls\] AUTH PLAIN /);
  assert(!log.some((l) => l.includes("STARTTLS")));
});

// R32b R2-INJ-03: a long EHLO (real providers list 10+ capabilities) with STARTTLS after the first 300 characters
Deno.test("R32b R2-INJ-03: STARTTLS listed late in a long EHLO is still found (upgrade, then AUTH inside TLS)", async () => {
  const log: string[] = []; const tag = { tls: false };
  const err = await smtpSend(cfg("smtp.example.com"), mail, { connect: async () => fakeConn({ starttls: true, pad: 14 }, log, tag), startTls: async (c) => { tag.tls = true; return c; } }).then(() => null, (x) => x);
  assertEquals(err, null, "sent: " + (err && err.stage));
  assertEquals(log[1], "[plain] STARTTLS");
  assert(log.some((l) => l.startsWith("[tls] AUTH")) && !log.some((l) => l.startsWith("[plain] AUTH")));
});

// R32b SRV-1 info: a certificate failure surfaces during the handshake - it must be reported as stage "tls", not "ehlo"
Deno.test("R32b SRV-1: a TLS handshake (certificate) failure after STARTTLS -> stage tls, no AUTH", async () => {
  const log: string[] = []; const tag = { tls: false };
  const err = await smtpSend(cfg("smtp.example.com"), mail, {
    connect: async () => fakeConn({ starttls: true }, log, tag),
    startTls: async (c) => { tag.tls = true; return Object.assign(Object.create(c as object), { read: (p: Uint8Array) => c.read(p), write: (p: Uint8Array) => c.write(p), close: () => c.close(),
      handshake: () => Promise.reject(new Error("invalid peer certificate: UnknownIssuer")) }) as Deno.Conn; },
  }).then(() => null, (x) => x);
  assert(err instanceof SmtpError, "must fail"); assertEquals(err.stage, "tls");
  assertMatch(smtpReason(err), /secure connection/);
  assert(!log.some((l) => l.includes("AUTH")) && !log.some((l) => l.startsWith("[tls] EHLO")), JSON.stringify(log));
});
