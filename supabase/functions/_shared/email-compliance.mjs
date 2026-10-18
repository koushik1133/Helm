// email-compliance.mjs - one place for the legal bits every Helm e-mail carries (no I/O, pure).
// Used by the Deno edge functions and by the node tests. See docs/ops/EMAIL-COMPLIANCE.md.
//
//   * Transactional mail (sign-in codes, invites, approval links, receipts, billing, security):
//     txFooter(reason) -> "You received this because ... · Privacy · Helm Events, <postal address>".
//     NO unsubscribe link (these are messages the recipient needs for a service they use).
//   * Non-transactional mail (sales follow-ups, nurture greetings, trial nudges):
//     mktFooter(unsubUrl) adds a visible "Unsubscribe" link + the postal address (CAN-SPAM), and
//     listUnsubHeaders(httpsUrl, mailto) gives the RFC 2369 + RFC 8058 one-click headers
//     (Gmail / Yahoo bulk-sender rules).
// The postal address comes from HELM_POSTAL_ADDRESS (owner sets it); until then a visible
// placeholder is used so nobody mistakes it for a real address.

export const POSTAL_PLACEHOLDER = "[Helm Events postal address - owner to fill]";
export const DEFAULT_APP = "https://www.helm.events";
export const DEFAULT_UNSUB_MAILTO = "unsubscribe@helm.events";
const EMAIL_RE = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const oneLine = (s, n) => String(s == null ? "" : s).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export function postalAddress(env) {
  const v = oneLine(env ? env("HELM_POSTAL_ADDRESS") : "", 200);
  return v || POSTAL_PLACEHOLDER;
}
export function appBase(v) {
  const s = String(v || "").trim().replace(/\/+$/, "");
  return /^https:\/\/[A-Za-z0-9.-]{1,190}(:[0-9]{1,5})?$/.test(s) ? s : DEFAULT_APP;
}

// Why the recipient got a transactional e-mail (keep these short and honest).
export const TX_REASONS = {
  auth: "someone (hopefully you) asked to sign in, sign up or change the e-mail on a Helm account",
  invite: "a studio on Helm invited this address to join their team",
  welcome: "you created a Helm studio account",
  client_link: "your event planner sent you a link about your event",
  otp: "a one-time code was requested to confirm your event on Helm",
  payment: "a payment was made or is due for your event",
  pay_reminder: "a payment is due for your event with this planner",
  package: "you are a client or team member on an event that uses Helm",
  billing: "you manage billing for a studio on Helm",
  security: "you are an owner or admin of a studio on Helm",
  test: "a studio admin sent a test message from Helm's Integrations page",
};

export function txFooter(reasonKey, o = {}) {
  const reason = TX_REASONS[reasonKey] || oneLine(reasonKey, 200) || TX_REASONS.auth;
  const app = appBase(o.app);
  const addr = o.address || POSTAL_PLACEHOLDER;
  const privacy = app + "/privacy";
  // o.noLinks: security alerts carry no links at all (anti-phishing) - privacy is named, not linked
  if (o.noLinks) {
    const host = app.replace(/^https:\/\//, "") + "/privacy";
    return { text: "\n\n--\nYou received this because " + reason + ".\nPrivacy: " + host + "\nHelm Events, " + addr,
             html: '<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#6b7280">You received this because ' + esc(reason) +
               ". &middot; Privacy: " + esc(host) + " &middot; Helm Events, " + esc(addr) + "</p>" };
  }
  return {
    text: "\n\n--\nYou received this because " + reason + ".\nPrivacy: " + privacy + "\nHelm Events, " + addr,
    html: '<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#6b7280">You received this because ' + esc(reason) +
      '. &middot; <a href="' + esc(privacy) + '" style="color:#6b7280">Privacy</a> &middot; Helm Events, ' + esc(addr) + "</p>",
  };
}

export function mktFooter(unsubUrl, o = {}) {
  const app = appBase(o.app);
  const addr = o.address || POSTAL_PLACEHOLDER;
  const who = oneLine(o.sender, 60) || "Helm";
  const reason = oneLine(o.reason, 200) || ("you are in touch with " + who);
  const privacy = app + "/privacy";
  const u = String(unsubUrl || "");
  return {
    text: "\n\n--\nYou received this because " + reason + ". Don't want these e-mails? Unsubscribe: " + u +
      "\nPrivacy: " + privacy + "\nHelm Events, " + addr,
    html: '<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#6b7280">You received this because ' + esc(reason) +
      '. &middot; <a href="' + esc(u) + '" style="color:#6b7280">Unsubscribe</a> &middot; <a href="' + esc(privacy) +
      '" style="color:#6b7280">Privacy</a> &middot; Helm Events, ' + esc(addr) + "</p>",
  };
}

// RFC 2369 List-Unsubscribe (mailto + https) + RFC 8058 List-Unsubscribe-Post.
// The https URL must accept a POST with body "List-Unsubscribe=One-Click" (email-unsubscribe).
/** @returns {Record<string, string>} */
export function listUnsubHeaders(httpsUrl, mailto) {
  const u = String(httpsUrl || "");
  if (!/^https:\/\/[^\s<>,]+$/.test(u)) return {};
  const m = EMAIL_RE.test(String(mailto || "").trim()) ? String(mailto).trim() : DEFAULT_UNSUB_MAILTO;
  return {
    "List-Unsubscribe": "<mailto:" + m + "?subject=unsubscribe>, <" + u + ">",
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

// Tokens are made by the database (email_unsub_token, HMAC-signed, 0165) - only the shape is checked here.
export const UNSUB_TOKEN_RE = /^v1\.[0-9a-f]{32}\.[0-9a-f]{2,520}\.[0-9a-f]{64}$/;

// visible link -> the public page; header link -> the one-click POST endpoint
export function unsubLinks(token, o = {}) {
  if (!UNSUB_TOKEN_RE.test(String(token || ""))) return null;
  const app = appBase(o.app);
  const fn = String(o.functionsUrl || "").replace(/\/+$/, "");
  const post = /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9/_-]*)?$/.test(fn) ? fn + "/email-unsubscribe?t=" + token : app + "/unsubscribe?t=" + token;
  return { page: app + "/unsubscribe?t=" + token, oneClick: post };
}

/** @param {{text?: string, html?: string}} body @param {{text: string, html: string}} footer @returns {{text: string, html?: string}} */
// Text/html body + footer in one call (html is optional: a plain-text-only message stays text-only).
export function withFooter(body, footer) {
  /** @type {{text: string, html?: string}} */
  const out = { text: String(body.text || "") + footer.text };
  if (body.html) {
    const h = String(body.html);
    out.html = /<\/body>/i.test(h) ? h.replace(/<\/body>/i, footer.html + "</body>") : h + footer.html;
  }
  return out;
}
