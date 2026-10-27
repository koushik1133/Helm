// Minimal SMTP client (implicit TLS on 465; any other port must upgrade with STARTTLS before AUTH -
// R32 SRV-1: the password is never sent over a plain connection, except to a loopback test server).
// Replaces denomailer@1.6.0, whose header/body encoding (quoted-printable bugs with non-ASCII
// like the "·" in our footer, unencoded custom headers) and opaque errors made Gmail failures
// undiagnosable. Bodies are base64 UTF-8; non-ASCII headers are RFC 2047 encoded.
// Errors carry a stage + SMTP reply code; the password is never logged or echoed.

export type SmtpStage = "connect" | "greeting" | "ehlo" | "tls" | "auth" | "mail_from" | "rcpt" | "data" | "send";
export class SmtpError extends Error {
  stage: SmtpStage; code: number | null;
  constructor(stage: SmtpStage, message: string, code: number | null = null) {
    super(message); this.name = "SmtpError"; this.stage = stage; this.code = code;
  }
}
export type SmtpConn = { cfg: { host: string; port: number; user: string; pass: string; tls: boolean } };
export type RawMail = { from: string; to: string; subject: string; text: string; html?: string; replyTo?: string; headers?: Record<string, string> };
type Conn = Deno.Conn;

const enc = new TextEncoder(), dec = new TextDecoder();
const isAscii = (s: string) => /^[\x20-\x7e]*$/.test(s);
const b64 = (s: string) => {
  const bytes = enc.encode(s); let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
};
const wrap76 = (s: string) => s.replace(/(.{76})/g, "$1\r\n");
const oneLine = (s: unknown) => String(s ?? "").replace(/[\r\n]+/g, " ").trim();

// RFC 2047 encoded-word (B) for non-ASCII header text
export function encodeWord(s: string): string {
  s = oneLine(s);
  return isAscii(s) ? s : "=?UTF-8?B?" + b64(s) + "?=";
}
// '"Name" <addr>' or 'Name <addr>' or 'addr' -> { name, addr }
export function parseAddr(s: string): { name: string; addr: string } {
  const m = /^\s*"?([^"<]*?)"?\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(s);
  return m ? { name: m[1].trim(), addr: m[2] } : { name: "", addr: s.trim() };
}
export function formatAddr(s: string): string {
  const { name, addr } = parseAddr(s);
  if (!name) return "<" + addr + ">";
  return (isAscii(name) ? '"' + name.replace(/["\\]/g, "") + '"' : encodeWord(name)) + " <" + addr + ">";
}

export function buildMessage(m: RawMail, opts: { date?: Date; boundary?: string; msgId?: string } = {}): string {
  const from = parseAddr(m.from);
  const boundary = opts.boundary || "helm-" + crypto.randomUUID();
  const domain = from.addr.split("@")[1] || "localhost";
  const h: string[] = [
    "From: " + formatAddr(m.from),
    "To: <" + parseAddr(m.to).addr + ">",
    "Subject: " + encodeWord(m.subject),
    "Date: " + (opts.date || new Date()).toUTCString().replace("GMT", "+0000"),
    "Message-ID: <" + (opts.msgId || crypto.randomUUID()) + "@" + domain + ">",
    "MIME-Version: 1.0",
  ];
  if (m.replyTo) h.push("Reply-To: <" + parseAddr(m.replyTo).addr + ">");
  for (const [k, v] of Object.entries(m.headers || {})) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(k)) continue; // drop malformed header names
    const val = oneLine(v); if (!val) continue;
    h.push(k + ": " + (isAscii(val) ? val : encodeWord(val)));
  }
  const part = (type: string, body: string) =>
    "Content-Type: " + type + "; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + wrap76(b64(body));
  let body: string;
  if (m.html) {
    h.push('Content-Type: multipart/alternative; boundary="' + boundary + '"');
    body = "--" + boundary + "\r\n" + part("text/plain", m.text) + "\r\n--" + boundary + "\r\n" +
      part("text/html", m.html) + "\r\n--" + boundary + "--";
  } else {
    h.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64");
    body = wrap76(b64(m.text));
  }
  // dot-stuffing (base64 lines never start with ".", but be safe)
  return (h.join("\r\n") + "\r\n\r\n" + body).replace(/\r\n\./g, "\r\n..");
}

class Reader {
  buf = ""; constructor(private c: Conn) {}
  // R32b (R2-INJ-03): every reply line is kept (lines[]); text is the short version for error messages
  async reply(stage: SmtpStage, timeoutMs: number): Promise<{ code: number; text: string; lines: string[] }> {
    const deadline = Date.now() + timeoutMs; const lines: string[] = [];
    for (;;) {
      let i: number;
      while ((i = this.buf.indexOf("\r\n")) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 2); lines.push(line);
        if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) return { code: Number(line.slice(0, 3)), text: lines.join(" | ").slice(0, 300), lines };
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new SmtpError(stage, "timed out waiting for the server");
      const chunk = new Uint8Array(4096);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const n = await Promise.race([
        this.c.read(chunk),
        new Promise<"t">((r) => { timer = setTimeout(() => r("t"), left); }),
      ]).finally(() => clearTimeout(timer));
      if (n === "t") throw new SmtpError(stage, "timed out waiting for the server");
      if (n === null) throw new SmtpError(stage, "connection closed by server");
      this.buf += dec.decode(chunk.subarray(0, n));
    }
  }
}

async function writeAll(c: Conn, s: string) {
  const data = enc.encode(s); let off = 0;
  while (off < data.length) off += await c.write(data.subarray(off));
}

// R32 SRV-1: a plain (non-465) connection may skip STARTTLS only when the server is this machine
// (local fake servers in tests); everywhere else no STARTTLS = no login.
const isLoopback = (h: string) => /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|::1|\[::1\])$/i.test(String(h || "").trim());
export async function smtpSend(cfg: SmtpConn["cfg"], mail: RawMail, opts: { timeoutMs?: number; connect?: () => Promise<Conn>; startTls?: (c: Conn, host: string) => Promise<Conn> } = {}): Promise<void> {
  const T = opts.timeoutMs ?? 15000;
  let conn: Conn;
  try {
    conn = opts.connect ? await opts.connect()
      : cfg.tls ? await Deno.connectTls({ hostname: cfg.host, port: cfg.port })
      : await Deno.connect({ hostname: cfg.host, port: cfg.port });
  } catch (e) {
    throw new SmtpError("connect", (e as Error)?.name + ": " + String((e as Error)?.message || e).slice(0, 200));
  }
  let r = new Reader(conn);
  const cmd = async (stage: SmtpStage, line: string, ok: number[], shown?: string) => {
    try { await writeAll(conn, line + "\r\n"); } catch (e) { throw new SmtpError(stage, "write failed: " + String((e as Error)?.message || e).slice(0, 200)); }
    const rep = await r.reply(stage, T);
    if (!ok.includes(rep.code)) throw new SmtpError(stage, (shown || stage) + " -> " + rep.text, rep.code);
    return rep;
  };
  try {
    const g = await r.reply("greeting", T);
    if (g.code !== 220) throw new SmtpError("greeting", g.text, g.code);
    const hello = await cmd("ehlo", "EHLO helm.events", [250], "EHLO");
    if (!cfg.tls) {
      // R32 SRV-1: STARTTLS (RFC 3207) before AUTH on any non-implicit-TLS port
      // R32b (R2-INJ-03): look at EVERY EHLO line, not a 300-character summary (a long EHLO lists STARTTLS late)
      const offers = hello.lines.some((l) => /^250[- ]STARTTLS\b/i.test(l));
      if (offers) {
        await cmd("tls", "STARTTLS", [220], "STARTTLS");
        try {
          conn = opts.startTls ? await opts.startTls(conn, cfg.host)
            : await Deno.startTls(conn as Deno.TcpConn, { hostname: cfg.host });
          // R32b (SRV-1 info): finish the TLS handshake HERE so a bad certificate is reported as stage "tls"
          // (Deno otherwise handshakes lazily on the first write - the EHLO - and it would read as "ehlo")
          const hs = (conn as Deno.TlsConn).handshake;
          if (typeof hs === "function") await hs.call(conn);
        } catch (e) {
          throw new SmtpError("tls", "secure upgrade failed: " + String((e as Error)?.message || e).slice(0, 200));
        }
        r = new Reader(conn);
        await cmd("ehlo", "EHLO helm.events", [250], "EHLO");
      } else if (!isLoopback(cfg.host)) {
        throw new SmtpError("tls", "the server does not offer STARTTLS - refusing to send the login over a plain connection");
      }
    }
    const auth = b64("\0" + cfg.user + "\0" + cfg.pass);
    await cmd("auth", "AUTH PLAIN " + auth, [235], "AUTH PLAIN [redacted]");
    await cmd("mail_from", "MAIL FROM:<" + parseAddr(mail.from).addr + ">", [250]);
    await cmd("rcpt", "RCPT TO:<" + parseAddr(mail.to).addr + ">", [250, 251]);
    await cmd("data", "DATA", [354]);
    await cmd("send", buildMessage(mail) + "\r\n.", [250], "message body");
    try { await writeAll(conn, "QUIT\r\n"); await r.reply("send", 3000); } catch (_) { /* sent already */ }
  } finally {
    try { conn.close(); } catch (_) { /* ignore */ }
  }
}

// Plain-words reason for the UI from an SMTP failure.
export function smtpReason(e: unknown): string {
  const err = e as SmtpError; const code = err?.code ?? null;
  switch (err?.stage) {
    case "connect": return "could not connect to the mail server (check SMTP_HOST / SMTP_PORT; use 465)";
    case "greeting": case "ehlo": return "the mail server did not accept the connection";
    case "tls": return "the mail server did not offer a secure connection (use SMTP_PORT 465, or a server with STARTTLS)";
    case "auth": return code === 535 || code === 534
      ? "login rejected (check SMTP_USER and the app password)"
      : "login failed at the mail server (check SMTP_USER and the app password)";
    case "mail_from": return "the mail server rejected the sender address (SMTP_FROM must be the login or an allowed alias)";
    case "rcpt": return "the mail server rejected the recipient address";
    case "data": case "send": return code && code >= 500
      ? "the mail server refused the message content"
      : "the mail server temporarily refused the message - try again shortly";
    default: return "the mail server refused the message - check the SMTP settings";
  }
}
