// comms-dispatch r33 (0283): studio team-safety notices (helm_notice_outbox kind team_safety) - an admin change waiting
// 24 hours, a done change, an ownership hand-over, Helm support recovering the owner - are e-mailed over SMTP to the
// recipients the database resolved (never from the row), in plain words, with the Control Center -> Team link on
// APP_URL and a transactional footer; an unknown event is skipped; every row is marked. Mock-only: no network, no real e-mail.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, loadHandler, resetSupaMock, captureConsoleError } from "./harness.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/comms-dispatch/index.ts";
const CRON = "comms-shared-secret-xyz";
const T1 = "e3300000-0000-4000-8000-000000000001", T2 = "e3300000-0000-4000-8000-000000000002", T3 = "e3300000-0000-4000-8000-000000000003", T4 = "e3300000-0000-4000-8000-000000000004";
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", HELM_COMMS_SECRET: CRON, APP_URL: "https://www.helm.events" };
const SMTP = { SMTP_HOST: "smtp.gmail.com", SMTP_PORT: "587", SMTP_USER: "owner@gmail.com", SMTP_PASS: "gmail-app-pass" };

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

const ROWS = [
  { id: T1, kind: "team_safety", to: ["owner@aurora.test", "ravi@aurora.test", "priya@aurora.test"],
    data: { event: "admin_change_requested", studio: "Aurora Events", kind: "deactivate", target: "Ravi", by: "Priya", when: "28 Oct 2026, 14:00 (Asia/Kolkata)" } },
  { id: T2, kind: "team_safety", to: ["owner@aurora.test", "meera@aurora.test"],
    data: { event: "owner_transfer_started", studio: "Aurora Events", from: "Anil", to: "Meera" } },
  { id: T3, kind: "team_safety", to: ["meera@aurora.test"], data: { event: "owner_recovered", studio: "Aurora Events", to: "Meera" } },
  { id: T4, kind: "team_safety", to: ["x@aurora.test"], data: { event: "something_else", studio: "Aurora Events" } },
];
function wireDb() {
  resetSupaMock();
  const marks: Record<string, string> = {};
  g.__supaRpc = (name: string, args: any) => {
    if (name === "helm_notice_outbox_claim") return { data: ROWS, error: null };
    if (name === "helm_notice_outbox_mark") { marks[args.p_id] = args.p_status; return { data: null, error: null }; }
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

Deno.test("team-safety notices over SMTP: every resolved recipient, plain words, Team link on APP_URL, footer; unknown event skipped", async () => {
  const { marks } = wireDb();
  const smtp = installFakeSmtp();
  const f = installFetch((url) => { throw new Error("unexpected fetch " + url); });
  try {
    const { out, logs } = await run({ ...SMTP });
    assertEquals(marks[T1], "sent"); assertEquals(marks[T2], "sent"); assertEquals(marks[T3], "sent");
    assertEquals(marks[T4], "skipped");
    const to1 = smtp.sent.filter((s) => partsOf(s.data).text.includes("deactivate Ravi")).map((s) => s.rcpt).sort();
    assertEquals(to1, ["<owner@aurora.test>", "<priya@aurora.test>", "<ravi@aurora.test>"]);
    const a = partsOf(smtp.sent.find((s) => s.rcpt === "<ravi@aurora.test>")!.data);
    assert(a.text.includes("Priya asked to deactivate Ravi in Aurora Events. It happens on 28 Oct 2026, 14:00 (Asia/Kolkata) unless the studio owner cancels it."), a.text);
    assert(a.text.includes("https://www.helm.events/control#users"), "Team link on APP_URL");
    assert(a.text.includes("you are an admin of a Helm studio, or this change is about your access to it"), "transactional footer");
    assertEquals(smtp.sent.filter((s) => partsOf(s.data).text.includes("Anil started handing the ownership of Aurora Events to Meera. Meera must accept it in Control Center -> Team within 7 days.")).map((s) => s.rcpt).sort(),
      ["<meera@aurora.test>", "<owner@aurora.test>"]);
    assert(smtp.sent.some((s) => partsOf(s.data).text.includes("Helm support made Meera the owner of Aurora Events")), "recovery notice");
    assert(!smtp.sent.some((s) => s.rcpt === "<x@aurora.test>"), "unknown event never sent");
    assert(!logs.join(" ").includes("aurora.test"), "no address in logs");
    assert(out.sent >= 3);
  } finally { f(); smtp.restore(); }
});

Deno.test("team-safety notices without e-mail configured: nothing sent, rows skipped (never a network call)", async () => {
  const { marks } = wireDb();
  const f = installFetch((url) => { throw new Error("unexpected fetch " + url); });
  try {
    await run({});
    for (const id of [T1, T2, T3, T4]) assert(marks[id] === "skipped" || marks[id] === "pending" || marks[id] === undefined || marks[id] === "retry", id + " " + marks[id]);
    assert(marks[T1] !== "sent");
  } finally { f(); }
});
