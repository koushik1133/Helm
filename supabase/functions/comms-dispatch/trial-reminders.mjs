// trial-reminders.mjs - e-mail copy for the 8-day free-trial reminders (migration 0120) and the
// post-trial mails of migration 0184 (7 days after the trial ended + the 30 / 7 / 1 day deletion warnings).
// Pure (no I/O); shared by comms-dispatch (Deno) and the node tests. The link is always
// APP_URL + "/checkout" (never taken from a row). Plain text: comms-dispatch's sendEmail
// wraps it in the branded HTML shell and escapes it.
export const TRIAL_MILESTONES = ["d5", "d7", "d8"];

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
    : "When the trial ends your studio becomes view-only. Nothing is deleted: your events, clients and settings stay exactly as they are, and everything unlocks again as soon as you choose a plan.";
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
// x7     one upgrade reminder 7 days after the trial ended (non-transactional: Helm unsubscribe applies)
// del30 / del7 / del1   the deletion warnings 30, 7 and 1 day before the trial data is permanently deleted
//        (service notices: transactional footer, always sent while deletion is switched on)
export const RETENTION_KINDS = ["x7", "del30", "del7", "del1"];
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
  const i = info || {};
  const app = String(appUrl || "https://www.helm.events").replace(/\/+$/, "");
  const hi = "Hi " + (String(studio || "").trim().slice(0, 80) || "there") + ",";
  const del = ddmmyyyy(i.deleteOn);
  const days = Math.floor(Number(i.retentionDays)) >= 30 ? Math.floor(Number(i.retentionDays)) : 60;
  const sign = "- The Helm team";
  if (kind === "x7") {
    const ended = lastDayLabel(i.expiredAt, i.timeZone);
    const lines = [hi,
      "Your Helm free trial ended a week ago" + (ended ? " (" + ended + ")" : "") + ". Your data is preserved and available in read-only mode: you can still sign in and view your studio.",
      ...(del ? ["Trial data is kept for " + days + " days after the trial ends. " + deletionSentence(del)] : []),
      "Upgrade now to continue creating and editing records: " + app + "/checkout",
      sign];
    return { subject: "Your Helm free trial has ended - upgrade to keep going", text: lines.join("\n\n") };
  }
  if (!del) return null;   // a deletion warning always names the date
  const c = {
    del30: { subject: "Your Helm trial data will be deleted on " + del, lead: "" },
    del7: { subject: "Reminder: your Helm trial data will be deleted on " + del, lead: "About one week is left. " },
    del1: { subject: "Final notice: your Helm trial data will be deleted tomorrow (" + del + ")", lead: "This is the final notice: the deletion is tomorrow. " },
  }[kind];
  const what = c.lead + "On that date the studio's events, quotes, leads, clients, inventory, vendors, staff and layouts are permanently removed and cannot be recovered. Until then everything stays available in read-only mode.";
  return { subject: c.subject, text: [hi, deletionSentence(del), what, "Upgrade now: " + app + "/checkout", sign].join("\n\n") };
}
