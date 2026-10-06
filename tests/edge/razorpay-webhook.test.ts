// razorpay-webhook — runtime-verified with mocked Resend + mocked razorpay_settle RPC.
// Audit Phase 8: DB errors -> 500 (Razorpay retries); late / short payments are
// recorded (reconcile) not dropped; emails use the paying studio's name + address.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, resetSupaMock, supaLog, fetchLog } from "./harness.ts";

const FN = "../../supabase/functions/razorpay-webhook/index.ts";
const g = globalThis as any;
const SECRET = "whsec_test";
const QUOTE = "a0000000-0000-4000-8000-00000000da01";
const ENV = {
  SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  RAZORPAY_WEBHOOK_SECRET: SECRET, RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <events@helm.events>",
};

async function signed(body: unknown, secret = SECRET): Promise<Request> {
  const raw = JSON.stringify(body);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request("https://fn.local/", { method: "POST", headers: { "x-razorpay-signature": sig }, body: raw });
}
const PAID = {
  event: "payment_link.paid",
  payload: {
    payment_link: { entity: { id: "plink_A1", amount_paid: 23600000, notes: { quote_id: QUOTE } } },
    payment: { entity: { id: "pay_A1", amount: 23600000 } },
  },
};
function db(settle: unknown, opts: { orgErr?: boolean } = {}) {
  g.__supaRpc = (name: string) => name === "razorpay_settle" ? settle : ({ data: null, error: null });
  g.__supaResolver = (table: string) => {
    if (table === "quotes") return { data: { id: QUOTE, code: "A-0001", title: "Wedding A", client: { email: "alice@example.com" }, pricing: { total: 236000 }, org_id: "org-a" }, error: null };
    if (table === "organizations") return opts.orgErr ? { data: null, error: { code: "57014" } } : { data: { name: "Studio A", business_email: "owner@studio-a.in" }, error: null };
    return { data: null, error: null };
  };
}

Deno.test("webhook: bad signature -> 401, DB untouched", async () => {
  resetSupaMock(); db({ data: { result: "settled" }, error: null });
  const rEnv = setEnv(ENV); const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(await signed(PAID, "wrong"))).status, 401);
    assertEquals(supaLog().filter((e) => e.rpc).length, 0);
  } finally { rF(); rEnv(); }
});

Deno.test("webhook: settle RPC error -> 500 so Razorpay retries", async () => {
  resetSupaMock(); db({ data: null, error: { code: "40001", message: "serialization failure" } });
  const rEnv = setEnv(ENV); const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(await signed(PAID))).status, 500);
  } finally { rF(); rEnv(); }
});

Deno.test("webhook: studio lookup error -> 500 (no silent success)", async () => {
  resetSupaMock(); db({ data: { result: "settled", quote_id: QUOTE }, error: null }, { orgErr: true });
  const rEnv = setEnv(ENV); const rF = installFetch(() => jsonResponse({ id: "e" }));
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(await signed(PAID))).status, 500);
  } finally { rF(); rEnv(); }
});

Deno.test("webhook: link id + payment id passed to the settle RPC (provider_ref first)", async () => {
  resetSupaMock(); db({ data: { result: "replay" }, error: null });
  const rEnv = setEnv(ENV); const rF = installFetch(() => { throw new Error("no fetch on replay"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(await signed(PAID))).status, 200);
    const call = supaLog().find((e) => e.rpc === "razorpay_settle");
    assertEquals(call.args.p_link_ref, "plink_A1");
    assertEquals(call.args.p_payment_ref, "pay_A1");
    assertEquals(call.args.p_paid_paise, 23600000);
    assertEquals(fetchLog().length, 0, "a replay must not re-send receipts");
  } finally { rF(); rEnv(); }
});

Deno.test("webhook: payment after already paid -> recorded (reconcile), studio told, 200", async () => {
  resetSupaMock(); db({ data: { result: "reconcile", reason: "already_paid", quote_id: QUOTE }, error: null });
  const rEnv = setEnv(ENV);
  const to: string[] = [];
  const rF = installFetch((_u, init) => { to.push(JSON.parse(String(init?.body)).to); return jsonResponse({ id: "e" }); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(await signed(PAID))).status, 200);
    assertEquals(to, ["owner@studio-a.in"]);
  } finally { rF(); rEnv(); }
});

Deno.test("webhook: settled -> receipts from the STUDIO (name + address), no global MANAGER_EMAIL tenant data", async () => {
  resetSupaMock(); db({ data: { result: "settled", quote_id: QUOTE }, error: null });
  const rEnv = setEnv({ ...ENV, MANAGER_EMAIL: "ops@platform.example" });
  const mails: any[] = [];
  const rF = installFetch((url, init) => { assertEquals(url, "https://api.resend.com/emails"); mails.push(JSON.parse(String(init?.body))); return jsonResponse({ id: "e" }); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(await signed(PAID))).status, 200);
    const client = mails.find((m) => m.to === "alice@example.com");
    const studio = mails.find((m) => m.to === "owner@studio-a.in");
    const ops = mails.find((m) => m.to === "ops@platform.example");
    assert(client && studio && ops);
    assertEquals(client.from, '"Studio A" <events@helm.events>');
    assert(client.html.includes("Studio A") && !client.html.includes("Blueprint Stage"));
    assertEquals(client.reply_to, "owner@studio-a.in");
    const opsText = JSON.stringify(ops);
    assert(!/Alice|alice@|A-0001|236|Studio A|Wedding/.test(opsText), "ops copy must carry no tenant data: " + opsText);
  } finally { rF(); rEnv(); }
});

Deno.test("webhook: no quote reference at all -> 200, nothing written", async () => {
  resetSupaMock(); db({ data: { result: "settled" }, error: null });
  const rEnv = setEnv(ENV); const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(FN);
    const res = await h(await signed({ event: "payment.captured", payload: { payment: { entity: { id: "pay_X", amount: 1, notes: { quote_id: "' or 1=1--" } } } } }));
    assertEquals(res.status, 200);
    assertEquals(supaLog().filter((e) => e.rpc).length, 0);
  } finally { rF(); rEnv(); }
});
