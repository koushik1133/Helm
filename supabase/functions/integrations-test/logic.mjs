// logic.mjs - pure helpers for integrations-test (0150). No Deno, no network: imported by
// index.ts and by test/integrations-setup.test.mjs. Never reads or returns a secret VALUE,
// only whether one is set.

export const EMAIL_RE = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
export const PHONE_RE = /^[0-9]{8,15}$/;
const TPL_NAME = /^[a-z0-9_]{1,64}$/;

// Which channels can really send right now. Booleans only.
//   email:    RESEND_API_KEY set (else invite e-mails fall back to Supabase Auth mail and
//             client e-mails are skipped)
//   whatsapp: WHATSAPP_TOKEN + numeric WHATSAPP_PHONE_ID + an approved general template
//             (COMMS_WHATSAPP_TEMPLATE) or WHATSAPP_ALLOW_TEXT=1
export function channelStatus(env) {
  const g = (k) => String(env(k) || "").trim();
  const email = !!g("RESEND_API_KEY");
  const waCreds = !!g("WHATSAPP_TOKEN") && /^[0-9]{5,20}$/.test(g("WHATSAPP_PHONE_ID"));
  const waTpl = TPL_NAME.test(g("COMMS_WHATSAPP_TEMPLATE")) || g("WHATSAPP_ALLOW_TEXT") === "1";
  return {
    email: { live: email, sender: email ? senderAddress(g("RESEND_FROM")) : "" },
    whatsapp: { live: waCreds && waTpl, credentials: waCreds, template: waTpl, webhook: !!g("WHATSAPP_APP_SECRET") && !!g("WHATSAPP_WEBHOOK_VERIFY_TOKEN") },
  };
}

// the bare address out of RESEND_FROM ('Helm <hello@helm.events>' or 'hello@helm.events')
export function senderAddress(conf) {
  const c = String(conf || "").trim() || "onboarding@resend.dev";
  const m = c.match(/<([^>]+)>/);
  const a = (m ? m[1] : c).trim();
  return EMAIL_RE.test(a) ? a : "onboarding@resend.dev";
}

// '"<display name>" <address>' - display name from the studio setting, else the studio name
export function fromHeader(conf, fromName, studio) {
  const name = String(fromName || studio || "Helm").replace(/["<>\r\n]/g, "").trim().slice(0, 60) || "Helm";
  return `"${name}" <${senderAddress(conf)}>`;
}

export function replyToOf(v) {
  const r = String(v || "").trim().toLowerCase();
  return EMAIL_RE.test(r) ? r : "";
}

// "a***@example.com" - what the page shows; the full address is never echoed back
export function maskEmail(e) {
  const s = String(e || "");
  const i = s.indexOf("@");
  if (i < 1) return "";
  return s[0] + "***" + s.slice(i);
}
export function maskPhone(p) {
  const d = String(p || "").replace(/\D/g, "");
  return d.length >= 8 ? "+" + d.slice(0, 2) + "******" + d.slice(-2) : "";
}

export const TEST_TEXT = "This is a test message from Helm. Your studio's WhatsApp messages are set up correctly.";

// Meta message body for the WhatsApp test (template first, session text only when allowed)
export function waTestContent(env, text = TEST_TEXT) {
  const g = (k) => String(env(k) || "").trim();
  const tpl = g("COMMS_WHATSAPP_TEMPLATE");
  if (TPL_NAME.test(tpl)) {
    const lang = /^[a-z]{2}(_[A-Z]{2})?$/.test(g("WHATSAPP_TPL_LANG")) ? g("WHATSAPP_TPL_LANG") : "en";
    return { type: "template", template: { name: tpl, language: { code: lang }, components: [{ type: "body", parameters: [{ type: "text", text }] }] } };
  }
  if (g("WHATSAPP_ALLOW_TEXT") === "1") return { type: "text", text: { preview_url: false, body: text } };
  return null;
}

export function testEmail(studio) {
  const s = String(studio || "your studio").replace(/[\r\n<>]/g, "").slice(0, 80);
  return {
    subject: "Helm test e-mail for " + s,
    text: "This is a test e-mail from Helm for " + s + ".\nIf you can read this, studio e-mails (invites, payment reminders, follow-ups) are set up correctly.\nReplies to this e-mail go to the reply-to address saved on the Integrations page.",
  };
}
