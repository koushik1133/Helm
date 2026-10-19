// vendor-request.mjs - the e-mail for one claimed vendor request / reminder (migration 0256,
// vendor_request_claim with channel 'email'). Pure (no I/O); shared by comms-dispatch (Deno) and the node tests.
// Each row carries a fresh 64-hex link token minted by the claim (only its sha-256 is stored); the link is
// APP_URL + "/vendor-request?t=" + token - the host never comes from the database. Anything unexpected ->
// empty text, and comms-dispatch then marks the row skipped (fails closed). No money in the e-mail.
export const VENDOR_TOKEN = /^[0-9a-f]{64}$/;
export const VENDOR_TX_REASON = "a studio on Helm sent you a vendor request for an event";
const ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,190}(?::[0-9]{1,5})?$/;
const WHEN = /^[0-9]{2}\/[0-9]{2}\/[0-9]{4}, [0-9]{2}:[0-9]{2} [AP]M$/;
const DATE = /^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/;
const clip = (v, n) => String(v == null ? "" : v).replace(/[\r\n\t<>]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export function vendorRequestLink(row, origin) {
  const o = String(origin || "").replace(/\/+$/, "");
  if (!ORIGIN.test(o) || !row || !VENDOR_TOKEN.test(String(row.token || ""))) return "";
  return o + "/vendor-request?t=" + row.token;
}

// { subject, text } for one claimed row; "" text = do not send
export function vendorRequestMessage(row, origin) {
  if (!row || row.channel !== "email" || (row.kind !== "request" && row.kind !== "reminder")) return { subject: "", text: "" };
  const what = clip(row.what, 200), when = clip(row.when_text, 30), by = clip(row.respond_by_text, 30);
  const studio = clip(row.studio, 80) || "your event planner", event = clip(row.event, 120) || "the event";
  const date = clip(row.event_date, 12), who = clip(row.vendor_name, 120);
  const link = vendorRequestLink(row, origin);
  if (!what || !WHEN.test(when) || !link) return { subject: "", text: "" };
  const qty = Number(row.qty) > 0 ? " x" + Number(row.qty).toLocaleString("en-IN") : "";
  const item = what + qty, evLine = event + (DATE.test(date) ? " on " + date : "");
  const reply = WHEN.test(by) ? " Please reply by " + by + "." : "";
  return {
    subject: (row.kind === "reminder" ? "Reminder: " : "") + "Request from " + studio + ": " + item + " for " + event + " (" + when + ")",
    text: "Hello" + (who ? " " + who : "") + ",\n\n" +
      studio + (row.kind === "reminder" ? " is still waiting for your answer: " : " would like to book you: ") + item + " for " + evLine +
      ", needed " + when + "." + reply + "\n\n" +
      "See the details and the agreed amount, then Accept or Decline - one tap, no sign-in:\n" + link + "\n\n" +
      "After the work you can send your tax invoice from the same link.\n\n" +
      "Thank you,\n" + studio,
  };
}
