// booklet-link.mjs - message for a queued "Send to client" booklet link (migration 0200, purpose
// 'booklet_link'). Pure (no I/O); shared by comms-dispatch (Deno) and the node tests.
// The row carries the fixed greeting (body) + the expiry date; the PATH of the public link
// (<studio>/booklet/<token> or booklet?t=<token>) is added by comms_outbox_claim at hand-out time
// (the token is never stored in the outbox row); the host is always the dispatcher's APP_URL.
// Anything unexpected -> empty text, and comms-dispatch then marks the row skipped (fails closed).
export const BOOKLET_PATH = /^(?:[a-z0-9-]{3,40}\/booklet\/|booklet\?t=)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,190}(?::[0-9]{1,5})?$/;
const UNTIL = /^[0-9]{1,2} [A-Z][a-z]{2} [0-9]{4}$/;
const clip = (v, n) => String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export function bookletLink(payload, origin) {
  const path = String((payload && payload.link_path) || "");
  const o = String(origin || "").replace(/\/+$/, "");
  return BOOKLET_PATH.test(path) && ORIGIN.test(o) ? o + "/" + path : "";
}

// { subject, text } - text = "Hi <client>, here is your event booklet from <studio>: <link> (valid until <date>)"
export function bookletMessage(payload, origin) {
  const body = clip(payload && payload.body, 240);
  const link = bookletLink(payload, origin);
  if (!body || !/^Hi .{1,80}, here is your event booklet from .{1,80}:$/.test(body) || !link) return { subject: "", text: "" };
  const until = clip(payload && payload.valid_until, 20);
  const studio = clip(payload && payload.studio, 60);
  return { subject: "Your event booklet from " + (studio || "your event planner"),
           text: body + " " + link + (UNTIL.test(until) ? " (valid until " + until + ")" : "") };
}
