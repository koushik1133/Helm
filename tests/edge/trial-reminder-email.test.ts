// billing-reminder 0058 trial kinds — branded light-only templates, escaping, fixed /checkout
// link, and the handler sending + marking trial rows. Mock-only, no network.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, resetSupaMock, supaLog, fetchLog, captureConsoleError } from "./harness.ts";
import { TRIAL_KINDS, isTrialKind, trialMessage } from "../../supabase/functions/billing-reminder/trial-email.ts";

const g = globalThis as any;
const REM = "../../supabase/functions/billing-reminder/index.ts";
const ORG = "b0000000-0000-4000-8000-0000000000a1";
const RID = "c0000000-0000-4000-8000-0000000000c9";
const CRON = "cron-shared-secret-xyz";
const ENV = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  HELM_BILLING_REMINDERS_ENABLED: "true", HELM_BILLING_CRON_SECRET: CRON, RESEND_API_KEY: "re_test",
  RESEND_FROM: "Helm <billing@helm.events>", APP_URL: "https://app.helm.test/" };

Deno.test("trial templates: one per kind, distinct subjects, branded, light-only", () => {
  const subjects = new Set<string>();
  for (const k of TRIAL_KINDS) {
    const m = trialMessage(k, "Studio A", "2026-10-20", "https://app.helm.test");
    subjects.add(m.subject);
    assert(m.html.includes("#6C4CF1"), k + " brand colour");
    assert(m.html.includes("Helm Events"), k + " footer");
    assert(m.html.includes('content="light"'), k + " light only");
    assert(!m.html.includes("prefers-color-scheme"), k + " no dark mode");
    assert(m.html.includes(">Choose a plan<"), k + " CTA");
    assert(m.html.includes('href="https://app.helm.test/checkout"'), k + " checkout link");
    assert(m.html.includes("2026-10-20"), k + " date");
  }
  assertEquals(subjects.size, 4);
  assert(trialMessage("trial_7d", "x", "", "").subject.includes("7 days"));
  assert(trialMessage("trial_1d", "x", "", "").subject.includes("tomorrow"));
  assert(trialMessage("trial_ended", "x", "", "").subject.includes("ended"));
});

Deno.test("trial templates: studio name + date escaped, bad date dropped", () => {
  const m = trialMessage("trial_3d", "<img src=x onerror=alert(1)>", "<script>", "https://app.helm.test");
  assert(!m.html.includes("<img src=x"));
  assert(m.html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert(!m.html.includes("<script>"));
});

Deno.test("trial kinds recognised; others not", () => {
  for (const k of TRIAL_KINDS) assert(isTrialKind(k));
  for (const k of ["due_soon", "past_due", "trial", "trial_2d", ""]) assert(!isTrialKind(k));
});

for (const kind of TRIAL_KINDS) {
  Deno.test(`billing-reminder: ${kind} row -> branded e-mail sent + marked once`, async () => {
    resetSupaMock();
    g.__supaResolver = (table: string, calls: any[]) => {
      if (table === "billing_reminders" && calls.some((c: any) => c[0] === "select")) return { data: [{ id: RID, org_id: ORG, kind, period_end: "2026-10-20" }], error: null };
      if (table === "organizations") return { data: { name: "Studio <A>", business_email: "owner@studio-a.in" }, error: null };
      return { data: null, error: null };
    };
    const r = setEnv(ENV);
    const f = installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ id: "e1" }); throw new Error("unexpected " + url); });
    try {
      const h = await loadHandler(REM);
      const { result, logs } = await captureConsoleError(async () => await h(new Request("https://fn.local/", { method: "POST", headers: { "x-helm-cron-secret": CRON } })));
      const out = await result.json();
      assertEquals(out.sent, 1); assertEquals(out.invalid, 0);
      const body = JSON.parse(String(fetchLog()[0].init?.body));
      assert(body.html.includes("Studio &lt;A&gt;"));
      assert(body.html.includes('href="https://app.helm.test/checkout"'));
      assert(/trial/i.test(body.subject));
      const u = supaLog().filter((l) => l.table === "billing_reminders" && l.calls.some((c: any) => c[0] === "update"));
      assertEquals(u.length, 1);
      assert(u[0].calls.some((c: any) => c[0] === "is" && c[1][0] === "sent_at" && c[1][1] === null));
      assert(!logs.join(" ").includes("owner@studio-a.in"));
    } finally { f(); r(); }
  });
}

Deno.test("billing-reminder: unknown kind still counted invalid (no send)", async () => {
  resetSupaMock();
  g.__supaResolver = (table: string, calls: any[]) => {
    if (table === "billing_reminders" && calls.some((c: any) => c[0] === "select")) return { data: [{ id: RID, org_id: ORG, kind: "trial_2d", period_end: "2026-10-20" }], error: null };
    return { data: null, error: null };
  };
  const r = setEnv(ENV); const f = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(REM);
    const out = await (await h(new Request("https://fn.local/", { method: "POST", headers: { "x-helm-cron-secret": CRON } }))).json();
    assertEquals(out.invalid, 1); assertEquals(fetchLog().length, 0);
  } finally { f(); r(); }
});
