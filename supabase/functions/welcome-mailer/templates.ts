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
  trialTerms: `${SITE}/terms#trial`,
  choosePlan: `${SITE}/checkout`,
};

// R119: the free-trial facts the trial welcome states. MIRRORS public/trial-facts.js (DAYS, CREATE_CAP, TEAM_EXTRA,
// REGION) - test/r119-welcome-emails.test.mjs fails if the two ever drift apart.
export const TRIAL = { DAYS: 8, CREATE_CAP: 2, TEAM_EXTRA: 2, TEST_CODE: "000000", TZ: "Asia/Kolkata", TZ_LABEL: "IST" };

// "Mon, 9 Nov 2026, 12:00 am IST" - the trial end in India time; "" for a missing / unreadable date
export function trialEndIST(v: unknown): string {
  const t = Date.parse(String(v ?? ""));
  if (!Number.isFinite(t)) return "";
  try {
    const d = new Date(t);
    const day = new Intl.DateTimeFormat("en-GB", { timeZone: TRIAL.TZ, weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(d);
    const time = new Intl.DateTimeFormat("en-US", { timeZone: TRIAL.TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(d).toLowerCase();
    return `${day}, ${time} ${TRIAL.TZ_LABEL}`;
  } catch (_) { return ""; }
}

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

export function memberEmail(opts: { name?: unknown; studio?: unknown }, trialNote = ""): Mail {
  const studio = clean(opts.studio) || "your studio";
  const first = firstName(opts.name);
  const hi = first ? `Hi ${esc(first)},` : "Hi there,";
  const html = shell("You've joined a studio on Helm", `You're now part of ${studio} on Helm.`.replace(/[<>&"']/g, ""),
    h1(`You've joined ${esc(studio)}`) +
    para(`${hi} you're now part of <strong style="color:${INK};">${esc(studio)}</strong> on Helm, the event operating system your team uses to run events end to end.`) +
    para(`Depending on the role your studio admin gave you, you can follow leads and quotes, work on floor plans, check tasks and run-sheets, and chat with your team — all in one place.`) +
    (trialNote ? para(esc(trialNote)) : "") +
    button(LINKS.signIn, "Sign in to Helm") +
    footer(`New to Helm? The <a href="${LINKS.manual}" style="color:${BRAND};">Helm manual</a> walks through every screen. If something you need is missing, ask your studio admin — they control what each role can see. Helm will never ask for your password by email.`),
  );
  const text = [
    `You've joined ${studio}`,
    "",
    `${first ? "Hi " + first : "Hi there"}, you're now part of ${studio} on Helm.`,
    "Depending on your role you can follow leads and quotes, work on floor plans, check tasks and run-sheets, and chat with your team.",
    "",
    ...(trialNote ? [trialNote, ""] : []),
    `Sign in: ${LINKS.signIn}`,
    `Helm manual: ${LINKS.manual}`,
    "",
    "--",
    "Helm Events · helm.events",
  ].join("\n");
  return { subject: `You've joined ${studio} on Helm`, html, text };
}

// ---- R119: the studio is on its FREE TRIAL -------------------------------------------------------------------
// Plain words, the same rules as the agreed trial terms (public/trial-facts.js 0325): 8 days, sample data, simulation
// (nothing reaches clients, test code 000000, TEST payments), limits, what is locked, read-only afterwards.
export type WelcomeOpts = { name?: unknown; studio?: unknown; trial?: unknown; trialEndsAt?: unknown };

const bullets = (items: string[]) => `<tr><td class="body" style="padding:0 0 20px;font-family:${FONT};font-size:15px;line-height:24px;color:${BODY};">
<ul style="margin:0;padding:0 0 0 20px;">${items.map((t) => `<li style="margin:0 0 8px;">${t}</li>`).join("")}</ul></td></tr>`;
const h2 = (t: string) => `<tr><td class="ink" style="padding:4px 0 8px;font-family:${FONT};font-size:17px;line-height:24px;font-weight:700;color:${INK};">${t}</td></tr>`;

export const TRIAL_POINTS = {
  sample: `Your studio starts with sample data so you can try everything at once. Every sample record is marked "Demo" or "Sample" - sample contacts are not real people.`,
  simulation: `The trial is a simulation: nothing is sent to your clients. Approval, booklet and invitation links show you a preview of what the client would get. The client approves with the test code ${TRIAL.TEST_CODE}, and payments are simulated (TEST receipts, no real money).`,
  limits: `You can add up to ${TRIAL.CREATE_CAP} new records in each list (leads, events and quotes, inventory, vendors, staff, venues) - sample records do not count - and invite up to ${TRIAL.TEAM_EXTRA} teammates (you + ${TRIAL.TEAM_EXTRA}).`,
  locked: `Locked until you choose a plan: downloads, prints and exports, photo renders, and WhatsApp, SMS and online payment links.`,
  after: `When the trial ends your studio becomes read-only: you and your team can still sign in and look, but nothing can be added or changed. Choose a plan any time to keep going.`,
};

export function ownerTrialEmail(opts: WelcomeOpts): Mail {
  const studio = clean(opts.studio) || "your studio";
  const first = firstName(opts.name);
  const hi = first ? `Hi ${esc(first)},` : "Hi there,";
  const ends = trialEndIST(opts.trialEndsAt);
  const endsLine = ends ? ` It ends on <strong style="color:${INK};">${esc(ends)}</strong>.` : "";
  const html = shell("Welcome to your Helm free trial", `${studio} is ready - your ${TRIAL.DAYS}-day free trial has started.`.replace(/[<>&"']/g, ""),
    h1("Welcome to your free trial") +
    para(`${hi} <strong style="color:${INK};">${esc(studio)}</strong> is set up and your <strong style="color:${INK};">${TRIAL.DAYS}-day free trial</strong> has started - no card needed.${endsLine}`) +
    h2("How the trial works") +
    bullets([TRIAL_POINTS.sample, TRIAL_POINTS.simulation, TRIAL_POINTS.limits, TRIAL_POINTS.locked, TRIAL_POINTS.after].map((t) => esc(t))) +
    button(LINKS.dashboard, "Go to my dashboard") +
    para(`Read the full <a href="${LINKS.trialTerms}" style="color:${BRAND};">free-trial terms</a> or <a href="${LINKS.choosePlan}" style="color:${BRAND};">choose a plan</a> whenever you are ready.`) +
    footer(help),
  );
  const text = [
    "Welcome to your Helm free trial",
    "",
    `${first ? "Hi " + first : "Hi there"}, ${studio} is set up and your ${TRIAL.DAYS}-day free trial has started - no card needed.${ends ? " It ends on " + ends + "." : ""}`,
    "",
    "How the trial works:",
    "- " + TRIAL_POINTS.sample,
    "- " + TRIAL_POINTS.simulation,
    "- " + TRIAL_POINTS.limits,
    "- " + TRIAL_POINTS.locked,
    "- " + TRIAL_POINTS.after,
    "",
    `Your dashboard: ${LINKS.dashboard}`,
    `Free-trial terms: ${LINKS.trialTerms}`,
    `Choose a plan: ${LINKS.choosePlan}`,
    `Questions? ${SUPPORT}`,
    "",
    "--",
    "Helm Events · helm.events",
  ].join("\n");
  return { subject: `Welcome to Helm — your ${TRIAL.DAYS}-day free trial of ${studio} has started`, html, text };
}

export const MEMBER_TRIAL_NOTE = `This studio is on a Helm free trial: it runs on sample data marked "Demo" or "Sample", and nothing is sent to clients - links show a preview and payments are simulated.`;

export function memberTrialEmail(opts: WelcomeOpts): Mail {
  return memberEmail(opts, MEMBER_TRIAL_NOTE);
}

export function render(kind: string, opts: WelcomeOpts): Mail | null {
  const trial = opts.trial === true;
  if (kind === "studio_owner") return trial ? ownerTrialEmail(opts) : ownerEmail(opts);
  if (kind === "member") return trial ? memberTrialEmail(opts) : memberEmail(opts);
  return null;
}
