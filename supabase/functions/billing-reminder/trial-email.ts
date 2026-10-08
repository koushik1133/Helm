// trial-email.ts — branded trial-ending e-mails for billing-reminder (0058 kinds).
// Pure (no I/O). Light-only on purpose: same layout, colours and footer as
// docs/email-templates, without the dark-mode overrides. Every interpolated value
// is escaped; the link is always APP_URL + "/checkout" (never taken from a row).
import { escHtml } from "../_shared/cors.ts";

export const TRIAL_KINDS = ["trial_7d", "trial_3d", "trial_1d", "trial_ended"] as const;
export type TrialKind = typeof TRIAL_KINDS[number];
export const isTrialKind = (k: string): k is TrialKind => (TRIAL_KINDS as readonly string[]).includes(k);

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

function copy(kind: TrialKind, date: string) {
  const on = date ? ` on <b>${escHtml(date)}</b>` : "";
  switch (kind) {
    case "trial_7d": return { subject: "Your Helm free trial ends in 7 days", title: "Your free trial ends in 7 days",
      pre: "Choose a plan to keep your studio running on Helm.",
      body: `Your 14-day free trial of Helm ends${on}. Choose a plan now so your team, events and clients carry on without a break.` };
    case "trial_3d": return { subject: "3 days left on your Helm free trial", title: "3 days left on your free trial",
      pre: "Your Helm trial ends soon — choose a plan.",
      body: `Your Helm free trial ends${on}. Pick a plan in a couple of minutes to keep everything you've set up.` };
    case "trial_1d": return { subject: "Your Helm free trial ends tomorrow", title: "Your free trial ends tomorrow",
      pre: "Last day to choose a plan before your trial ends.",
      body: `Your Helm free trial ends${on}. Choose a plan today to keep using Helm without interruption.` };
    default: return { subject: "Your Helm free trial has ended", title: "Your free trial has ended",
      pre: "Choose a plan to keep using Helm.",
      body: `Your Helm free trial ended${on}. Your data is safe — choose a plan to keep using Helm.` };
  }
}

export function trialMessage(kind: TrialKind, studio: string, trialEnd: string, appUrl: string) {
  const app = String(appUrl || "https://www.helm.events").replace(/\/+$/, "");
  const date = /^\d{4}-\d{2}-\d{2}/.test(trialEnd) ? trialEnd.slice(0, 10) : "";
  const c = copy(kind, date);
  const href = escHtml(app + "/checkout");
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${escHtml(c.title)}</title>
<style>@media (max-width:600px){ .container{width:100%!important} .px{padding-left:20px!important;padding-right:20px!important} .btn{display:block!important} }</style>
</head>
<body style="margin:0;padding:0;background:#f6f4f1;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escHtml(c.pre)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f4f1;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" class="container" style="width:560px;max-width:560px;">
<tr><td style="padding:0 0 20px;" align="left">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="32" height="32" style="width:32px;height:32px;background:#6C4CF1;border-radius:8px;" align="center" valign="middle"><div style="width:14px;height:14px;border:2px solid #ffffff;border-radius:3px;font-size:0;line-height:0;">&nbsp;</div></td>
    <td style="padding-left:10px;font-family:${FONT};font-size:18px;font-weight:800;letter-spacing:-.01em;color:#1b1930;">Helm<span style="color:#6C4CF1;">.</span></td>
  </tr></table>
</td></tr>
<tr><td class="px" style="background:#ffffff;border:1px solid #e8e3db;border-radius:16px;padding:36px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:0 0 12px;font-family:${FONT};font-size:24px;line-height:30px;font-weight:800;color:#1b1930;">${escHtml(c.title)}</td></tr>
<tr><td style="padding:0 0 24px;font-family:${FONT};font-size:15px;line-height:24px;color:#4b475f;">Hi ${escHtml(studio)},<br>${c.body}</td></tr>
<tr><td align="center" style="padding:8px 0 24px;">
<a href="${href}" class="btn" style="display:inline-block;background:#6C4CF1;color:#ffffff;font-family:${FONT};font-size:16px;font-weight:700;line-height:48px;height:48px;padding:0 32px;border-radius:10px;text-decoration:none;">Choose a plan</a>
</td></tr>
<tr><td style="padding:0 0 20px;font-family:${FONT};font-size:13px;line-height:20px;color:#6b6577;">Button not working? Copy and paste this link into your browser:<br><a href="${href}" style="color:#6C4CF1;word-break:break-all;">${href}</a></td></tr>
<tr><td style="border-top:1px solid #e8e3db;padding:18px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:#6b6577;">Questions about plans or billing? Reply to this e-mail. Helm will never ask for your password or card details by e-mail.</td></tr>
</table>
</td></tr>
<tr><td align="center" style="padding:20px 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:#8b8698;">
Helm Events · <a href="https://helm.events" style="color:#8b8698;text-decoration:underline;">helm.events</a><br>Run every event, end to end.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { subject: c.subject, html };
}
