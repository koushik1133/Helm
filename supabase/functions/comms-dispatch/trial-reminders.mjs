// trial-reminders.mjs - e-mail copy for the 8-day free-trial reminders (migration 0120) and the
// post-trial mails of migration 0184 (the 30 / 7 / 1 day deletion warnings) and the R124 follow-ups (0333: Day 0, 2, 7, 14).
// Pure (no I/O); shared by comms-dispatch (Deno) and the node tests. The link is always
// APP_URL + "/checkout" (never taken from a row). Plain text: comms-dispatch's sendEmail
// wraps it in the branded HTML shell and escapes it; the follow-ups bring their own designed HTML.
import * as L from "../_shared/email-layout.mjs";

export const TRIAL_MILESTONES = ["d5", "d7", "d8"];
// r21: the ONE retention promise (same words in the app, billing-reminder and the policy pages; 60 days after the
// trial ends - the deletion switch helm_trial_retention.delete_enabled stays OFF until the owner turns it on)
export const RETENTION_PROMISE = "Your data is kept for 60 days after the trial ends, and we remind you before anything is deleted.";

// "Friday, 9 October, 10:00 AM" in the studio's zone; "" when the date or zone is unusable
export function endsLabel(endsAt, timeZone) {
  const d = new Date(endsAt);
  if (!endsAt || isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: timeZone || "Asia/Kolkata", weekday: "long", day: "numeric",
      month: "long", hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  } catch (e) { return ""; }
}

// 0184: while the owner has trial data deletion switched on (retention = { delete_enabled: true,
// retention_days: 60 } from trial_retention_mail_settings) the reminders say how long data is kept.
export function retentionDays(retention) {
  if (!retention || retention.delete_enabled !== true) return 0;
  const d = Math.floor(Number(retention.retention_days));
  return d >= 30 && d <= 3650 ? d : 0;
}

export function trialReminderEmail(milestone, studio, endsAt, timeZone, appUrl, retention) {
  if (!TRIAL_MILESTONES.includes(milestone)) return null;
  const app = String(appUrl || "https://www.helm.events").replace(/\/+$/, "");
  const when = endsLabel(endsAt, timeZone);
  const on = when ? " on " + when : "";
  const hi = "Hi " + (String(studio || "").trim().slice(0, 80) || "there") + ",";
  const keep = retentionDays(retention);
  const after = keep
    ? "When the trial ends your studio becomes view-only. Your events, clients and settings are kept for " + keep + " days after the trial ends and everything unlocks again as soon as you choose a plan. After that, trial data is permanently deleted."
    : "When the trial ends your studio becomes view-only. " + RETENTION_PROMISE + " Everything unlocks again as soon as you choose a plan.";
  const cta = "Choose a plan: " + app + "/checkout";
  const sign = "Your 8-day free trial needs no card, so nothing is charged unless you choose a plan.\n\n- The Helm team";
  const c = {
    d5: { subject: "3 days left in your Helm free trial",
          lead: "There are 3 days left in your 8-day Helm free trial. It ends" + on + "." },
    d7: { subject: "Your Helm free trial ends tomorrow",
          lead: "Your 8-day Helm free trial ends tomorrow" + (when ? " (" + when + ")" : "") + "." },
    d8: { subject: "Your Helm free trial ends today",
          lead: "Your trial ends today" + (when ? " (" + when + ")" : "") + ". This is the last day of your 8-day Helm free trial." },
  }[milestone];
  return { subject: c.subject, text: [hi, c.lead, after, cta, sign].join("\n\n") };
}

// ---- 0184: post-trial mails ---------------------------------------------------------------------------
// x0 / x2 / x7 / x14   R124 (0333): the follow-up series after the trial ended, x7 replaces the old single +7 e-mail
//        (non-transactional: Helm unsubscribe applies, Day 0 too)
// del30 / del7 / del1   the deletion warnings 30, 7 and 1 day before the trial data is permanently deleted
//        (service notices: transactional footer, always sent while deletion is switched on)
export const FOLLOWUP_KINDS = ["x0", "x2", "x7", "x14"];
export const RETENTION_KINDS = [...FOLLOWUP_KINDS, "del30", "del7", "del1"];
export const RETENTION_NOTICE_KINDS = ["del30", "del7", "del1"];
export const RETENTION_TX_REASON = "you own a studio on Helm whose free trial has ended and its trial data is due to be deleted";

// "2026-12-09" (already the studio's own calendar day) -> "09/12/2026"; "" when unusable
export function ddmmyyyy(isoDate) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(String(isoDate || "").trim());
  if (!m) return "";
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return "";
  return m[3] + "/" + m[2] + "/" + m[1];
}

// the owner's sentence (docs/trial/POST-TRIAL-POLICY.md item 3), word for word
export function deletionSentence(dmy) {
  return "Your trial data is scheduled for permanent deletion on " + dmy + ". Upgrade now to retain access and continue using your studio.";
}

// "9 October 2026" - the trial's last day in the studio's zone ("" when unusable)
export function lastDayLabel(expiredAt, timeZone) {
  const d = new Date(expiredAt);
  if (!expiredAt || isNaN(d.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-GB", { timeZone: timeZone || "Asia/Kolkata", day: "numeric", month: "long", year: "numeric" })
      .format(new Date(d.getTime() - 1));
  } catch (e) { return ""; }
}

// info = { deleteOn: "YYYY-MM-DD" | "", expiredAt, timeZone, retentionDays }
export function trialRetentionEmail(kind, studio, info, appUrl) {
  if (!RETENTION_KINDS.includes(kind)) return null;
  if (FOLLOWUP_KINDS.includes(kind)) return trialFollowupEmail(kind, studio, info, appUrl);
  const i = info || {};
  const app = String(appUrl || "https://www.helm.events").replace(/\/+$/, "");
  const hi = "Hi " + (String(studio || "").trim().slice(0, 80) || "there") + ",";
  const del = ddmmyyyy(i.deleteOn);
  const sign = "- The Helm team";
  if (!del) return null;   // a deletion warning always names the date
  const c = {
    del30: { subject: "Your Helm trial data will be deleted on " + del, lead: "" },
    del7: { subject: "Reminder: your Helm trial data will be deleted on " + del, lead: "About one week is left. " },
    del1: { subject: "Final notice: your Helm trial data will be deleted tomorrow (" + del + ")", lead: "This is the final notice: the deletion is tomorrow. " },
  }[kind];
  const what = c.lead + "On that date the studio's events, quotes, leads, clients, inventory, vendors, staff and layouts are permanently removed and cannot be recovered. Until then everything stays available in read-only mode.";
  return { subject: c.subject, text: [hi, deletionSentence(del), what, "Upgrade now: " + app + "/checkout", sign].join("\n\n") };
}

// ---- R124 (0333): the follow-up series -------------------------------------------------------------------
// Replies come to a real inbox: Day 7 invites questions, Day 14 asks for feedback.
export const FOLLOWUP_REPLY_TO = "support@helm.events";
export const FOLLOWUP_REASON = "you started a free trial of Helm";
// the footer (with Unsubscribe) belongs inside the card, not under the page: see placeFooter
export const FOOTER_SLOT = "<!--helm-footer-->";

// the studio name for a subject line or a sentence: one line, no control characters
const oneLine = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

// the rows of copy, one place, so the HTML and the plain text can never say different things
function followupCopy(kind, name, Name, keptTo, app) {
  const url = app + "/checkout";
  return {
    x0: { subject: "Your Helm free trial has ended. " + Name + " is safe.", head: Name + " is safe",
          pre: "Nothing is lost. Your data is saved and you can still sign in.",
          lines: ["Your Helm free trial has ended, and nothing is lost. Everything in " + name + " is saved.",
                  "You can still sign in and look at it whenever you like. " + (keptTo ? "Your data is kept until " + keptTo + "." : RETENTION_PROMISE)],
          cta: "Choose a plan", url },
    x2: { subject: Name + " is waiting for you", head: Name + " is waiting for you",
          pre: "On a plan, it all goes live.",
          lines: ["You've seen how Helm works. On a plan, it all goes live:"],
          list: ["Your client approves online with a one-time code.",
                 "Booklets and invitations reach real clients and guests.",
                 "Downloads, branding and your own templates unlock."],
          after: ["The plan goes on " + name + ", so everything you set up stays."],
          cta: "Create your studio", url },
    x7: { subject: "One place for your next event", head: "One place for your next event",
          pre: "Your studio is ready and your work is still there.",
          lines: ["Enquiry, quote, layout, team, payments and profit, all together in Helm.",
                  Name + " is ready and your work is still there.",
                  "Any questions about plans? Just reply to this e-mail."],
          cta: "See plans", url },
    x14: { subject: "Should we keep " + name + " for you?", head: "Should we keep " + name + " for you?",
           pre: "This is our last reminder.",
           lines: ["This is our last reminder about a plan, and we won't keep writing about it.",
                   keptTo ? "Your data stays until " + keptTo + "." : RETENTION_PROMISE,
                   "If Helm wasn't right for you, could you reply with one line telling us why? It really helps."],
           cta: "Keep my studio", url },
  }[kind];
}

const bullets = (items) => `<tr><td class="body" style="padding:0 0 20px;font-family:${L.FONT};font-size:15px;line-height:24px;color:${L.C.body};">
<ul style="margin:0;padding:0 0 0 20px;">${items.map((t) => `<li style="margin:0 0 8px;">${L.escHtml(t)}</li>`).join("")}</ul></td></tr>`;

// info = { deleteOn: "YYYY-MM-DD" | "" }. Returns { subject, text, html }. The date is named only when one exists.
export function trialFollowupEmail(kind, studio, info, appUrl) {
  if (!FOLLOWUP_KINDS.includes(kind)) return null;
  const app = String(appUrl || "https://www.helm.events").replace(/\/+$/, "");
  const clean = oneLine(studio);
  const name = clean || "your studio", Name = clean || "Your studio";
  const c = followupCopy(kind, name, Name, ddmmyyyy((info || {}).deleteOn), app);
  const after = c.after || [];
  const text = ["Hi " + (clean || "there") + ",", ...c.lines, ...(c.list ? [c.list.map((t) => "- " + t).join("\n")] : []), ...after,
    c.cta + ": " + c.url, "- The Helm team"].join("\n\n");
  const href = L.escHtml(c.url);
  const html = L.layout(c.subject, c.pre,
    L.h1(L.escHtml(c.head)) +
    c.lines.map((t) => L.para(L.escHtml(t))).join("") +
    (c.list ? bullets(c.list) : "") +
    after.map((t) => L.para(L.escHtml(t))).join("") +
    L.button(href, L.escHtml(c.cta)) + L.fallback(href) +
    `<tr><td style="font-family:${L.FONT};">${FOOTER_SLOT}</td></tr>`);
  return { subject: c.subject, text, html };
}

// the compliance footer goes into the card. The mailer sees "You received this because" and adds only the text footer.
export function placeFooter(html, footer) {
  return String(html).split(FOOTER_SLOT).join(footer.html);
}
