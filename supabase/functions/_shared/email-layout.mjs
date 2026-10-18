// Shared Helm e-mail layout (2026-10 redesign). Plain JS so both the Deno edge functions and the
// Node generator (scripts/gen-email-templates.mjs, which writes the Supabase Auth templates) use the
// SAME markup. Table-based, inline styles, 600px, preheader, dark-mode friendly (prefers-color-scheme
// + Outlook.com [data-ogsc]), hosted logo PNG (no tracking pixels, no other images), footer
// "Helm Events · helm.events". Callers must pass ALREADY-ESCAPED HTML into the block helpers.

import { DEFAULT_POSTAL_ADDRESS } from "./email-compliance.mjs";

export const SITE = "https://www.helm.events";
// r19: current compass-H app tile (public/brand/helm-email-emerald.svg rendered to an 80x80 PNG = 2x the
// 40px display size; own dark-green tile, so it reads on light AND dark backgrounds). The file NAME is
// versioned on purpose: /*.png is served "immutable" for a year and Gmail/Outlook image proxies cache by
// URL, so overwriting helm-logo.png in place kept showing the old two-pill mark. Never overwrite an
// e-mail image in place - add a new file name and point LOGO_URL at it (keep the old file for old mail).
export const LOGO_URL = "https://www.helm.events/email/helm-logo-v3.png";
export const LOGO_ALT = "Helm Events";
export const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const C = {
  bg: "#f4f6f3", card: "#ffffff", ink: "#101511", body: "#3d4540", muted: "#66706a",
  faint: "#8a948d", rule: "#e3e8e4", brand: "#0d8a5c", brandSoft: "#e7f4ec",
};

export const escHtml = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const h1 = (t) =>
  `<tr><td class="ink" style="padding:0 0 12px;font-family:${FONT};font-size:24px;line-height:31px;font-weight:700;letter-spacing:-.01em;color:${C.ink};">${t}</td></tr>`;
export const para = (t, pad = "0 0 20px") =>
  `<tr><td class="body" style="padding:${pad};font-family:${FONT};font-size:15px;line-height:24px;color:${C.body};">${t}</td></tr>`;
export const strong = (t) => `<strong class="ink" style="color:${C.ink};font-weight:600;">${t}</strong>`;
export const note = (t) =>
  `<tr><td class="rule muted" style="border-top:1px solid ${C.rule};padding:18px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};">${t}</td></tr>`;
export const link = (href, label) => `<a href="${href}" class="lnk" style="color:${C.brand};text-decoration:underline;">${label}</a>`;

/** big primary button; href/label must already be escaped (or be a Supabase {{ }} variable) */
export function button(href, label) {
  // 0205 bulletproof button: Outlook desktop (Word engine) gets the VML roundrect; every other client
  // (Outlook web / new Outlook, Gmail, Apple Mail) gets a table cell + a real <a href> with inline
  // styles - no <!--[if !mso]> wrapper that some webmail sanitisers drop. The plain URL line
  // (fallback()) always follows, so the link works even when buttons are stripped.
  return `<tr><td align="left" style="padding:4px 0 24px;">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${href}" style="height:48px;v-text-anchor:middle;width:280px;" arcsize="22%" fillcolor="${C.brand}" stroke="f"><w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${label}</center></v:roundrect><![endif]-->
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;mso-hide:all;"><tr><td align="center" bgcolor="${C.brand}" style="background:${C.brand};border-radius:10px;mso-hide:all;"><a href="${href}" target="_blank" rel="noopener" class="btn" style="display:inline-block;background:${C.brand};color:#ffffff;font-family:${FONT};font-size:16px;font-weight:600;line-height:20px;padding:14px 30px;border:1px solid ${C.brand};border-radius:10px;text-decoration:none;mso-hide:all;">${label}</a></td></tr></table>
</td></tr>`;
}

/** "Button not working?" fallback line with the raw URL */
export const fallback = (href) =>
  `<tr><td class="muted" style="padding:0 0 20px;font-family:${FONT};font-size:13px;line-height:20px;color:${C.muted};word-break:break-all;">Button not working? Copy and paste this link into your browser:<br><a href="${href}" class="lnk" style="color:${C.brand};">${href}</a></td></tr>`;

/** one-time code panel */
export const codeBox = (code) =>
  `<tr><td style="padding:4px 0 24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td class="codebox" style="background:${C.brandSoft};border-radius:12px;padding:16px 28px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:30px;line-height:36px;font-weight:700;letter-spacing:8px;color:${C.ink};">${code}</td></tr></table></td></tr>`;

/** label / value rows (values already escaped) */
export const facts = (rows) =>
  `<tr><td style="padding:0 0 22px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="rule" style="border:1px solid ${C.rule};border-radius:12px;">${rows.map(([k, v], i) =>
    `<tr><td class="muted${i ? " rule" : ""}" style="padding:12px 16px;${i ? `border-top:1px solid ${C.rule};` : ""}font-family:${FONT};font-size:14px;line-height:20px;color:${C.muted};">${k}</td><td align="right" class="ink${i ? " rule" : ""}" style="padding:12px 16px;${i ? `border-top:1px solid ${C.rule};` : ""}font-family:${FONT};font-size:14px;line-height:20px;font-weight:600;color:${C.ink};">${v}</td></tr>`).join("")}</table></td></tr>`;

/**
 * Full document. title + preheader are plain text (escaped here); inner is a set of <tr> rows.
 * opts.site: link target for the footer (default SITE). opts.sub: optional footer second line (escaped).
 */
export function layout(title, preheader, inner, opts = {}) {
  const site = opts.site || SITE;
  const sub = opts.sub == null ? "Run every event, end to end." : String(opts.sub);
  // opts.reason: compliance line (email-compliance.mjs) - "You received this because ..." + Privacy + postal address.
  const comp = opts.reason ? `<br>You received this because ${escHtml(opts.reason)}. &middot; <a href="${site}/privacy" class="muted" style="color:${C.faint};text-decoration:underline;">Privacy</a> &middot; Helm Events, ${escHtml(opts.address || DEFAULT_POSTAL_ADDRESS)}` : "";
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${escHtml(title)}</title>
<style>
  :root{color-scheme:light dark;supported-color-schemes:light dark;}
  @media (max-width:620px){ .container{width:100%!important} .px{padding-left:22px!important;padding-right:22px!important} .btn{display:block!important;text-align:center!important} }
  @media (prefers-color-scheme:dark){
    .bg{background:#0f1411!important} .card{background:#18201b!important;border-color:#2a352e!important;border-top-color:#0d8a5c!important}
    .ink{color:#f1f5f2!important} .body{color:#cdd6d0!important} .muted{color:#a9b5ad!important}
    .rule{border-color:#2a352e!important} .lnk{color:#4ade9a!important} .codebox{background:#1f3a2b!important;color:#f1f5f2!important}
  }
  [data-ogsc] .ink{color:#f1f5f2!important} [data-ogsc] .body{color:#cdd6d0!important} [data-ogsc] .muted{color:#a9b5ad!important} [data-ogsc] .lnk{color:#4ade9a!important}
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:${C.bg};">${escHtml(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:${C.bg};">
<tr><td align="center" style="padding:36px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" class="container" style="width:600px;max-width:600px;">
<tr><td style="padding:0 4px 22px;" align="left">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="40" height="40" valign="middle" style="width:40px;height:40px;"><a href="${site}" style="text-decoration:none;"><img src="${LOGO_URL}" width="40" height="40" alt="${LOGO_ALT}" style="display:block;width:40px;height:40px;border:0;outline:none;text-decoration:none;border-radius:8px;"></a></td>
    <td class="ink" valign="middle" style="padding-left:12px;font-family:${FONT};font-size:20px;line-height:24px;font-weight:700;letter-spacing:-.02em;color:${C.ink};">Helm <span class="muted" style="font-weight:500;color:${C.muted};">Events</span></td>
  </tr></table>
</td></tr>
<tr><td class="card px" style="background:${C.card};border:1px solid ${C.rule};border-top:4px solid ${C.brand};border-radius:18px;padding:40px 44px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${inner}
</table>
</td></tr>
<tr><td align="center" class="muted" style="padding:22px 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${C.faint};">
Helm Events &middot; <a href="${site}" class="muted" style="color:${C.faint};text-decoration:underline;">helm.events</a>${sub ? `<br>${escHtml(sub)}` : ""}${comp}
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/** plain-text footer appended to every text alternative */
export const TEXT_FOOTER = "\n--\nHelm Events · helm.events";
