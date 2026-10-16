// trial-reminders.mjs - e-mail copy for the 8-day free-trial reminders (migration 0120).
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

export function trialReminderEmail(milestone, studio, endsAt, timeZone, appUrl) {
  if (!TRIAL_MILESTONES.includes(milestone)) return null;
  const app = String(appUrl || "https://www.helm.events").replace(/\/+$/, "");
  const when = endsLabel(endsAt, timeZone);
  const on = when ? " on " + when : "";
  const hi = "Hi " + (String(studio || "").trim().slice(0, 80) || "there") + ",";
  const after = "When the trial ends your studio becomes view-only. Nothing is deleted: your events, clients and settings stay exactly as they are, and everything unlocks again as soon as you choose a plan.";
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
