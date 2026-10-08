// welcome-mailer templates (migration 0057). Light-only, table-based, inline-CSS HTML that
// matches docs/email-templates (purple #6C4CF1, white card on #f6f4f1). No dark-mode rules,
// no external images, no tracking. Every dynamic value is HTML-escaped. All links are FIXED
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

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";
const INK = "#1b1930", BODY = "#4b475f", MUTED = "#6b6577", FAINT = "#8b8698", RULE = "#e8e3db", BRAND = "#6C4CF1";

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

// trim + collapse whitespace + cap length (studio / person names are user-entered)
const clean = (s: unknown, max = 80) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const firstName = (s: unknown) => clean(s, 60).split(" ")[0] || "";

function button(href: string, label: string) {
  return `<tr><td align="center" style="padding:8px 0 24px;">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${href}" style="height:48px;v-text-anchor:middle;width:260px;" arcsize="20%" fillcolor="${BRAND}" stroke="f"><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:16px;font-weight:bold;">${label}</center></v:roundrect><![endif]-->
<!--[if !mso]><!--><a href="${href}" class="btn" style="display:inline-block;background:${BRAND};color:#ffffff;font-family:${FONT};font-size:16px;font-weight:700;line-height:48px;height:48px;padding:0 32px;border-radius:10px;text-decoration:none;">${label}</a><!--<![endif]-->
</td></tr>`;
}

function step(n: number, title: string, text: string, href: string, cta: string) {
  return `<tr><td style="padding:0 0 14px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${RULE};border-radius:12px;"><tr>
    <td width="36" valign="top" style="padding:16px 0 16px 16px;"><div style="width:28px;height:28px;border-radius:14px;background:#efeafe;color:${BRAND};font-family:${FONT};font-size:14px;font-weight:800;line-height:28px;text-align:center;">${n}</div></td>
    <td valign="top" style="padding:16px 16px 16px 12px;font-family:${FONT};">
      <div style="font-size:15px;line-height:22px;font-weight:700;color:${INK};">${title}</div>
      <div style="font-size:14px;line-height:21px;color:${BODY};padding:2px 0 6px;">${text}</div>
      <a href="${href}" style="font-size:14px;font-weight:700;color:${BRAND};text-decoration:none;">${cta} &rarr;</a>
    </td>
  </tr></table>
</td></tr>`;
}

function shell(title: string, preheader: string, inner: string) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light">
<title>${title}</title>
<style>
  :root{color-scheme:light only;supported-color-schemes:light;}
  @media (max-width:600px){ .container{width:100%!important} .px{padding-left:20px!important;padding-right:20px!important} .btn{display:block!important} }
</style>
</head>
<body style="margin:0;padding:0;background:#f6f4f1;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${preheader}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f4f1;">
<tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" class="container" style="width:560px;max-width:560px;">
<tr><td style="padding:0 0 20px;" align="left">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
    <td width="32" height="32" style="width:32px;height:32px;background:${BRAND};border-radius:8px;" align="center" valign="middle"><div style="width:14px;height:14px;border:2px solid #ffffff;border-radius:3px;font-size:0;line-height:0;">&nbsp;</div></td>
    <td style="padding-left:10px;font-family:${FONT};font-size:18px;font-weight:800;letter-spacing:-.01em;color:${INK};">Helm<span style="color:${BRAND};">.</span></td>
  </tr></table>
</td></tr>
<tr><td class="px" style="background:#ffffff;border:1px solid ${RULE};border-radius:16px;padding:36px 40px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
${inner}
</table>
</td></tr>
<tr><td align="center" style="padding:20px 8px 0;font-family:${FONT};font-size:12px;line-height:18px;color:${FAINT};">
Helm Events · <a href="${SITE}" style="color:${FAINT};text-decoration:underline;">helm.events</a><br>Run every event, end to end.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

const h1 = (t: string) => `<tr><td style="padding:0 0 12px;font-family:${FONT};font-size:24px;line-height:30px;font-weight:800;color:${INK};">${t}</td></tr>`;
const para = (t: string, pad = "0 0 20px") => `<tr><td style="padding:${pad};font-family:${FONT};font-size:15px;line-height:24px;color:${BODY};">${t}</td></tr>`;
const footer = (t: string) => `<tr><td style="border-top:1px solid ${RULE};padding:18px 0 0;font-family:${FONT};font-size:13px;line-height:20px;color:${MUTED};">${t}</td></tr>`;
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
    "Helm Events · helm.events",
  ].join("\n");
  return { subject: `You've joined ${studio} on Helm`, html, text };
}

export function render(kind: string, opts: { name?: unknown; studio?: unknown }): Mail | null {
  if (kind === "studio_owner") return ownerEmail(opts);
  if (kind === "member") return memberEmail(opts);
  return null;
}
