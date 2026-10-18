// pkg-client-notify templates (migration 0069; 2026-10 redesign on _shared/email-layout.mjs).
// Table-based, inline-CSS, hosted Helm logo only, no tracking. Every dynamic value is HTML-escaped. The only link is the client's approval
// page on the FIXED site origin; its path must match /approve?token=<uuid>.

import { codeMoney } from "../_shared/money.ts";
import * as L from "../_shared/email-layout.mjs";
const { layout } = L;

export const SITE = "https://www.helm.events";
const INK = "#101511";
const APPROVE = /^\/approve\?token=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const clean = (s: unknown, max = 80) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** absolute approval link, or "" when the stored path is not exactly /approve?token=<uuid> */
export function approveLink(path: unknown): string {
  const p = String(path ?? "");
  return APPROVE.test(p) ? SITE + p : "";
}

// 0092: the payload's own currency, grouped for that currency (INR output unchanged)
const money = codeMoney;

// 2026-10: shared Helm layout (hosted logo, emerald, dark-mode aware, preheader)
const shell = (title: string, inner: string, pre = title) => layout(title, pre, inner, { sub: "" });
const h1 = (t: string) => L.h1(t);
const para = (t: string) => L.para(t, "0 0 18px");
const button = (href: string, label: string) => L.button(esc(href), esc(label));

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
        L.facts(lines.map((l) => { const i = l.indexOf(": "); return [esc(l.slice(0, i)), esc(l.slice(i + 2))]; })) + button(link, "Review and approve"),
        `${studio} sent your updated quote`),
      text: [`${hi} ${studio} has reviewed your package choice for ${event}.${again}`, "", ...lines, "", `Review and approve: ${link}`].join("\n") + L.TEXT_FOOTER,
    };
  }
  if (kind === "pkg_declined") {
    const reason = clean(p.reason, 300);
    return {
      subject: `About your package choice - ${studio}`,
      html: shell("Your package choice", h1("About your package choice") +
        para(`${esc(hi)} ${esc(studio)} could not accept the package you picked for <strong style="color:${INK};">${esc(event)}</strong>.`) +
        (reason ? para(`Reason: ${esc(reason)}`) : "") + para("You can open your booklet again to choose another package.")),
      text: [`${hi} ${studio} could not accept the package you picked for ${event}.`, reason ? `Reason: ${reason}` : "", "You can open your booklet again to choose another package."].filter(Boolean).join("\n") + L.TEXT_FOOTER,
    };
  }
  if (kind === "pkg_otp") {
    const code = String(p.otp ?? "");
    if (!/^[0-9]{6}$/.test(code)) return null;
    return {
      subject: `${code} is your ${studio} code`,
      html: shell("Your code", h1("Your confirmation code") + para(`${esc(hi)} use this code to confirm your package choice with ${esc(studio)}. It expires in 10 minutes.`) +
        L.codeBox(code) + L.note("Never share this code with anyone. If you didn't ask for it, you can ignore this e-mail."), `${code} is your confirmation code`),
      text: `${hi} use ${code} to confirm your package choice with ${studio}. It expires in 10 minutes.` + L.TEXT_FOOTER,
    };
  }
  if (kind === "pkg_selected" || kind === "pkg_payment") {   // staff WhatsApp only
    const t = kind === "pkg_selected"
      ? `Helm: a client picked a package (${clean(p.package, 60) || "package"}, ${Number(p.guests) || "?"} guests) for ${clean(p.code, 20) || "an event"}. Review it in Helm.`
      : `Helm: a payment of ${money(p.amount, p.currency) || "an amount"} was received for ${clean(p.code, 20) || "an event"}.` +
        // India audit #15: carry the balance still due when the caller sends it (0 -> paid in full).
        (p.balance == null || p.balance === "" || !Number.isFinite(Number(p.balance)) ? ""
          : Number(p.balance) <= 0 ? " Paid in full." : ` Balance due: ${money(p.balance, p.currency)}.`);
    return { subject: t, html: "", text: t };
  }
  return null;
}
