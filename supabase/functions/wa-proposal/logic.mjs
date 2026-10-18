// wa-proposal/logic.mjs - pure helpers (no network, no Deno APIs) so node tests can cover them.
// Template names are FIXED here; their wording lives in docs/ops/WHATSAPP-SETUP.md and must be
// approved in Meta WhatsApp Manager before WHATSAPP_TOKEN is set.

import { layout, h1, para, strong, note, codeBox, escHtml, TEXT_FOOTER } from "../_shared/email-layout.mjs";
import { DEFAULT_POSTAL_ADDRESS, TX_REASONS } from "../_shared/email-compliance.mjs";

export const KINDS = ["proposal_sent", "proposal_reminder", "proposal_approved_pay", "payment_received"];
export const OTP_TEMPLATE = "proposal_approval_otp";
export const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clip = (v, n = 120) => String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, "   ").trim().slice(0, n) || "-";

// body variables per template (order = {{1}}, {{2}}, ...) - see WHATSAPP-SETUP.md
export function bodyVars(kind, vars) {
  const v = vars || {};
  switch (kind) {
    case "proposal_sent":
    case "proposal_reminder":
      return [v.client_name, v.studio_name, v.event_type, v.event_date, v.total].map((x) => clip(x));
    case "proposal_approved_pay":
      return [v.client_name, v.event_type, v.event_date, v.total].map((x) => clip(x));
    case "payment_received":
      return [v.client_name, v.studio_name, v.event_type].map((x) => clip(x));
    default: throw new Error("unknown kind");
  }
}

// Meta Cloud API template message. Every template has ONE URL button whose dynamic suffix is
// the approval token (base URL fixed in the approved template).
export function templateMessage(to, kind, vars, token, lang = "en") {
  if (!KINDS.includes(kind)) throw new Error("unknown kind");
  if (!/^[0-9]{8,15}$/.test(String(to || ""))) throw new Error("bad number");
  if (!TOKEN_RE.test(String(token || ""))) throw new Error("bad token");
  return {
    messaging_product: "whatsapp", to: String(to), type: "template",
    template: {
      name: kind, language: { code: lang },
      components: [
        { type: "body", parameters: bodyVars(kind, vars).map((text) => ({ type: "text", text })) },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: String(token) }] },
      ],
    },
  };
}

// AUTHENTICATION template with a copy-code button: the code goes in the body AND the button.
export function otpMessage(to, code, lang = "en") {
  if (!/^[0-9]{8,15}$/.test(String(to || ""))) throw new Error("bad number");
  if (!/^[0-9]{6}$/.test(String(code || ""))) throw new Error("bad code");
  return {
    messaging_product: "whatsapp", to: String(to), type: "template",
    template: {
      name: OTP_TEMPLATE, language: { code: lang },
      components: [
        { type: "body", parameters: [{ type: "text", text: String(code) }] },
        { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: String(code) }] },
      ],
    },
  };
}

// opts.address: postal address for the compliance footer (designed layout carries it)
export function otpEmail(code, studio, opts = {}) {
  const s = clip(studio || "your planner", 60);
  const c = /^[0-9]{4,8}$/.test(String(code)) ? String(code) : escHtml(code);
  return {
    subject: "Your approval code: " + code,
    text: `Your one-time code to approve your event with ${s} is ${code}.\nIt expires in 10 minutes. Do not share it with anyone.\n\nHelm Events` + TEXT_FOOTER,
    html: layout("Your approval code", `${code} is your one-time approval code.`,
      h1("Your approval code") +
      para(`Use this one-time code to approve your event with ${strong(escHtml(s))}. It expires in 10 minutes.`, "0 0 16px") +
      codeBox(c) +
      note("Never share this code with anyone &mdash; your planner will never ask for it. If you didn't request it, you can ignore this e-mail.") +
      para(strong("Helm Events"), "18px 0 0"), { sub: "", reason: TX_REASONS.otp, address: (opts && opts.address) || DEFAULT_POSTAL_ADDRESS }),
  };
}

// Meta status -> what the studio sees
export function statusLabel(s) {
  return ({ simulated: "Simulated", queued: "Sending", sent: "Sent", delivered: "Delivered", read: "Read", failed: "Failed" })[s] || "";
}

export const isLive = (env) => !!(env && env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_ID);
