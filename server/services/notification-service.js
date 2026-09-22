// ============================================================================
// server/services/notification-service.js
// Builds the onboarding-invite email payload (branded HTML + plain text).
// ---------------------------------------------------------------------------
// Transport-agnostic: dispatchOnboardingNotification() RETURNS a payload; wire it
// to your provider (Resend / SES / Postmark / SMTP) inside send(). No secrets are
// hardcoded — the app base URL and any provider key come from the environment.
// Runs server-side only. Contains no service_role usage and no DB access.
// ============================================================================
'use strict';

// Where the app is served (used to build the invite link). From env; safe default.
const APP_BASE_URL = (process.env.APP_BASE_URL || 'https://app.helm.example').replace(/\/$/, '');

// HTML-escape every interpolated value so email content can never inject markup.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Build the onboarding invitation email for one recipient.
 * @param {string} recipientEmail  - the invited email (the invite is locked to this address)
 * @param {string} invitationToken - the token from create_invitation
 * @param {string} organizationName
 * @param {string} assignedRole
 * @returns {{ to:string, subject:string, html:string, text:string, link:string }}
 */
function dispatchOnboardingNotification(recipientEmail, invitationToken, organizationName, assignedRole) {
  if (!recipientEmail || !invitationToken) {
    throw new Error('notification-service: recipientEmail and invitationToken are required.');
  }

  // /login.html?invite=<token> — the server 302-redirects to the clean /login,
  // preserving the query string, then login.html accepts the token after sign-in.
  const link = `${APP_BASE_URL}/login.html?invite=${encodeURIComponent(invitationToken)}`;

  const orgSafe   = esc(organizationName || 'your team');
  const roleSafe  = esc(assignedRole || 'team member');
  const emailSafe = esc(recipientEmail);
  const linkSafe  = esc(link);

  const subject = `You're invited to join ${organizationName || 'a studio'} on Helm`;

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;background:#f6f4f1;font-family:'IBM Plex Sans',-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1b1930;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4f1;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e8e3db;border-radius:16px;overflow:hidden;">
        <!-- header -->
        <tr><td style="background:linear-gradient(135deg,#6d28d9,#4f46e5);padding:28px 32px;">
          <span style="display:inline-block;width:30px;height:30px;border-radius:8px;background:rgba(255,255,255,.18);vertical-align:middle;"></span>
          <span style="color:#ffffff;font-size:18px;font-weight:700;letter-spacing:-.01em;margin-left:10px;vertical-align:middle;">Helm</span>
        </td></tr>
        <!-- body -->
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 12px;font-size:22px;line-height:1.25;letter-spacing:-.02em;">You've been invited to <span style="color:#6d28d9;">${orgSafe}</span></h1>
          <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#4b475f;">
            You've been invited to join <b>${orgSafe}</b> on Helm as a <b>${roleSafe}</b>.
            Click below to create your account (or sign in) and accept the invitation.
          </p>
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;">
            <tr><td style="border-radius:11px;background:linear-gradient(120deg,#6d28d9,#4f46e5);">
              <a href="${linkSafe}" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:11px;">Accept invitation &rarr;</a>
            </td></tr>
          </table>
          <!-- security warning -->
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf5ff;border:1px solid #e9d8fd;border-radius:12px;">
            <tr><td style="padding:14px 16px;font-size:13px;line-height:1.55;color:#4b475f;">
              🔒 <b>For your security:</b> this invitation is tied to <b>${emailSafe}</b>. It can only be accepted by
              signing in or registering with that exact email address — it cannot be claimed or registered by any
              other account. The link expires in 7 days.
            </td></tr>
          </table>
          <p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:#8b8698;">
            If the button doesn't work, copy and paste this link into your browser:<br>
            <a href="${linkSafe}" style="color:#6d28d9;word-break:break-all;">${linkSafe}</a>
          </p>
        </td></tr>
        <!-- footer -->
        <tr><td style="padding:18px 32px;border-top:1px solid #f1ede7;font-size:12px;color:#8b8698;">
          You received this because ${emailSafe} was invited to a Helm workspace. If you weren't expecting it, you can ignore this email.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  const text =
`You've been invited to join ${organizationName || 'a studio'} on Helm as a ${assignedRole || 'team member'}.

Accept your invitation:
${link}

For your security: this invitation is tied to ${recipientEmail}. It can only be accepted by
signing in or registering with that exact email address — it cannot be claimed by any other
account. The link expires in 7 days.

If you weren't expecting this, you can ignore this email.`;

  return { to: recipientEmail, subject, html, text, link };
}

/**
 * Optional: hand the payload to your email provider. Left as a pluggable stub so
 * no provider credential is baked in. Configure a provider (Resend/SES/SMTP) and
 * read its key from process.env here.
 */
async function send(/* payload */) {
  throw new Error('notification-service.send(): wire your email provider here (read its API key from process.env).');
}

module.exports = { dispatchOnboardingNotification, send };
