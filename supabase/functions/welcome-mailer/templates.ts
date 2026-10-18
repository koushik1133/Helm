// welcome-mailer templates (migration 0057; 2026-10 redesign on _shared/email-layout.mjs:
// emerald brand, hosted logo PNG, dark-mode aware). No tracking. Every dynamic value is HTML-escaped. All links are FIXED
// https://www.helm.events pages — nothing in the e-mail comes from a URL in the database.
// docs/email-templates/welcome-owner.html and welcome-member.html are rendered from here
// (placeholders {{ name }} / {{ studio }}) — re-render them if you change this file.

export const SITE = "https://www.helm.events";
export const SUPPORT = "support@helm.events";
export const LINKS = {
  leads: `${SITE}/leads`,
  floorPlan: `${SITE}/builder`,
  team: `${SITE}/control`,
  manual: `${SITE}/manual`,
  signIn: `${SITE}/login`,
  dashboard: `${SITE}/dashboard`,
};

import * as L from "../_shared/email-layout.mjs";
const { FONT } = L;
const INK = L.C.ink, BODY = L.C.body, RULE = L.C.rule, BRAND = L.C.brand;

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// trim + collapse whitespace + cap length (studio / person names are user-entered)
const clean = (s: unknown, max = 80) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const firstName = (s: unknown) => clean(s, 60).split(" ")[0] || "";

const button = (href: string, label: string) => L.button(href, label);

function step(n: number, title: string, text: string, href: string, cta: string) {
  return `<tr><td style="padding:0 0 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="rule" style="border:1px solid ${RULE};border-radius:12px;"><tr>
    <td width="36" valign="top" style="padding:16px 0 16px 16px;"><div style="width:28px;height:28px;border-radius:14px;background:${L.C.brandSoft};color:${BRAND};font-family:${FONT};font-size:14px;font-weight:800;line-height:28px;text-align:center;">${n}</div></td>
    <td valign="top" style="padding:16px 16px 16px 12px;font-family:${FONT};">
      <div class="ink" style="font-size:15px;line-height:22px;font-weight:700;color:${INK};">${title}</div>
      <div class="body" style="font-size:14px;line-height:21px;color:${BODY};padding:2px 0 6px;">${text}</div>
      <a href="${href}" class="lnk" style="font-size:14px;font-weight:700;color:${BRAND};text-decoration:none;">${cta} &rarr;</a>
    </td>
  </tr></table>
</td></tr>`;
}

// 2026-10: shared Helm layout (hosted logo, emerald, dark-mode aware). preheader is plain text.
const shell = (title: string, preheader: string, inner: string) => L.layout(title, preheader, inner);
const h1 = (t: string) => L.h1(t);
const para = (t: string, pad = "0 0 20px") => L.para(t, pad);
const footer = (t: string) => L.note(t);
const help = `Need a hand? Read the <a href="${LINKS.manual}" style="color:${BRAND};">Helm manual</a> or write to <a href="mailto:${SUPPORT}" style="color:${BRAND};">${SUPPORT}</a> — a real person replies.`;

export type Mail = { subject: string; html: string; text: string };

export function ownerEmail(opts: { name?: unknown; studio?: unknown }): Mail {
  const studio = clean(opts.studio) || "your studio";
  const first = firstName(opts.name);
  const hi = first ? `Hi ${esc(first)},` : "Hi there,";
  const html = shell("Welcome to Helm", `${studio} is ready. Three quick steps to get going.`.replace(/[<>&"']/g, ""),
    h1("Welcome to Helm") +
    para(`${hi} <strong style="color:${INK};">${esc(studio)}</strong> is set up and ready. Here are three quick steps that get most studios running in their first hour:`) +
    step(1, "Add your first lead", "Capture an enquiry — name, date, guest count — and Helm tracks it from first call to signed quote.", LINKS.leads, "Add a lead") +
    step(2, "Design a floor plan", "Lay out the venue: tables, stage, décor. Your quote and inventory follow the plan automatically.", LINKS.floorPlan, "Open the builder") +
    step(3, "Invite your team", "Bring in sales, operations and finance. Each role sees only the parts of Helm it needs.", LINKS.team, "Invite people") +
    button(LINKS.dashboard, "Go to my dashboard") +
    footer(help),
  );
  const text = [
    "Welcome to Helm",
    "",
    `${first ? "Hi " + first : "Hi there"}, ${studio} is set up and ready. Three quick steps:`,
    "",
    `1. Add your first lead: ${LINKS.leads}`,
    `2. Design a floor plan: ${LINKS.floorPlan}`,
    `3. Invite your team: ${LINKS.team}`,
    "",
    `Your dashboard: ${LINKS.dashboard}`,
    `Helm manual: ${LINKS.manual}`,
    `Questions? ${SUPPORT}`,
    "",
    "--",
    "Helm Events · helm.events",
  ].join("\n");
  return { subject: `Welcome to Helm — ${studio} is ready`, html, text };
}

export function memberEmail(opts: { name?: unknown; studio?: unknown }): Mail {
  const studio = clean(opts.studio) || "your studio";
  const first = firstName(opts.name);
  const hi = first ? `Hi ${esc(first)},` : "Hi there,";
  const html = shell("You've joined a studio on Helm", `You're now part of ${studio} on Helm.`.replace(/[<>&"']/g, ""),
    h1(`You've joined ${esc(studio)}`) +
    para(`${hi} you're now part of <strong style="color:${INK};">${esc(studio)}</strong> on Helm, the event operating system your team uses to run events end to end.`) +
    para(`Depending on the role your studio admin gave you, you can follow leads and quotes, work on floor plans, check tasks and run-sheets, and chat with your team — all in one place.`) +
    button(LINKS.signIn, "Sign in to Helm") +
    footer(`New to Helm? The <a href="${LINKS.manual}" style="color:${BRAND};">Helm manual</a> walks through every screen. If something you need is missing, ask your studio admin — they control what each role can see. Helm will never ask for your password by email.`),
  );
  const text = [
    `You've joined ${studio}`,
    "",
    `${first ? "Hi " + first : "Hi there"}, you're now part of ${studio} on Helm.`,
    "Depending on your role you can follow leads and quotes, work on floor plans, check tasks and run-sheets, and chat with your team.",
    "",
    `Sign in: ${LINKS.signIn}`,
    `Helm manual: ${LINKS.manual}`,
    "",
    "--",
    "Helm Events · helm.events",
  ].join("\n");
  return { subject: `You've joined ${studio} on Helm`, html, text };
}

export function render(kind: string, opts: { name?: unknown; studio?: unknown }): Mail | null {
  if (kind === "studio_owner") return ownerEmail(opts);
  if (kind === "member") return memberEmail(opts);
  return null;
}
