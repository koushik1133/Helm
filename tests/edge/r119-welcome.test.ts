// R119 (0327) — trial-aware welcome content, runWelcomeBatch over SMTP (shared mailer), the comms-dispatch welcome
// lane (database switch), and billing-reminder's "still due?" re-check before every send. Mock-only: no network,
// no real e-mail, no database.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, resetSupaMock, supaLog, fetchLog, captureConsoleError } from "./harness.ts";
import { render, ownerTrialEmail, memberTrialEmail, trialEndIST, LINKS, TRIAL, MEMBER_TRIAL_NOTE } from "../../supabase/functions/welcome-mailer/templates.ts";
import { runWelcomeBatch, SAFE_MARK } from "../../supabase/functions/welcome-mailer/send.ts";

const g = globalThis as any;
const ID1 = "c0000000-0000-4000-8000-0000000119a1";
const ID2 = "c0000000-0000-4000-8000-0000000119a2";
const END = "2026-11-08T18:30:00Z";   // = Mon 9 Nov 2026, 12:00 am IST

Deno.test("r119 trial owner welcome: 8 days, end date in IST, sample data, simulation, limits, locked, after, links", () => {
  const m = ownerTrialEmail({ name: "Asha Rao", studio: "Sita <Events>", trial: true, trialEndsAt: END });
  assertEquals(trialEndIST(END), "Mon, 9 Nov 2026, 12:00 am IST");
  for (const part of [m.html, m.text]) {
    assert(part.includes("8-day free trial"), "8 days");
    assert(part.includes("Mon, 9 Nov 2026, 12:00 am IST"), "end date in IST");
    assert(/Demo/.test(part) && /Sample/.test(part), "sample data marked");
    assert(part.includes("nothing is sent to your clients") && part.includes("000000") && part.includes("TEST receipts"), "simulation");
    assert(part.includes("up to 2 new records") && part.includes("2 teammates"), "limits");
    assert(part.includes("downloads, prints and exports") && part.includes("photo renders") && part.includes("WhatsApp, SMS and online payment links"), "locked");
    assert(part.includes("read-only"), "after the trial");
    for (const l of [LINKS.dashboard, LINKS.trialTerms, LINKS.choosePlan]) assert(part.includes(l), "link " + l);
  }
  assertEquals(LINKS.trialTerms, "https://www.helm.events/terms#trial");
  assertEquals(LINKS.choosePlan, "https://www.helm.events/checkout");
  assert(m.html.includes("Sita &lt;Events&gt;") && !m.html.includes("Sita <Events>"), "escaped");
  assert(m.subject.includes("free trial") && !/[\r\n]/.test(m.subject));
  assert(m.html.includes("_shared") === false && m.html.includes("helm-logo-v3.png"), "shared layout (logo)");
  // no end date -> no broken date line
  const n = ownerTrialEmail({ studio: "S", trial: true, trialEndsAt: null });
  assert(!n.text.includes("It ends on") && n.text.includes("8-day free trial"));
  assertEquals(trialEndIST("not a date"), "");
  assertEquals(TRIAL.DAYS, 8);
});

Deno.test("r119 trial member welcome: short trial note; paid studios unchanged", () => {
  const t = memberTrialEmail({ name: "Ravi", studio: "S", trial: true });
  assert(t.html.includes("nothing is sent to clients") && t.text.includes(MEMBER_TRIAL_NOTE));
  assert(t.text.indexOf(MEMBER_TRIAL_NOTE) < t.text.indexOf("Sign in: "), "note before the sign-in link");
  const paidOwner = render("studio_owner", { name: "Asha", studio: "S", trial: false })!;
  const paidMember = render("member", { name: "Ravi", studio: "S" })!;
  assertEquals(paidOwner.subject, "Welcome to Helm — S is ready");
  assert(!paidOwner.text.includes("trial") && !paidMember.text.includes("trial"), "paid: no trial wording");
  assertEquals(render("member", { studio: "S", trial: true })!.subject, paidMember.subject);
  assert(render("studio_owner", { studio: "S", trial: "true" })!.subject === paidOwner.subject, "only a real boolean true means trial");
  assertEquals(render("other", {}), null);
});

function admin(rows: unknown[], sw: unknown = { data: true, error: null }) {
  const log: any[] = [];
  return { log, rpc: (name: string, args: unknown) => {
    log.push({ name, args });
    if (name === "welcome_email_switch") return Promise.resolve(sw);
    if (name === "welcome_email_outbox_claim") return Promise.resolve({ data: rows, error: null });
    return Promise.resolve({ data: "ok", error: null });
  } };
}

Deno.test("r119 runWelcomeBatch: SMTP preferred (shared mailer), trial content, footer, marks; switch off -> no claim", async () => {
  const rows = [
    { id: ID1, kind: "studio_owner", to: "owner@trial.in", studio: "Trial Co", name: "Asha", trial: true, trial_ends_at: END, safe: SAFE_MARK },
    { id: ID2, kind: "member", to: "member@trial.in", studio: "Trial Co", name: "Ravi", trial: true, trial_ends_at: END, safe: SAFE_MARK },
  ];
  const sent: any[] = [];
  const env = (k: string) => ({ SMTP_HOST: "smtp.gmail.com", SMTP_USER: "owner@gmail.com", SMTP_PASS: "app-pass", RESEND_API_KEY: "re_x", RESEND_FROM: "x@helm.events", APP_URL: "https://www.helm.events" } as any)[k];
  const a = admin(rows);
  const f = installFetch(() => { throw new Error("Resend must not be used when SMTP is set"); });
  try {
    const out = await runWelcomeBatch(a, 10, { env, smtp: async (_cfg, mail) => { sent.push(mail); } });
    assertEquals(out.counts, { sent: 2, skipped: 0, failed: 0, invalid: 0 });
    assertEquals(sent.length, 2);
    assertEquals(sent[0].to, "owner@trial.in");
    assert(sent[0].subject.includes("free trial") && sent[0].text.includes("000000") && sent[0].text.includes("You received this because"));
    assert(sent[1].text.includes(MEMBER_TRIAL_NOTE));
    assertEquals(a.log.map((x) => x.name), ["welcome_email_switch", "welcome_email_outbox_claim", "welcome_email_outbox_mark", "welcome_email_outbox_mark"]);
    assert(a.log.filter((x) => x.name === "welcome_email_outbox_mark").every((x) => x.args.p_status === "sent"));
    assertEquals(fetchLog().length, 0);
  } finally { f(); }
  const off = admin(rows, { data: false, error: null });
  const o = await runWelcomeBatch(off, 10, { env, smtp: async () => { throw new Error("no send expected"); } });
  assert(o.off === true);
  assertEquals(off.log.map((x) => x.name), ["welcome_email_switch"]);
  const old = admin(rows, { data: null, error: { code: "PGRST202" } });
  const e = await runWelcomeBatch(old, 10, { env });
  assert(e.error);
  assertEquals(old.log.map((x) => x.name), ["welcome_email_switch"]);
});

// ---- comms-dispatch: the welcome lane rides on the existing cron ---------------------------------------------------
const CD = "../../supabase/functions/comms-dispatch/index.ts";
const CRON = "comms-shared-secret-xyz";
const CD_ENV = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", HELM_COMMS_SECRET: CRON,
  APP_URL: "https://www.helm.events", RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <hello@helm.events>" };
const cdRun = async (sw: unknown) => {
  resetSupaMock();
  g.__supaRpc = (name: string) => name === "welcome_email_switch" ? sw
    : name === "welcome_email_outbox_claim" ? { data: [{ id: ID1, kind: "studio_owner", to: "owner@trial.in", studio: "Trial Co", name: "Asha", trial: true, trial_ends_at: END, safe: SAFE_MARK }], error: null }
    : { data: [], error: null };
  const r = setEnv(CD_ENV);
  try {
    const h = await loadHandler(CD);
    const { result, logs } = await captureConsoleError(async () => await h(new Request("https://fn.local/", { method: "POST", headers: { "x-helm-cron-secret": CRON } })));
    return { out: await result.json(), logs };
  } finally { r(); }
};

Deno.test("r119 comms-dispatch: switch ON -> the trial owner welcome goes out (designed HTML), marked sent, no PII in logs", async () => {
  const f = installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ id: "e1" }); throw new Error("unexpected " + url); });
  try {
    const { out, logs } = await cdRun({ data: true, error: null });
    assertEquals(out.sent, 1);
    const b = JSON.parse(String(fetchLog()[0].init?.body));
    assertEquals(b.to, ["owner@trial.in"]);
    assert(b.html.includes("How the trial works") && b.text.includes("Mon, 9 Nov 2026, 12:00 am IST"));
    const m = supaLog().filter((l) => l.rpc === "welcome_email_outbox_mark");
    assertEquals(m.length, 1); assertEquals(m[0].args.p_status, "sent");
    assert(!logs.join(" ").includes("owner@trial.in"));
  } finally { f(); }
});

Deno.test("r119 comms-dispatch: switch OFF / no 0327 -> welcome never claimed, nothing sent", async () => {
  const f = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    for (const sw of [{ data: false, error: null }, { data: null, error: { code: "PGRST202" } }]) {
      const { out } = await cdRun(sw);
      assertEquals(out.sent, 0);
      assertEquals(supaLog().filter((l) => l.rpc === "welcome_email_outbox_claim").length, 0);
    }
  } finally { f(); }
});

// ---- billing-reminder: never late, never after the studio paid -----------------------------------------------------
const REM = "../../supabase/functions/billing-reminder/index.ts";
const RCRON = "cron-shared-secret-xyz";
const RID = "c0000000-0000-4000-8000-0000000119c1";
const remRun = async (recheck: unknown) => {
  resetSupaMock();
  g.__supaRpc = (name: string) => name === "billing_reminder_recheck" ? recheck
    : name === "studio_billing_email" ? { data: "owner@studio-a.in", error: null } : { data: null, error: null };
  g.__supaResolver = (table: string, calls: any[]) => {
    if (table === "billing_reminders" && calls.some((c: any) => c[0] === "select")) return { data: [{ id: RID, org_id: "a0000000-0000-4000-8000-000000000001", kind: "past_due", period_end: "2026-10-01" }], error: null };
    if (table === "organizations") return { data: { name: "Studio A" }, error: null };
    return { data: null, error: null };
  };
  const r = setEnv({ SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", HELM_BILLING_REMINDERS_ENABLED: "true",
    HELM_BILLING_CRON_SECRET: RCRON, RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <billing@helm.events>" });
  try {
    const h = await loadHandler(REM);
    const { result } = await captureConsoleError(async () => await h(new Request("https://fn.local/", { method: "POST", headers: { "x-helm-cron-secret": RCRON } })));
    return await result.json();
  } finally { r(); }
};
const updates = () => supaLog().filter((l) => l.table === "billing_reminders" && l.calls.some((c: any) => c[0] === "update"));

Deno.test("r119 billing-reminder: stale / paid since -> not sent, the sender does not mark (the database closed it)", async () => {
  const f = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    for (const why of ["stale", "paid_since", "trial_over", "gone"]) {
      const out = await remRun({ data: why, error: null });
      assertEquals(out.sent, 0); assertEquals(out.skipped, 1);
      assertEquals(updates().length, 0);
      assertEquals(supaLog().filter((l) => l.rpc === "billing_reminder_recheck")[0].args.p_id, RID);
    }
  } finally { f(); }
});

Deno.test("r119 billing-reminder: re-check unavailable (no 0327 / error) -> fail closed: nothing sent, row left unsent", async () => {
  const f = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const out = await remRun({ data: null, error: { code: "PGRST202" } });
    assertEquals(out.sent, 0); assertEquals(out.failed, 1);
    assertEquals(updates().length, 0);
  } finally { f(); }
});

Deno.test("r119 billing-reminder: still due -> sent and marked as before", async () => {
  const f = installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ id: "e1" }); throw new Error("unexpected " + url); });
  try {
    const out = await remRun({ data: "send", error: null });
    assertEquals(out.sent, 1);
    assertEquals(updates().length, 1);
  } finally { f(); }
});
