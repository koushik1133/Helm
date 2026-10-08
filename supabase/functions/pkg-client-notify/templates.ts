// pkg-client-notify templates (migration 0069). Light-only, table-based, inline-CSS HTML
// (purple #6C4CF1, white card on #f6f4f1). No dark-mode rules, no external images, no
// tracking. Every dynamic value is HTML-escaped. The only link is the client's approval
// page on the FIXED site origin; its path must match /approve?token=<uuid>.

export const SITE = "https://www.helm.events";
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";
const INK = "#1b1930", BODY = "#4b475f", FAINT = "#8b8698", RULE = "#e8e3db", BRAND = "#6C4CF1";
const APPROVE = /^\/approve\?token=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const clean = (s: unknown, max = 80) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** absolute approval link, or "" when the stored path is not exactly /approve?token=<uuid> */
export function approveLink(path: unknown): string {
  const p = String(path ?? "");
  return APPROVE.test(p) ? SITE + p : "";
}

function money(n: unknown, cur: unknown): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const c = /^[A-Z]{3}$/.test(String(cur ?? "")) ? String(cur) : "INR";
  return `${c} ${Math.round(v).toLocaleString("en-IN")}`;
}

function shell(title: string, inner: string) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only"><meta name="supported-color-schemes" content="light"><title>${esc(title)}</title>
<style>:root{color-scheme:light only;supported-color-schemes:light;}</style></head>
<body style="margin:0;padding:0;background:#f6f4f1;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f4f1;"><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:560px;max-width:560px;">
<tr><td style="background:#ffffff;border:1px solid ${RULE};border-radius:16px;padding:36px 40px;font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${inner}</table>
</td></tr>
<tr><td align="center" style="padding:20px 8px 0;font-family:${FONT};font-size:12px;color:${FAINT};">Sent with Helm &middot; helm.events</td></tr>
</table></td></tr></table></body></html>`;
}
const h1 = (t: string) => `<tr><td style="padding:0 0 12px;font-size:22px;line-height:28px;font-weight:800;color:${INK};">${t}</td></tr>`;
const para = (t: string) => `<tr><td style="padding:0 0 18px;font-size:15px;line-height:24px;color:${BODY};">${t}</td></tr>`;
const button = (href: string, label: string) =>
  `<tr><td align="center" style="padding:8px 0 20px;"><a href="${esc(href)}" style="display:inline-block;background:${BRAND};color:#ffffff;font-size:16px;font-weight:700;line-height:48px;padding:0 32px;border-radius:10px;text-decoration:none;">${esc(label)}</a></td></tr>`;

export type Msg = { subject: string; html: string; text: string };
type P = Record<string, unknown>;

/** null = nothing to send for this kind / payload */
export function render(kind: string, p: P): Msg | null {
  const studio = clean(p.studio) || "Your event studio";
  const first = clean(p.client_name, 60).split(" ")[0] || "";
  const hi = first ? `Hi ${first},` : "Hello,";
  const event = clean(p.title) || clean(p.code) || "your event";
  if (kind === "pkg_accepted") {
    const link = approveLink(p.approve_url);
    if (!link) return null;
    const total = money(p.total, p.currency), bal = money(p.balance, p.currency), paid = Number(p.paid) > 0 ? money(p.paid, p.currency) : "";
    const again = p.reapproval === true ? " Because the price changed, please review and approve it again." : "";
    const lines = [`New total: ${total}`, paid ? `Already paid: ${paid}` : "", `Balance: ${bal}`].filter(Boolean);
    return {
      subject: `Your updated quote from ${studio} is ready`,
      html: shell("Your updated quote", h1("Your updated quote is ready") +
        para(`${esc(hi)} ${esc(studio)} has reviewed your package choice for <strong style="color:${INK};">${esc(event)}</strong>.${esc(again)}`) +
        para(lines.map(esc).join("<br>")) + button(link, "Review and approve")),
      text: [`${hi} ${studio} has reviewed your package choice for ${event}.${again}`, "", ...lines, "", `Review and approve: ${link}`].join("\n"),
    };
  }
  if (kind === "pkg_declined") {
    const reason = clean(p.reason, 300);
    return {
      subject: `About your package choice - ${studio}`,
      html: shell("Your package choice", h1("About your package choice") +
        para(`${esc(hi)} ${esc(studio)} could not accept the package you picked for <strong style="color:${INK};">${esc(event)}</strong>.`) +
        (reason ? para(`Reason: ${esc(reason)}`) : "") + para("You can open your booklet again to choose another package.")),
      text: [`${hi} ${studio} could not accept the package you picked for ${event}.`, reason ? `Reason: ${reason}` : "", "You can open your booklet again to choose another package."].filter(Boolean).join("\n"),
    };
  }
  if (kind === "pkg_otp") {
    const code = String(p.otp ?? "");
    if (!/^[0-9]{6}$/.test(code)) return null;
    return {
      subject: `${code} is your ${studio} code`,
      html: shell("Your code", h1("Your confirmation code") + para(`${esc(hi)} use <strong style="color:${INK};font-size:20px;letter-spacing:2px;">${code}</strong> to confirm your package choice. It expires in 10 minutes.`)),
      text: `${hi} use ${code} to confirm your package choice with ${studio}. It expires in 10 minutes.`,
    };
  }
  if (kind === "pkg_selected" || kind === "pkg_payment") {   // staff WhatsApp only
    const t = kind === "pkg_selected"
      ? `Helm: a client picked a package (${clean(p.package, 60) || "package"}, ${Number(p.guests) || "?"} guests) for ${clean(p.code, 20) || "an event"}. Review it in Helm.`
      : `Helm: a payment of ${money(p.amount, p.currency) || "an amount"} was received for ${clean(p.code, 20) || "an event"}.`;
    return { subject: t, html: "", text: t };
  }
  return null;
}
