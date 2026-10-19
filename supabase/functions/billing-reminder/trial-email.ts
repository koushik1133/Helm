// trial-email.ts — branded trial-ending e-mails for billing-reminder (0058 kinds).
// Pure (no I/O). 2026-10: shared Helm layout (_shared/email-layout.mjs), same as the
// Supabase Auth templates in docs/ops/email-templates. Every interpolated value
// is escaped; the link is always APP_URL + "/checkout" (never taken from a row).
import { escHtml } from "../_shared/cors.ts";
import * as L from "../_shared/email-layout.mjs";

export const TRIAL_KINDS = ["trial_7d", "trial_3d", "trial_1d", "trial_ended"] as const;
export type TrialKind = typeof TRIAL_KINDS[number];
// r21: the ONE retention promise (same words in the app, the trial e-mails and the policy pages)
export const RETENTION_PROMISE = "Your data is kept for 60 days after the trial ends, and we remind you before anything is deleted.";
export const isTrialKind = (k: string): k is TrialKind => (TRIAL_KINDS as readonly string[]).includes(k);


function copy(kind: TrialKind, date: string) {
  const on = date ? ` on <b>${escHtml(date)}</b>` : "";
  switch (kind) {
    case "trial_7d": return { subject: "Your Helm free trial ends in 7 days", title: "Your free trial ends in 7 days",
      pre: "Choose a plan to keep your studio running on Helm.",
      body: `Your 8-day free trial of Helm ends${on}. Choose a plan now so your team, events and clients carry on without a break.` };
    case "trial_3d": return { subject: "3 days left on your Helm free trial", title: "3 days left on your free trial",
      pre: "Your Helm trial ends soon — choose a plan.",
      body: `Your Helm free trial ends${on}. Pick a plan in a couple of minutes to keep everything you've set up.` };
    case "trial_1d": return { subject: "Your Helm free trial ends tomorrow", title: "Your free trial ends tomorrow",
      pre: "Last day to choose a plan before your trial ends.",
      body: `Your Helm free trial ends${on}. Choose a plan today to keep using Helm without interruption.` };
    default: return { subject: "Your Helm free trial has ended", title: "Your free trial has ended",
      pre: "Choose a plan to keep using Helm.",
      body: `Your Helm free trial ended${on}. ${RETENTION_PROMISE} Choose a plan to keep using Helm.` };
  }
}

export function trialMessage(kind: TrialKind, studio: string, trialEnd: string, appUrl: string) {
  const app = String(appUrl || "https://www.helm.events").replace(/\/+$/, "");
  const date = /^\d{4}-\d{2}-\d{2}/.test(trialEnd) ? trialEnd.slice(0, 10) : "";
  const c = copy(kind, date);
  const href = escHtml(app + "/checkout");
  const html = L.layout(c.title, c.pre,
    L.h1(escHtml(c.title)) +
    L.para(`Hi ${escHtml(studio)},<br>${c.body}`, "0 0 24px") +
    L.button(href, "Choose a plan") + L.fallback(href) +
    L.note("Questions about plans or billing? Reply to this e-mail. Helm will never ask for your password or card details by e-mail."));
  return { subject: c.subject, html };
}
