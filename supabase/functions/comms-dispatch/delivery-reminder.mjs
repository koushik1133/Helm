// delivery-reminder.mjs - the e-mail for one claimed delivery / arrival reminder (migration 0241,
// delivery_reminder_claim). Pure (no I/O); shared by comms-dispatch (Deno) and the node tests.
// The vendor / staff row ('party') carries a fresh 64-hex status token minted by the claim (only its
// sha-256 is stored); the link is APP_URL + "/delivery?t=" + token - the host never comes from the
// database. The scheduler's copy ('cc') links to the event-day command page by the event id.
// Anything unexpected -> empty text, and comms-dispatch then marks the row skipped (fails closed).
export const DELIVERY_TOKEN = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,190}(?::[0-9]{1,5})?$/;
const DUE = /^[0-9]{2}\/[0-9]{2}\/[0-9]{4}, [0-9]{2}:[0-9]{2} [AP]M$/;
const DATE = /^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/;
const clip = (v, n) => String(v == null ? "" : v).replace(/[\r\n\t<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export function deliveryLink(row, origin) {
  const o = String(origin || "").replace(/\/+$/, "");
  if (!ORIGIN.test(o) || !row) return "";
  if (row.kind === "party") return DELIVERY_TOKEN.test(String(row.token || "")) ? o + "/delivery?t=" + row.token : "";
  if (row.kind === "cc") return UUID.test(String(row.quote_id || "")) ? o + "/command.html?quote=" + row.quote_id : "";
  return "";
}

// "in 1 hour" / "in 30 minutes" / "now"
export function whenText(min) {
  const m = Math.round(Number(min));
  if (!Number.isFinite(m) || m <= 0) return "now";
  if (m % 60 === 0) return "in " + (m / 60) + (m === 60 ? " hour" : " hours");
  return "in " + m + (m === 1 ? " minute" : " minutes");
}

// { subject, text } for one claimed row; "" text = do not send
export function deliveryMessage(row, origin) {
  if (!row || (row.kind !== "party" && row.kind !== "cc")) return { subject: "", text: "" };
  const what = clip(row.what, 200), due = clip(row.due_text, 30), studio = clip(row.studio, 80) || "your event planner";
  const event = clip(row.event, 120) || "the event", date = clip(row.event_date, 12), who = clip(row.party_name, 120);
  const link = deliveryLink(row, origin);
  if (!what || !DUE.test(due) || !link) return { subject: "", text: "" };
  const qty = Number(row.qty) > 0 ? " x" + Number(row.qty).toLocaleString("en-IN") : "";
  const item = what + qty;
  const evLine = event + (DATE.test(date) ? " on " + date : "");
  const when = whenText(row.offset_min);
  if (row.kind === "party") {
    return {
      subject: (when === "now" ? "Due now: " : "Reminder: ") + item + " for " + event + " - due " + due,
      text: "Hello" + (who ? " " + who : "") + ",\n\n" +
        "This is a reminder from " + studio + ": " + item + " for " + evLine + " is due " + (when === "now" ? "now" : when) + " (" + due + ").\n\n" +
        "Please tell us where things stand - one tap, no sign-in:\n" + link + "\n\n" +
        "Choose On the way, Arrived, Delayed (with a new time) or Problem, and add a short note if needed.\n\n" +
        "Thank you,\n" + studio,
    };
  }
  return {
    subject: "Delivery check: " + item + " (" + (who || "vendor") + ") due " + due,
    text: "Reminder (" + when + "): " + item + " from " + (who || "the responsible person") + " for " + evLine + " is due " + due + ".\n" +
      "They have been asked to confirm. Live status on the event-day board:\n" + link,
  };
}
