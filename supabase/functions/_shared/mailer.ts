// Shared outbound e-mail for client-facing mail (client-mailer links, send-otp e-mail code).
//
// Provider order:
//   1. Resend  - RESEND_API_KEY + RESEND_FROM set
//   2. SMTP    - SMTP_HOST + SMTP_USER + SMTP_PASS set (SMTP_PORT default 465, SMTP_FROM default SMTP_USER)
//                (built-in client in ./smtp.ts; implicit TLS on 465 - Supabase blocks 25/587)
//                e.g. Gmail: smtp.gmail.com / 465 / you@gmail.com / an App Password
//   3. neither -> { status: "not_configured" } (nothing sent, never throws)
//
// Display name: "<Studio> via Helm" (the address is the configured sender, so SPF/DKIM pass);
// Reply-To: the studio's business e-mail when it is a valid address.
// Logs carry only the provider + status code, never the recipient, body or any code.
// Compliance: every message gets the transactional footer ("You received this because ... ·
// Privacy · Helm Events, <postal address>", reason = msg.txReason, default client_link). A
// non-transactional caller passes its own `footer` (with Unsubscribe) + List-Unsubscribe `headers`.
import { postalAddress, txFooter, withFooter } from "./email-compliance.mjs";
import { smtpReason, smtpSend } from "./smtp.ts";

export type MailMsg = {
  to: string; subject: string; text: string; html?: string;
  studio?: string | null; replyTo?: string | null;
  txReason?: string; footer?: { text: string; html: string }; headers?: Record<string, string>;
};
export type MailResult = { status: "sent" | "not_configured" | "failed"; provider?: "resend" | "smtp"; reason?: string };
export type SmtpSend = (cfg: SmtpCfg, mail: { from: string; to: string; subject: string; text: string; html?: string; replyTo?: string; headers?: Record<string, string> }) => Promise<void>;
export type SmtpCfg = { host: string; port: number; user: string; pass: string; tls: boolean };

export const EMAIL_RE = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

type EnvGet = (k: string) => string | undefined;
const envOf = (): EnvGet => (k) => Deno.env.get(k);

// strip anything that could break a header (CR/LF, quotes, angle brackets)
export function cleanName(s: unknown, max = 60): string {
  return String(s ?? "").replace(/[\r\n\t"<>\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
export function fromName(studio: unknown): string {
  const s = cleanName(studio);
  return s ? s + " via Helm" : "Helm";
}
// "Name <addr>" from a configured sender (which may already be "X <a@b>")
export function senderHeader(configured: string, studio: unknown): string {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(configured);
  const addr = (m ? m[1] : configured).trim();
  return `"${fromName(studio)}" <${addr}>`;
}

export function mailConfig(env: EnvGet = envOf()): { provider: "resend" | "smtp" | null; smtp?: SmtpCfg; from?: string } {
  const key = env("RESEND_API_KEY") || "", rfrom = env("RESEND_FROM") || "";
  if (key && rfrom) return { provider: "resend", from: rfrom };
  const host = env("SMTP_HOST") || "", user = env("SMTP_USER") || "", pass = env("SMTP_PASS") || "";
  if (host && user && pass) {
    const port = Number(env("SMTP_PORT") || "465") || 465;
    return { provider: "smtp", from: env("SMTP_FROM") || user, smtp: { host, port, user, pass, tls: port === 465 } };
  }
  return { provider: null };
}

// default SMTP sender: built-in minimal client (./smtp.ts). denomailer (v1.6.0) was dropped:
// its encoding of non-ASCII bodies/headers and opaque errors broke Gmail sends on Supabase Edge.
const builtinSmtp: SmtpSend = (cfg, mail) => smtpSend(cfg, mail);
export async function sendMail(msg: MailMsg, opts: { env?: EnvGet; smtp?: SmtpSend } = {}): Promise<MailResult> {
  const to = String(msg.to || "").trim();
  if (!EMAIL_RE.test(to)) return { status: "failed", reason: "no valid e-mail address on file" };
  const cfg = mailConfig(opts.env || envOf());
  if (!cfg.provider) return { status: "not_configured", reason: "e-mail sending is not set up yet" };
  const replyTo = msg.replyTo && EMAIL_RE.test(String(msg.replyTo).trim()) ? String(msg.replyTo).trim() : undefined;
  const subject = String(msg.subject || "").replace(/[\r\n]+/g, " ").slice(0, 200);
  const from = senderHeader(cfg.from!, msg.studio);
  const envGet = opts.env || envOf();
  const footer = msg.footer || txFooter(msg.txReason || "client_link", { app: envGet("APP_URL") || envGet("APP_ORIGIN"), address: postalAddress(envGet) });
  const body = withFooter({ text: msg.text, html: msg.html }, footer);
  const headers = msg.headers && Object.keys(msg.headers).length ? msg.headers : undefined;
  if (cfg.provider === "resend") {
    try {
      const env = opts.env || envOf();
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": "Bearer " + env("RESEND_API_KEY"), "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text: body.text, ...(body.html ? { html: body.html } : {}), ...(headers ? { headers } : {}), ...(replyTo ? { reply_to: replyTo } : {}) }),
      });
      await r.text();
      if (!r.ok) { console.error("mailer: resend status", r.status); return { status: "failed", provider: "resend", reason: "the e-mail provider refused the message" }; }
      return { status: "sent", provider: "resend" };
    } catch (_) { console.error("mailer: resend unreachable"); return { status: "failed", provider: "resend", reason: "the e-mail provider could not be reached" }; }
  }
  try {
    await (opts.smtp || builtinSmtp)(cfg.smtp!, { from, to, subject, text: body.text, html: body.html, replyTo, ...(headers ? { headers } : {}) });
    return { status: "sent", provider: "smtp" };
  } catch (e) {
    // safe diagnostic: stage, reply code, server text (never the password, recipient or body)
    const err = e as { name?: string; stage?: string; code?: number | null; message?: string };
    console.error("mailer: smtp send failed", JSON.stringify({
      name: err?.name || "Error", stage: err?.stage || "unknown", code: err?.code ?? null,
      message: String(err?.message || e).split(cfg.smtp!.pass).join("[redacted]").replace(/[^\s<>@]+@[^\s<>@]+/g, "[address]").slice(0, 300),
      host: cfg.smtp!.host, port: cfg.smtp!.port, tls: cfg.smtp!.tls,
    }));
    return { status: "failed", provider: "smtp", reason: smtpReason(e) };
  }
}
