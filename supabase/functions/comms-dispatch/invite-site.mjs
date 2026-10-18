// invite-site.mjs - message for a queued "Send to client" invitation link (migration 0195, purpose
// 'invite_site'). Pure (no I/O); shared by comms-dispatch (Deno) and the node tests.
// The row carries the fixed greeting (body) and the PATH of the public link (i/<slug> or
// <studio>/invite/<slug>); the host is always the dispatcher's APP_URL, never taken from a row.
// Anything unexpected -> empty text, and comms-dispatch then marks the row skipped (fails closed).
export const INVITE_PATH = /^(?:i|[a-z0-9-]{3,40}\/invite)\/[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;
const ORIGIN = /^https:\/\/[A-Za-z0-9.-]{1,190}(?::[0-9]{1,5})?$/;
const clip = (v, n) => String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export function inviteLink(payload, origin) {
  const path = String((payload && payload.link_path) || "");
  const o = String(origin || "").replace(/\/+$/, "");
  return INVITE_PATH.test(path) && ORIGIN.test(o) ? o + "/" + path : "";
}

// { subject, text } - text = "Hi <client>, here is your invitation website: <link>"
export function inviteSiteMessage(payload, origin) {
  const body = clip(payload && payload.body, 200);
  const link = inviteLink(payload, origin);
  if (!body || !/^Hi .{1,80}, here is your invitation website:$/.test(body) || !link) return { subject: "", text: "" };
  const studio = clip(payload && payload.studio, 60);
  return { subject: "Your invitation website from " + (studio || "your planner"), text: body + " " + link };
}
