// comms-dispatch vendor requests (0256): rows claimed through vendor_request_claim(limit, 'email') are e-mailed
// (SMTP / Resend) with the one-tap link APP_URL/vendor-request?t=<64 hex>, a transactional footer and the studio's
// reply-to; no money in the e-mail; a bad row is skipped; no e-mail secrets -> skipped; failures -> retry.
// Mock-only: no network, no real e-mail.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, resetSupaMock, fetchLog, captureConsoleError } from "./harness.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/comms-dispatch/index.ts";
const CRON = "comms-shared-secret-xyz";
const TOK = "ab".repeat(32);
const D1 = "e0000000-0000-4000-8000-000000000001", D2 = "e0000000-0000-4000-8000-000000000002", D3 = "e0000000-0000-4000-8000-000000000003";
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", HELM_COMMS_SECRET: CRON, APP_URL: "https://www.helm.events" };
const SMTP = { SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", SMTP_USER: "owner@gmail.com", SMTP_PASS: "gmail-app-pass" };
const RESEND = { RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <hello@helm.events>" };

// ---- in-memory fake SMTP server behind Deno.connect --------------------------------------
type Sent = { from: string; rcpt: string; data: string };
function installFakeSmtp(): { sent: Sent[]; connects: { hostname: string; port: number }[]; restore: () => void } {
  const sent: Sent[] = [], connects: { hostname: string; port: number }[] = [];
  const orig = (Deno as any).connect, origTls = (Deno as any).connectTls, origStart = (Deno as any).startTls;
  const enc = new TextEncoder(), dec = new TextDecoder();
  const fake = (o: { hostname: string; port: number }) => {
    connects.push({ hostname: o.hostname, port: o.port });
    let out = "220 fake ready\r\n", inbuf = "", inData = false, cur: Sent = { from: "", rcpt: "", data: "" };
    const pump = () => {
      for (;;) {
        if (inData) {
          const end = inbuf.indexOf("\r\n.\r\n"); if (end < 0) return;
          cur.data = inbuf.slice(0, end); inbuf = inbuf.slice(end + 5); inData = false;
          sent.push(cur); cur = { from: "", rcpt: "", data: "" }; out += "250 queued\r\n"; continue;
        }
        const i = inbuf.indexOf("\r\n"); if (i < 0) return;
        const line = inbuf.slice(0, i); inbuf = inbuf.slice(i + 2);
        if (line.startsWith("EHLO")) out += "250-fake\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n";   // R32 SRV-1: port 587 upgrades first
        else if (line === "STARTTLS") out += "220 go ahead\r\n";
        else if (line.startsWith("AUTH")) out += "235 ok\r\n";
        else if (line.startsWith("MAIL FROM:")) { cur.from = line.slice(10); out += "250 ok\r\n"; }
        else if (line.startsWith("RCPT TO:")) { cur.rcpt = line.slice(8); out += "250 ok\r\n"; }
        else if (line === "DATA") { out += "354 go\r\n"; inData = true; }
        else if (line === "QUIT") out += "221 bye\r\n";
      }
    };
    return {
      read: (buf: Uint8Array) => { const b = enc.encode(out); out = ""; buf.set(b.subarray(0, buf.length)); return Promise.resolve(b.length ? Math.min(b.length, buf.length) : null); },
      write: (d: Uint8Array) => { inbuf += dec.decode(d); pump(); return Promise.resolve(d.length); },
      close: () => {},
    };
  };
  (Deno as any).connect = (o: any) => Promise.resolve(fake(o));
  (Deno as any).connectTls = (o: any) => Promise.resolve(fake(o));
  (Deno as any).startTls = (conn: any) => Promise.resolve(conn);   // the in-memory fake is already "secure"
  return { sent, connects, restore: () => { (Deno as any).connect = orig; (Deno as any).connectTls = origTls; (Deno as any).startTls = origStart; } };
}
// decode the base64 text/plain part (+ the raw headers) of a fake-server message
function partsOf(raw: string): { headers: string; text: string; html: string } {
  const [headers] = raw.split("\r\n\r\n");
  const b64s = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--|$)/g)].map((m) => m[1].replace(/\r\n/g, ""));
  const d = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s || ""), (c) => c.charCodeAt(0)));
  return { headers, text: d(b64s[0]), html: d(b64s[1] || "") };
}

const VROW = { what: "Chairs", qty: 120, vendor_name: "Deccan Rentals", when_text: "20/10/2026, 04:30 PM", respond_by_text: "19/10/2026, 06:00 PM",
  event: "Wedding A", event_date: "20/10/2026", studio: "Sparkle Events", channel: "email", identity: { from_name: "Sparkle", reply_to: "ops@sparkle.in" } };
const VROWS = [
  { ...VROW, id: D1, kind: "request", to: "orders@deccan.test", token: TOK },
  { ...VROW, id: D2, kind: "reminder", to: "orders@deccan.test", token: TOK },
  { ...VROW, id: D3, kind: "request", to: "x@y.test", token: "not-a-token" },
];
function wireDb(rows = VROWS) {
  resetSupaMock();
  const marks: Record<string, string> = {}; const claims: any[] = [];
  g.__supaRpc = (name: string, args: any) => {
    if (name === "vendor_request_claim") { claims.push(args); return { data: rows, error: null }; }
    if (name === "vendor_request_mark") { marks[args.p_id] = args.p_status; return { data: null, error: null }; }
    return { data: [], error: null };
  };
  return { marks, claims };
}
const run = async (env: Record<string, string>) => {
  const r = setEnv({ ...BASE, ...env });
  try {
    const h = await loadHandler(FN);
    const { result, logs } = await captureConsoleError(async () => await h(new Request("https://fn.local/", { method: "POST", headers: { "x-helm-cron-secret": CRON } })));
    return { out: await result.json(), logs };
  } finally { r(); }
};

Deno.test("vendor requests over SMTP: the vendor gets the one-tap link (e-mail lane only), no money; bad token skipped", async () => {
  const { marks, claims } = wireDb();
  const smtp = installFakeSmtp();
  const f = installFetch((url) => { throw new Error("unexpected fetch " + url); });
  try {
    const { out, logs } = await run({ ...SMTP });
    assertEquals(claims[0].p_channel, "email");
    assertEquals(out.sent, 2); assertEquals(out.skipped, 1);
    assertEquals(marks[D1], "sent"); assertEquals(marks[D2], "sent"); assertEquals(marks[D3], "skipped");
    assertEquals(smtp.sent.length, 2);
    assertEquals(smtp.sent[0].rcpt, "<orders@deccan.test>");
    const a = partsOf(smtp.sent[0].data), b = partsOf(smtp.sent[1].data);
    assert(a.text.includes("https://www.helm.events/vendor-request?t=" + TOK), "link on APP_URL");
    assert(a.text.includes("Sparkle Events would like to book you: Chairs x120 for Wedding A on 20/10/2026, needed 20/10/2026, 04:30 PM."));
    assert(a.text.includes("Please reply by 19/10/2026, 06:00 PM."));
    assert(b.text.includes("is still waiting for your answer"), "reminder wording");
    assert(a.text.includes("You received this because a studio on Helm sent you a vendor request"), "transactional footer");
    assert(!/List-Unsubscribe/.test(a.headers), "transactional: no unsubscribe headers");
    assert(/Reply-To: <ops@sparkle\.in>/.test(a.headers));
    assert(!/\u20b9|18000/.test(a.text), "no money");
    const all = logs.join(" ");
    assert(!all.includes("orders@deccan.test") && !all.includes(TOK));
  } finally { f(); smtp.restore(); }
});

Deno.test("vendor requests over Resend: idempotency key = row id; no secrets -> skipped; provider error -> retry", async () => {
  let w = wireDb([VROWS[0]]);
  let smtp = installFakeSmtp();
  let f = installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ id: "e1" }); throw new Error("unexpected " + url); });
  try {
    const { out } = await run({ ...RESEND });
    assertEquals(out.sent, 1); assertEquals(smtp.connects.length, 0);
    assertEquals((fetchLog()[0].init?.headers as any)["Idempotency-Key"], "comms-" + D1);
    assertEquals(w.marks[D1], "sent");
  } finally { f(); smtp.restore(); }
  w = wireDb([VROWS[0]]); smtp = installFakeSmtp(); f = installFetch((url) => { throw new Error("unexpected fetch " + url); });
  try {
    const { out } = await run({});
    assertEquals(out.skipped, 1); assertEquals(w.marks[D1], "skipped"); assertEquals(smtp.connects.length, 0);
  } finally { f(); smtp.restore(); }
  w = wireDb([VROWS[0]]); smtp = installFakeSmtp(); f = installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ error: "x" }, 500); throw new Error("unexpected " + url); });
  try {
    const { out } = await run({ ...RESEND });
    assertEquals(out.failed, 1); assertEquals(w.marks[D1], "retry");
  } finally { f(); smtp.restore(); }
});
