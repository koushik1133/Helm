// Deno tests for the built-in SMTP client against a fake local SMTP server (no real sends).
// Run: deno test --allow-net supabase/functions/_shared/smtp_test.ts
import { assert, assertEquals, assertMatch, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { buildMessage, encodeWord, smtpReason, smtpSend, SmtpError } from "./smtp.ts";
import { sendMail } from "./mailer.ts";

type Script = { auth?: string; rcpt?: string; data?: string };
async function fakeServer(script: Script = {}) {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (l.addr as Deno.NetAddr).port; const log: string[] = []; let message = "";
  const done = (async () => {
    const c = await l.accept(); const e = new TextEncoder(), d = new TextDecoder();
    const say = (s: string) => c.write(e.encode(s + "\r\n"));
    await say("220-fake ready"); await say("220 fake");
    let buf = "", inData = false; const chunk = new Uint8Array(65536);
    outer: for (;;) {
      const n = await c.read(chunk); if (n === null) break; buf += d.decode(chunk.subarray(0, n));
      let i: number;
      while (true) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n"); if (end < 0) break;
          message = buf.slice(0, end); buf = buf.slice(end + 5); inData = false;
          await say(script.data || "250 ok queued"); continue;
        }
        if ((i = buf.indexOf("\r\n")) < 0) break;
        const line = buf.slice(0, i); buf = buf.slice(i + 2); log.push(line);
        if (line.startsWith("EHLO")) { await say("250-fake"); await say("250 AUTH PLAIN LOGIN"); }
        else if (line.startsWith("AUTH")) await say(script.auth || "235 ok");
        else if (line.startsWith("MAIL")) await say("250 ok");
        else if (line.startsWith("RCPT")) await say(script.rcpt || "250 ok");
        else if (line === "DATA") { await say("354 go"); inData = true; }
        else if (line === "QUIT") { await say("221 bye"); break outer; }
      }
    }
    try { c.close(); } catch (_) { /* */ } l.close();
  })();
  return { cfg: { host: "127.0.0.1", port, user: "notifications@helm.events", pass: "app-pass-xyz", tls: false }, log, done, get message() { return message; } };
}
const mail = { from: '"Studio · Ø via Helm" <notifications@helm.events>', to: "client@example.com", subject: "Your booklet · Helm", text: "Hi · footer", html: "<p>Hi · footer</p>", replyTo: "studio@example.com", headers: { "List-Unsubscribe": "<mailto:u@helm.events>", "Bad Header": "x" } };

Deno.test("sends via fake server; base64 bodies, RFC 2047 headers", async () => {
  const s = await fakeServer();
  await smtpSend(s.cfg, mail); await s.done;
  assertEquals(s.log[0], "EHLO helm.events");
  assertMatch(s.log[1], /^AUTH PLAIN /);
  assertEquals(s.log[2], "MAIL FROM:<notifications@helm.events>");
  assertEquals(s.log[3], "RCPT TO:<client@example.com>");
  const m = s.message;
  assertStringIncludes(m, "Subject: =?UTF-8?B?");
  assertMatch(m, /From: =\?UTF-8\?B\?[^?]+\?= <notifications@helm\.events>/);
  assertStringIncludes(m, "List-Unsubscribe: <mailto:u@helm.events>");
  assert(!m.includes("Bad Header"));
  assertStringIncludes(m, "Content-Transfer-Encoding: base64");
  assert(/^[\x00-\x7f]*$/.test(m), "wire message is pure ASCII");
});
Deno.test("auth rejection -> stage auth, code 535, password not in message", async () => {
  const s = await fakeServer({ auth: "535-5.7.8 Username and Password not accepted" + "\r\n535 5.7.8 BadCredentials" });
  const e = await smtpSend(s.cfg, mail).then(() => null, (x) => x); await s.done.catch(() => {});
  assert(e instanceof SmtpError); assertEquals(e.stage, "auth"); assertEquals(e.code, 535);
  assert(!e.message.includes("app-pass-xyz")); assertMatch(smtpReason(e), /login rejected/);
});
Deno.test("recipient rejection -> rcpt reason", async () => {
  const s = await fakeServer({ rcpt: "550 no such user" });
  const e = await smtpSend(s.cfg, mail).then(() => null, (x) => x); await s.done.catch(() => {});
  assertEquals(e.stage, "rcpt"); assertMatch(smtpReason(e), /recipient/);
});
Deno.test("connect failure -> could not connect", async () => {
  const l = Deno.listen({ hostname: "127.0.0.1", port: 0 }); const port = (l.addr as Deno.NetAddr).port; l.close();
  const e = await smtpSend({ host: "127.0.0.1", port, user: "u", pass: "p", tls: false }, mail).then(() => null, (x) => x);
  assertEquals(e.stage, "connect"); assertMatch(smtpReason(e), /could not connect/);
});
Deno.test("sendMail returns precise reason + safe log", async () => {
  const s = await fakeServer({ auth: "535 bad" });
  const env = (k: string) => ({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(s.cfg.port), SMTP_USER: "notifications@helm.events", SMTP_PASS: "app-pass-xyz" } as Record<string, string>)[k];
  const logs: string[] = []; const orig = console.error; console.error = (...a: unknown[]) => logs.push(a.join(" "));
  try {
    const r = await sendMail({ to: "client@example.com", subject: "S", text: "T", studio: "Studio" }, { env });
    assertEquals(r.status, "failed"); assertMatch(r.reason!, /login rejected/);
  } finally { console.error = orig; } await s.done.catch(() => {});
  assert(logs.join("").includes('"stage":"auth"')); assert(!logs.join("").includes("app-pass-xyz")); assert(!logs.join("").includes("client@example.com"));
});
Deno.test("encodeWord keeps ASCII as-is", () => {
  assertEquals(encodeWord("Hello"), "Hello"); assertMatch(encodeWord("a·b"), /^=\?UTF-8\?B\?/);
  assertMatch(buildMessage({ from: "a@b.co", to: "c@d.co", subject: "x", text: "y" }), /Content-Type: text\/plain; charset=UTF-8/);
});
