// invite-mailer template (migration 0131). Light-only, table-based, inline-CSS HTML in the same
// style as welcome-mailer (purple #6C4CF1, white card on #f6f4f1). No external images, no
// tracking. Every user-entered value (inviter, studio) is cleaned + HTML-escaped. The Join link
// is built here from APP_URL + a hex-only token - nothing else in the e-mail comes from the DB.

export const SUPPORT = "support@helm.events";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";
const INK = "#1b1930", BODY = "#4b475f", MUTED = "#6b6577", FAINT = "#8b8698", RULE = "#e8e3db", BRAND = "#6C4CF1";

export const ROLE_LABELS: Record<string, string> = {
  admin: "Admin", manager: "Event manager", planner: "Planner", sales: "Sales",
  coordinator: "Event coordinator", supervisor: "Supervisor", quality: "Quality engineer",
  operations: "Operations", designer: "Designer", crew: "Crew", worker: "Worker",
};

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// trim + strip control chars + collapse whitespace + cap length (names are user-entered)
export const clean = (s: unknown, max = 80) =>
  String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

// subject lines must not carry CR/LF or angle brackets
const subj = (s: string) => s.replace(/[\r\n<>]/g, " ");

export const TOKEN_RE = /^[0-9a-f]{16,128}$/i;

export function appUrl(): string {
  const v = (Deno.env.get("APP_URL") || "https://www.helm.events").trim().replace(/\/+$/, "");
  try { const u = new URL(v); if (u.protocol === "https:") return u.origin; } catch (_) { /* fall through */ }
  return "https://www.helm.events";
}

export function joinLink(token: string): string | null {
  if (!TOKEN_RE.test(token)) return null;
  return `${appUrl()}/login?invite=${encodeURIComponent(token)}`;
}

function fmtDate(iso: unknown): string {
  const d = new Date(String(iso ?? ""));
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export type Mail = { subject: string; html: string; text: string };

export function inviteEmail(opts: { token: unknown; inviter?: unknown; studio?: unknown; role?: unknown; expires_at?: unknown }): Mail | null {
  const link = joinLink(String(opts.token ?? ""));
  if (!link) return null;
  const studio = clean(opts.studio) || "a studio";
  const inviter = clean(opts.inviter, 60) || "Your studio admin";
  const roleKey = String(opts.role ?? "");
  const role = ROLE_LABELS[roleKey] || clean(roleKey, 40) || "a team member";
  const expires = fmtDate(opts.expires_at);
  const headline = `${inviter} invited you to join ${studio} on Helm as ${role}`;
  const site = appUrl();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>You're invited to Helm</title>
<style>@media (max-width:600px){ .container{width:100%!important} .px{padding-left:20px!important;padding-right:20px!important} .btn{display:block!important} }</style>
</head>
<body style="margin:0;padding:0;background:#f6f4f1;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc("Join " + studio + " on Helm")}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f4f1;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" class="container" style="width:560px;max-width:560px;">
<tr><td style="padding:0 0 20px;font-family:${FONT};font-size:18px;font-weight:800;color:${INK};">Helm<span style="color:${BRAND};">.</span></td></tr>
<tr><td class="px" style="background:#ffffff;border:1px solid ${RULE};border-radius:16px;padding:36px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td style="padding:0 0 12px;font-family:${FONT};font-size:22px;line-height:30px;font-weight:800;color:${INK};">${esc(headline)}</td></tr>
<tr><td style="padding:0 0 20px;font-family:${FONT};font-size:15px;line-height:24px;color:${BODY};">Hi there, <strong style="color:${INK};">${esc(inviter)}</strong> has invited you to <strong style="color:${INK};">${esc(studio)}</strong>, the team that runs its events on Helm. Click below to create your login with this e-mail address and join as <strong style="color:${INK};">${esc(role)}</strong>.</td></tr>
<tr><td align="center" style="padding:8px 0 24px;"><a href="${esc(link)}" class="btn" style="display:inline-block;background:${BRAND};color:#ffffff;font-family:${FONT};font-size:16px;font-weight:700;line-height:48px;height:48px;padding:0 32px;border-radius:10px;text-decoration:none;">Join ${esc(studio)}</a></td></tr>
${expires ? `<tr><td style="padding:0 0 16px;font-family:${FONT};font-size:14px;line-height:21px;color:${MUTED};">This invitation expires on <strong>${esc(expires)}</strong>. After that, ask ${esc(inviter)} for a new one.</td></tr>` : ""}
<tr><td style="padding:0 0 16px;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};word-break:break-all;">Button not working? Paste this link into your browser:<br><a href="${esc(link)}" style="color:${BRAND};">${esc(link)}</a></td></tr>
<tr><td style="border-top:1px solid ${RULE};padding:18px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};">Didn't expect this? You can ignore this e-mail - nothing happens unless you click the link. Helm will never ask for your password by e-mail. Questions: <a href="mailto:${SUPPORT}" style="color:${BRAND};">${SUPPORT}</a>.</td></tr>
</table>
</td></tr>
<tr><td align="center" style="padding:20px 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${FAINT};">Helm Events &middot; <a href="${esc(site)}" style="color:${FAINT};">helm.events</a></td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    headline,
    "",
    `Hi there, ${inviter} has invited you to ${studio} on Helm. Open this link to create your login with this e-mail address and join as ${role}:`,
    "",
    link,
    "",
    expires ? `This invitation expires on ${expires}.` : "",
    "Didn't expect this? Ignore this e-mail - nothing happens unless you open the link.",
    `Questions? ${SUPPORT}`,
    "",
    "Helm Events - helm.events",
  ].join("\n");

  return { subject: subj(`${inviter} invited you to join ${studio} on Helm`), html, text };
}
