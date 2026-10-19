// quote-expiry.mjs - message for a queued "your quote is valid until ..." reminder (migration 0262, purpose
// 'quote_expiry'). Pure (no I/O); shared by comms-dispatch (Deno) and the node tests.
// The row carries the fixed greeting (body) + the date; the PATH of the client's approval link
// (<studio>/quote/<token> or approve.html?token=<token>) is added by comms_outbox_claim at hand-out time (the token is
// never stored in the outbox row); the host is always the dispatcher's APP_URL.
// Anything unexpected -> empty text, and comms-dispatch then marks the row skipped (fails closed).
export const QUOTE_PATH = /^(?:[a-z0-9-]{3,40}\/quote\/|approve\.html\?token=)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,190}(?::[0-9]{1,5})?$/;
const DMY = /^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/;
const clip = (v, n) => String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export function quoteLink(payload, origin) {
  const path = String((payload && payload.link_path) || "");
  const o = String(origin || "").replace(/\/+$/, "");
  return QUOTE_PATH.test(path) && ORIGIN.test(o) ? o + "/" + path : "";
}

// { subject, text } - "Hi <client>, your quote <code> from <studio> is valid until dd/mm/yyyy. Review and approve it here: <link>"
export function quoteExpiryMessage(payload, origin) {
  const body = clip(payload && payload.body, 260);
  const label = clip(payload && payload.valid_until_label, 12);
  const link = quoteLink(payload, origin);
  if (!DMY.test(label) || !link) return { subject: "", text: "" };
  if (!/^Hi .{1,80}, your quote .{1,40} from .{1,80} is valid until [0-9]{2}\/[0-9]{2}\/[0-9]{4}\.$/.test(body) || !body.endsWith(label + ".")) return { subject: "", text: "" };
  const studio = clip(payload && payload.studio, 60) || "your event planner";
  const d = Number(payload && payload.days_left);
  const when = d === 0 ? " Today is the last day." : d === 1 ? " Tomorrow is the last day." : "";
  return { subject: "Your quote from " + studio + " is valid until " + label,
           text: body + when + " Review and approve it here: " + link };
}
