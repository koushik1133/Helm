// comms-dispatch r24 (0269): run-sheet reminders (runsheet_reminder_claim) and the instant enquiry reply
// (enquiry_reply_claim) are e-mailed over SMTP with a transactional footer and the studio's reply-to; the run-sheet link
// is on APP_URL; a bad row is skipped; every row is marked. Mock-only: no network, no real e-mail.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, resetSupaMock, fetchLog, captureConsoleError } from "./harness.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/comms-dispatch/index.ts";
const CRON = "comms-shared-secret-xyz";
const D1 = "e0000000-0000-4000-8000-000000000001", D2 = "e0000000-0000-4000-8000-000000000002", D3 = "e0000000-0000-4000-8000-000000000003";
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", HELM_COMMS_SECRET: CRON, APP_URL: "https://www.helm.events" };
const SMTP = { SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", SMTP_USER: "owner@gmail.com", SMTP_PASS: "gmail-app-pass" };
const RESEND = { RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <hello@helm.events>" };

// ---- in-memory fake SMTP server behind Deno.connect --------------------------------------
type Sent = { from: string; rcpt: string; data: string };
function installFakeSmtp(): { sent: Sent[]; connects: { hostname: string; port: number }[]; restore: () => void } {
  const sent: Sent[] = [], connects: { hostname: string; port: number }[] = [];
  const orig = (Deno as any).connect, origTls = (Deno as any).connectTls;
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
        if (line.startsWith("EHLO")) out += "250-fake\r\n250 AUTH PLAIN\r\n";
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
  return { sent, connects, restore: () => { (Deno as any).connect = orig; (Deno as any).connectTls = origTls; } };
}
// decode the base64 text/plain part (+ the raw headers) of a fake-server message
function partsOf(raw: string): { headers: string; text: string; html: string } {
  const [headers] = raw.split("\r\n\r\n");
  const b64s = [...raw.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)(?:\r\n--|$)/g)].map((m) => m[1].replace(/\r\n/g, ""));
  const d = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s || ""), (c) => c.charCodeAt(0)));
  return { headers, text: d(b64s[0]), html: d(b64s[1] || "") };
}

const QID = "a0000000-0000-4000-8000-00000000da01";
const RS = [
  { id: D1, to: "ravi@studio.test", offset_min: 15, name: "Ravi", title: "Cake cutting", time_text: "7:30 pm", location: "Main hall",
    text: "In 15 min: Cake cutting at 7:30 pm (Main hall)", event: "Wedding A", event_date: "20/10/2026", quote_id: QID, studio: "Sparkle Events",
    identity: { from_name: "Sparkle", reply_to: "ops@sparkle.in" } },
  { id: D2, to: "x@y.test", offset_min: 15, title: "Bad", time_text: "<b>", text: "x", quote_id: QID, studio: "Sparkle Events" },
];
const EQ = [{ id: D3, to: "priya@example.test", name: "Priya", studio: "Sparkle Events", text: "Namaste Priya, Sparkle Events got your Wedding enquiry.",
  identity: { reply_to: "hello@sparkle.in" } }];
function wireDb() {
  resetSupaMock();
  const marks: Record<string, string> = {};
  g.__supaRpc = (name: string, args: any) => {
    if (name === "runsheet_reminder_claim") return { data: RS, error: null };
    if (name === "enquiry_reply_claim") return { data: EQ, error: null };
    if (name === "runsheet_reminder_mark" || name === "enquiry_reply_mark") { marks[name + ":" + args.p_id] = args.p_status; return { data: null, error: null }; }
    return { data: [], error: null };
  };
  return { marks };
}
const run = async (env: Record<string, string>) => {
  const r = setEnv({ ...BASE, ...env });
  try {
    const h = await loadHandler(FN);
    const { result, logs } = await captureConsoleError(async () => await h(new Request("https://fn.local/", { method: "POST", headers: { "x-helm-cron-secret": CRON } })));
    return { out: await result.json(), logs };
  } finally { r(); }
};

Deno.test("run-sheet reminder + enquiry reply over SMTP: plain words, APP_URL link, footer, reply-to; bad row skipped", async () => {
  const { marks } = wireDb();
  const smtp = installFakeSmtp();
  const f = installFetch((url) => { throw new Error("unexpected fetch " + url); });
  try {
    const { out, logs } = await run({ ...SMTP });
    assertEquals(marks["runsheet_reminder_mark:" + D1], "sent");
    assertEquals(marks["runsheet_reminder_mark:" + D2], "skipped");
    assertEquals(marks["enquiry_reply_mark:" + D3], "sent");
    const rs = smtp.sent.find((s) => s.rcpt === "<ravi@studio.test>"), eq = smtp.sent.find((s) => s.rcpt === "<priya@example.test>");
    assert(rs && eq, "both e-mails sent");
    const a = partsOf(rs!.data), b = partsOf(eq!.data);
    assert(a.text.includes("Cake cutting starts in 15 min, at 7:30 pm (Main hall), for Wedding A on 20/10/2026."));
    assert(a.text.includes("https://www.helm.events/runsheet.html?quote=" + QID), "link on APP_URL");
    assert(a.text.includes("You received this because you are the owner of an item on an event run-sheet"), "transactional footer");
    assert(/Reply-To: <ops@sparkle\.in>/.test(a.headers));
    assert(b.text.includes("Namaste Priya, Sparkle Events got your Wedding enquiry."));
    assert(b.text.includes("you sent an enquiry to this studio"), "enquiry footer");
    assert(/Subject: .*enquiry/i.test(b.headers) || /=\?UTF-8\?/.test(b.headers), "subject present");
    assert(!logs.join(" ").includes("priya@example.test"), "no address in logs");
    assert(out.sent >= 2);
  } finally { f(); smtp.restore(); }
});
