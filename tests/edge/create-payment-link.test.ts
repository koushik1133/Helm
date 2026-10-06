// create-payment-link — runtime-verified with mocked Razorpay + mocked payment_link_* RPCs.
// Audit Phase 8: serialized per quote (reserve → Razorpay → attach), expire_by,
// superseded links cancelled, approval token never sent to Razorpay.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  setEnv, installFetch, jsonResponse, loadHandler, post, resetSupaMock, supaLog, fetchLog, captureConsoleError,
} from "./harness.ts";

const FN = "../../supabase/functions/create-payment-link/index.ts";
const g = globalThis as any;
const TOKEN = "a0000000-0000-4000-8000-0000000000aa";
const ENV = {
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  RAZORPAY_KEY_ID: "rzp_test_id",
  RAZORPAY_KEY_SECRET: "rzp_test_secret",
  APP_URL: "https://www.helm.events",
};
const CREATE = {
  action: "create", payment_id: "11111111-1111-4111-8111-111111111111", quote_id: "a0000000-0000-4000-8000-00000000da01",
  code: "A-0001", amount: 236000, expire_by: 1900000000, supersede: [],
  client: { name: "Alice <b>", email: "alice@example.com", phone: "+91 98000 00001" },
};
function begin(result: Record<string, unknown>, attach = true) {
  g.__supaRpc = (name: string) => {
    if (name === "payment_link_begin") return { data: result, error: null };
    if (name === "payment_link_attach") return { data: attach, error: null };
    if (name === "payment_link_fail") return { data: true, error: null };
    return { data: null, error: null };
  };
}

for (const [action, status] of [["invalid", 404], ["paid", 409], ["not_approved", 400], ["nothing_due", 400], ["busy", 409]] as const) {
  Deno.test(`create-payment-link: begin=${action} -> ${status}, Razorpay never called`, async () => {
    resetSupaMock();
    begin({ action });
    const rEnv = setEnv(ENV);
    const rF = installFetch(() => { throw new Error("no fetch expected"); });
    try {
      const h = await loadHandler(FN);
      assertEquals((await h(post({ token: TOKEN }))).status, status);
    } finally { rF(); rEnv(); }
  });
}

Deno.test("create-payment-link: reuse -> same link back, no new Razorpay link (double click)", async () => {
  resetSupaMock();
  begin({ action: "reuse", link_url: "https://rzp.io/i/abc123", amount: 236000 });
  const rEnv = setEnv(ENV);
  const rF = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: TOKEN }));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).link_url, "https://rzp.io/i/abc123");
  } finally { rF(); rEnv(); }
});

Deno.test("create-payment-link: create -> expire_by set, token NOT in callback_url, attach called", async () => {
  resetSupaMock();
  begin(CREATE);
  const rEnv = setEnv(ENV);
  let sent: any = null;
  const rF = installFetch((url, init) => {
    assertEquals(url, "https://api.razorpay.com/v1/payment_links");
    sent = JSON.parse(String(init?.body));
    return jsonResponse({ id: "plink_New1", short_url: "https://rzp.io/i/new1" });
  });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: TOKEN }));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).link_url, "https://rzp.io/i/new1");
    assertEquals(sent.amount, 23600000);
    assertEquals(sent.expire_by, 1900000000);
    assert(!JSON.stringify(sent).includes(TOKEN), "approval token must never be sent to Razorpay");
    assertEquals(sent.callback_url, "https://www.helm.events/approve.html?payment=done");
    assertEquals(sent.customer.contact, "+919800000001");
    assert(!sent.customer.name.includes("<"), "customer name sanitized");
    const att = supaLog().find((e) => e.rpc === "payment_link_attach");
    assertEquals(att.args.p_provider_ref, "plink_New1");
  } finally { rF(); rEnv(); }
});

Deno.test("create-payment-link: invalid client email is not forwarded", async () => {
  resetSupaMock();
  begin({ ...CREATE, client: { name: "A", email: "a@b.c>,evil@x.io", phone: "12" } });
  const rEnv = setEnv(ENV);
  let sent: any = null;
  const rF = installFetch((_u, init) => { sent = JSON.parse(String(init?.body)); return jsonResponse({ id: "plink_N2", short_url: "https://rzp.io/i/n2" }); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ token: TOKEN }))).status, 200);
    assertEquals(sent.customer.email, "");
    assertEquals(sent.customer.contact, "");
  } finally { rF(); rEnv(); }
});

Deno.test("create-payment-link: total changed -> superseded plinks cancelled at Razorpay", async () => {
  resetSupaMock();
  begin({ ...CREATE, supersede: ["plink_Old1", "not-a-plink"] });
  const rEnv = setEnv(ENV);
  const rF = installFetch((url) => url.endsWith("/cancel") ? jsonResponse({}) : jsonResponse({ id: "plink_N3", short_url: "https://rzp.io/i/n3" }));
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ token: TOKEN }))).status, 200);
    const urls = fetchLog().map((f) => f.url);
    assert(urls.includes("https://api.razorpay.com/v1/payment_links/plink_Old1/cancel"));
    assert(!urls.some((u) => u.includes("not-a-plink")));
  } finally { rF(); rEnv(); }
});

Deno.test("create-payment-link: Razorpay error -> reservation failed, 502 generic", async () => {
  resetSupaMock();
  begin(CREATE);
  const rEnv = setEnv(ENV);
  const rF = installFetch(() => jsonResponse({ error: { description: "secret detail alice@example.com" } }, 400));
  try {
    const h = await loadHandler(FN);
    const { result: res, logs } = await captureConsoleError(() => Promise.resolve(h(post({ token: TOKEN }))));
    assertEquals(res.status, 502);
    assert(supaLog().some((e) => e.rpc === "payment_link_fail"));
    assert(!logs.join(" ").includes("alice@example.com"), "provider body (PII) must not be logged");
  } finally { rF(); rEnv(); }
});

Deno.test("create-payment-link: a non-Razorpay link from the provider is never handed out", async () => {
  resetSupaMock();
  begin(CREATE);
  const rEnv = setEnv(ENV);
  const rF = installFetch(() => jsonResponse({ id: "plink_X", short_url: "https://evil.example/pay" }));
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ token: TOKEN }))).status, 502);
  } finally { rF(); rEnv(); }
});

Deno.test("create-payment-link: reservation superseded meanwhile -> new link cancelled, 409", async () => {
  resetSupaMock();
  begin(CREATE, false);
  const rEnv = setEnv(ENV);
  const rF = installFetch((url) => url.endsWith("/cancel") ? jsonResponse({}) : jsonResponse({ id: "plink_Late", short_url: "https://rzp.io/i/late" }));
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ token: TOKEN }))).status, 409);
    assert(fetchLog().some((f) => f.url.endsWith("/payment_links/plink_Late/cancel")));
  } finally { rF(); rEnv(); }
});
