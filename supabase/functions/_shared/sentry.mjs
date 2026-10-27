// _shared/sentry.mjs - r26: OPTIONAL error alerts from the edge functions to Sentry. OFF unless the Supabase secret
// SENTRY_DSN is set (supabase secrets set SENTRY_DSN=https://<key>@o<org>.ingest.<region>.sentry.io/<project>).
// Pure helpers (no Deno APIs) so node tests can cover them; the send itself is in sentrySend() below.
// PRIVACY: an event carries ONLY the function's name, the error's short tag (SQLSTATE / error name) and the
// environment - never the error message, a stack, a request body, a header, an IP, an e-mail, a phone or an amount.
// No SDK, no dependency: one POST of Sentry's envelope format (https://develop.sentry.dev/sdk/envelopes/).

const DSN_RE = /^https:\/\/([0-9a-f]{16,64})@(o\d{1,20}\.ingest(?:\.[a-z]{2})?\.sentry\.io)\/(\d{1,20})$/;

// "https://<key>@o1.ingest.us.sentry.io/7" -> { url, auth } | null (only a sentry.io ingest host)
export function parseDsn(dsn) {
  const m = DSN_RE.exec(String(dsn || "").trim());
  if (!m) return null;
  return {
    url: "https://" + m[2] + "/api/" + m[3] + "/envelope/",
    auth: "Sentry sentry_version=7, sentry_key=" + m[1] + ", sentry_client=helm-edge/1.0",
  };
}

// a value goes out only when it is a plain short tag (a SQLSTATE like 23505, an error name, a function name);
// anything else (spaces, @, slashes - i.e. a message) becomes "error"
const safeTag = (v, max) => { const t = String(v == null ? "" : v); return new RegExp("^[A-Za-z0-9_.:-]{1," + max + "}$").test(t) ? t : "error"; };

// the function's name from the request URL (/functions/v1/<name> or /<name>)
export function fnName(reqUrl) {
  try {
    const parts = new URL(String(reqUrl)).pathname.split("/").filter(Boolean);
    const n = parts[parts.length - 1] || "";
    return /^[a-z0-9-]{1,40}$/.test(n) ? n : "unknown";
  } catch (_) { return "unknown"; }
}

// one Sentry envelope (3 lines) for an error tag; eventId = 32 hex chars, now = Date
export function buildEnvelope(o) {
  const ev = {
    event_id: o.eventId,
    timestamp: o.now.toISOString(),
    platform: "javascript",
    level: "error",
    logger: "edge-function",
    environment: safeTag(o.environment || "production", 32),
    release: o.release ? safeTag(o.release, 64) : undefined,
    tags: { function: safeTag(o.fn, 40), runtime: "supabase-edge" },
    exception: { values: [{ type: safeTag(o.tag, 40), value: "internal error in " + safeTag(o.fn, 40) }] },
  };
  return JSON.stringify({ event_id: o.eventId, sent_at: o.now.toISOString() }) + "\n" +
    JSON.stringify({ type: "event" }) + "\n" + JSON.stringify(ev) + "\n";
}

// fire-and-forget send; never throws, never waits more than 3 s. env = (name) => value
export function sentrySend(env, fetchFn, reqUrl, tag) {
  try {
    const d = parseDsn(env("SENTRY_DSN"));
    if (!d || typeof fetchFn !== "function") return null;
    const eventId = (globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + "0000000000000000000000000000")
      .replace(/-/g, "").slice(0, 32);
    const body = buildEnvelope({ eventId, now: new Date(), environment: env("SENTRY_ENVIRONMENT"), release: env("SENTRY_RELEASE"),
      fn: fnName(reqUrl), tag });
    const p = fetchFn(d.url, { method: "POST", headers: { "Content-Type": "application/x-sentry-envelope", "X-Sentry-Auth": d.auth },
      body, signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(3000) : undefined })
      .catch(() => null);
    return p;
  } catch (_) { return null; }
}
