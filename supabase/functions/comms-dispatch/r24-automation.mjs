// r24-automation.mjs - the e-mails for migration 0269. Pure (no I/O); shared by comms-dispatch (Deno) and the node tests.
//   * runsheetReminderMessage: one claimed run-sheet reminder (runsheet_reminder_claim) - "In 15 min: Cake cutting at
//     7:30 pm (Main hall)". The only link is APP_URL + /runsheet.html?quote=<event id> (the host never comes from the
//     database; a vendor / staff member without a login simply ignores it - the message itself has everything).
//   * enquiryReplyMessage: the instant thank-you to someone who used a studio's public enquiry form
//     (enquiry_reply_claim) - the studio's own words, already filled in by the database. No link, no data read back.
// Anything unexpected -> empty text, and comms-dispatch then marks the row skipped (fails closed).
export const RUNSHEET_TX_REASON = "you are the owner of an item on an event run-sheet";
export const ENQUIRY_TX_REASON = "you sent an enquiry to this studio through its enquiry form";
const ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,190}(?::[0-9]{1,5})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/;
const TIME = /^[0-9]{1,2}:[0-9]{2} [ap]m$/;
const clip = (v, n) => String(v == null ? "" : v).replace(/[\r\n\t<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export function runsheetLink(row, origin) {
  const o = String(origin || "").replace(/\/+$/, "");
  if (!ORIGIN.test(o) || !row || !UUID.test(String(row.quote_id || ""))) return "";
  return o + "/runsheet.html?quote=" + row.quote_id;
}

// { subject, text } for one claimed run-sheet reminder; "" text = do not send
export function runsheetReminderMessage(row, origin) {
  if (!row) return { subject: "", text: "" };
  const title = clip(row.title, 160), time = clip(row.time_text, 10), text = clip(row.text, 400);
  const studio = clip(row.studio, 80) || "your studio", event = clip(row.event, 120) || "the event";
  const date = clip(row.event_date, 12), who = clip(row.name, 80), place = clip(row.location, 80);
  const link = runsheetLink(row, origin);
  if (!title || !TIME.test(time) || !text || !link) return { subject: "", text: "" };
  const m = Math.round(Number(row.offset_min));
  const soon = Number.isFinite(m) && m > 0 ? (m % 60 === 0 ? "in " + (m / 60) + (m === 60 ? " hour" : " hours") : "in " + m + " min") : "now";
  return {
    subject: (soon === "now" ? "Starting now: " : "Reminder: ") + title + " at " + time + " - " + event,
    text: "Hello" + (who ? " " + who : "") + ",\n\n" +
      "A reminder from " + studio + ": " + title + " starts " + (soon === "now" ? "now" : soon) + ", at " + time +
      (place ? " (" + place + ")" : "") + ", for " + event + (DATE.test(date) ? " on " + date : "") + ".\n\n" +
      "You are down as the owner of this item on the run-sheet. See the full run-sheet:\n" + link + "\n\n" +
      "Thank you,\n" + studio,
  };
}

// { subject, text } for one claimed enquiry reply; "" text = do not send
export function enquiryReplyMessage(row) {
  if (!row) return { subject: "", text: "" };
  const studio = clip(row.studio, 80), body = String(row.text == null ? "" : row.text).replace(/[<>]+/g, " ").replace(/\r/g, "").trim().slice(0, 800);
  if (!studio || !body) return { subject: "", text: "" };
  return { subject: "Thank you for your enquiry - " + studio, text: body + "\n\n" + studio };
}
