// csp-report/logic.mjs - pure helpers (no network, no Deno APIs) so node tests can cover them.
// Turns a browser CSP violation report (legacy report-uri body {"csp-report": {...}} or a Reporting API
// array [{type:"csp-violation", body:{...}}]) into ONE short, redacted log line. Client links carry bearer
// tokens in the URL, so only origin + a token-free path shape is ever kept; query strings, fragments, script
// samples and anything that looks like a token / UUID / e-mail are dropped.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG = /[A-Za-z0-9_-]{20,}/g;
const EMAIL = /[^\s/@]+@[^\s/@]+/g;

// "https://www.helm.events/sharma/quote/abc?x=1#y" -> "https://www.helm.events/sharma/quote/:id"
export function safeUrl(v) {
  const s = String(v == null ? "" : v).slice(0, 2048);
  if (!s) return "";
  if (/^(inline|eval|data|blob|self|wasm-eval|trusted-types-sink)$/i.test(s)) return s.toLowerCase();
  let u;
  try { u = new URL(s); } catch (e) { return "(other)"; }
  if (!/^https?:$/.test(u.protocol)) return u.protocol.replace(/:$/, "");
  const segs = u.pathname.split("/").slice(0, 6).map((p, i) => {
    if (!p) return p;
    const t = p.replace(EMAIL, ":email").replace(UUID, ":id").replace(LONG, ":id");
    // the segment after a client-link kind is always a token
    return t.length > 40 ? ":id" : t;
  });
  const path = segs.join("/").replace(/(\/(?:quote|proposal|portal|work|invite|booklet|i)\/)[^/]+/gi, "$1:id");
  return (u.origin + path).slice(0, 200);
}

function one(b) {
  const r = b && typeof b === "object" ? b : {};
  const directive = String(r["effective-directive"] || r.effectiveDirective || r["violated-directive"] || r.violatedDirective || "").split(" ")[0].slice(0, 40);
  return {
    directive: /^[a-z-]{1,40}$/.test(directive) ? directive : "(unknown)",
    blocked: safeUrl(r["blocked-uri"] || r.blockedURL || r.blockedUrl || ""),
    page: safeUrl(r["document-uri"] || r.documentURL || r.documentUrl || ""),
    disposition: String(r.disposition || "enforce") === "report" ? "report" : "enforce",
  };
}

// raw JSON (any of the two formats) -> [{directive, blocked, page, disposition}] (max 10)
export function summarize(raw) {
  let j;
  try { j = typeof raw === "string" ? JSON.parse(raw) : raw; } catch (e) { return []; }
  if (Array.isArray(j)) {
    return j.filter((x) => x && typeof x === "object" && (x.type === "csp-violation" || x.body)).slice(0, 10).map((x) => one(x.body));
  }
  if (j && typeof j === "object" && j["csp-report"]) return [one(j["csp-report"])];
  return [];
}

export function logLine(s) {
  return "csp-violation " + s.disposition + " " + s.directive + " blocked=" + (s.blocked || "-") + " page=" + (s.page || "-");
}
