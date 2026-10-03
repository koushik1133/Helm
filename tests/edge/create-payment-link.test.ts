// create-payment-link — runtime-verified with mocked Razorpay + mocked Supabase (quotes/quote_payments).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  setEnv, installFetch, jsonResponse, loadHandler, post,
  resetSupaMock, fetchLog,
} from "./harness.ts";

const FN = "../../supabase/functions/create-payment-link/index.ts";
const g = globalThis as any;

const ENV = {
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  RAZORPAY_KEY_ID: "rzp_key",
  RAZORPAY_KEY_SECRET: "rzp_secret",
  APP_URL: "https://helm.events",
};

// helper: wire quotes row + optional open-link row via the resolver
function wireQuotes(quote: any, openLink: any = null) {
  g.__supaResolver = (table: string, calls: any[]) => {
    if (table === "quotes") return { data: quote, error: quote ? null : null };
    if (table === "quote_payments") {
      const isSelect = calls.some((c) => c[0] === "select");
      const isInsert = calls.some((c) => c[0] === "insert");
      if (isInsert) return { data: null, error: null };
      if (isSelect) return { data: openLink, error: null };
    }
    return { data: null, error: null };
  };
}

Deno.test("create-payment-link: missing token -> 400", async () => {
  resetSupaMock();
  const rEnv = setEnv(ENV);
  const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({}))).status, 400);
  } finally { rF(); rEnv(); }
});

Deno.test("create-payment-link: unknown token -> 404", async () => {
  resetSupaMock();
  wireQuotes(null);
  const rEnv = setEnv(ENV);
  const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ token: "nope" }))).status, 404);
  } finally { rF(); rEnv(); }
});

Deno.test("create-payment-link: expired token -> 404, Razorpay not called", async () => {
  resetSupaMock();
  wireQuotes({ id: "q1", approval_status: "approved", approval_token_expires_at: "2000-01-01T00:00:00Z", pricing: { total: 100 } });
  const rEnv = setEnv(ENV);
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({}); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ token: "t" }))).status, 404);
    assert(!fetched);
  } finally { rF(); rEnv(); }
});

Deno.test("create-payment-link: already PAID -> 409 (no double charge), Razorpay not called", async () => {
  resetSupaMock();
  wireQuotes({ id: "q1", approval_status: "paid", pricing: { total: 100 } });
  const rEnv = setEnv(ENV);
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({}); });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: "t" }));
    assertEquals(res.status, 409);
    assert(!fetched, "must never mint a 2nd link for a paid quote");
  } finally { rF(); rEnv(); }
});

Deno.test("create-payment-link: not approved -> 400", async () => {
  resetSupaMock();
  wireQuotes({ id: "q1", approval_status: "pending", pricing: { total: 100 } });
  const rEnv = setEnv(ENV);
  const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ token: "t" }))).status, 400);
  } finally { rF(); rEnv(); }
});

Deno.test("create-payment-link: amount <= 0 -> 400, Razorpay not called", async () => {
  resetSupaMock();
  wireQuotes({ id: "q1", approval_status: "approved", pricing: { total: 0 } });
  const rEnv = setEnv(ENV);
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({}); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ token: "t" }))).status, 400);
    assert(!fetched);
  } finally { rF(); rEnv(); }
});

Deno.test("create-payment-link: reuse OPEN link of same amount -> no new Razorpay link (idempotent double-click)", async () => {
  resetSupaMock();
  wireQuotes(
    { id: "q1", approval_status: "approved", pricing: { total: 100 }, client: {}, code: "EV1" },
    { link_url: "https://rzp.io/existing", amount: 100 },
  );
  const rEnv = setEnv(ENV);
  let fetched = false;
  const rF = installFetch(() => { fetched = true; return jsonResponse({ short_url: "https://rzp.io/NEW", id: "plink_new" }); });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: "t" }));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).link_url, "https://rzp.io/existing");
    assert(!fetched, "must reuse the open link, not create a new one");
  } finally { rF(); rEnv(); }
});

Deno.test("create-payment-link: happy path -> creates Razorpay link, 200, amount in paise", async () => {
  resetSupaMock();
  wireQuotes(
    { id: "q1", approval_status: "approved", pricing: { total: 100.5 }, client: { name: "A", email: "a@b.c", phone: "9" }, code: "EV1" },
    null,
  );
  const rEnv = setEnv(ENV);
  const rF = installFetch((url) => {
    assertEquals(url, "https://api.razorpay.com/v1/payment_links");
    return jsonResponse({ short_url: "https://rzp.io/NEW", id: "plink_new" });
  });
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: "t" }));
    assertEquals(res.status, 200);
    assertEquals((await res.json()).link_url, "https://rzp.io/NEW");
    const body = JSON.parse((fetchLog()[0].init as any).body);
    assertEquals(body.amount, 10050); // 100.5 * 100 paise
    assertEquals(body.currency, "INR");
    assertEquals(body.accept_partial, false);
  } finally { rF(); rEnv(); }
});
