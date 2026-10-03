// razorpay-webhook — runtime-verified: HMAC-SHA256 signature + timingSafeEqual,
// idempotency (conditional UPDATE), underpayment guard, HTML/CRLF-injection handling.
// Mocked Resend (email) + mocked Supabase.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  setEnv, installFetch, jsonResponse, loadHandler,
  resetSupaMock, supaLog, fetchLog, captureConsoleError,
} from "./harness.ts";

const FN = "../../supabase/functions/razorpay-webhook/index.ts";
const g = globalThis as any;
const SECRET = "whsecret";

const ENV = {
  SUPABASE_URL: "https://proj.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
  RAZORPAY_WEBHOOK_SECRET: SECRET,
  MANAGER_EMAIL: "mgr@studio.com",
  // RESEND_API_KEY omitted -> email "simulated" (no provider call) unless a test sets it
};

const enc = new TextEncoder();
async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const QID = "11111111-1111-1111-1111-111111111111";

function evt(overrides: any = {}) {
  return JSON.stringify({
    event: "payment_link.paid",
    payload: {
      payment_link: {
        entity: {
          id: "plink_1",
          amount_paid: 10000,
          notes: { quote_id: QID },
          ...overrides.linkEntity,
        },
      },
      ...overrides.payload,
    },
    ...overrides.top,
  });
}

function req(body: string, sig: string): Request {
  return new Request("https://fn.local/", {
    method: "POST",
    headers: { "x-razorpay-signature": sig, "Content-Type": "application/json" },
    body,
  });
}

// Default supabase wiring: quote exists with total 100 (10000 paise), transition succeeds once.
function wire(opts: { total?: number; paidAlready?: boolean; quote?: any } = {}) {
  const total = opts.total ?? 100;
  let transitioned = opts.paidAlready ? true : false;
  g.__supaResolver = (table: string, calls: any[]) => {
    const has = (m: string) => calls.some((c) => c[0] === m);
    if (table === "quotes") {
      if (has("update")) {
        // conditional update: created->paid only once
        if (transitioned) return { data: null, error: null };
        transitioned = true;
        return { data: opts.quote ?? { id: QID, code: "EV1", title: "Gala", pricing: { total }, client: { email: "c@x.com" } }, error: null };
      }
      // select pricing
      return { data: { pricing: { total } }, error: null };
    }
    if (table === "quote_payments") return { data: has("select") ? { id: "pay1" } : null, error: null };
    return { data: null, error: null };
  };
}

Deno.test("razorpay-webhook: missing signature -> 401", async () => {
  resetSupaMock(); wire();
  const rEnv = setEnv(ENV);
  const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(FN);
    const body = evt();
    const res = await h(req(body, "")); // no signature
    assertEquals(res.status, 401);
  } finally { rF(); rEnv(); }
});

Deno.test("razorpay-webhook: wrong signature -> 401 (HMAC verify)", async () => {
  resetSupaMock(); wire();
  const rEnv = setEnv(ENV);
  const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(FN);
    const body = evt();
    const res = await h(req(body, "deadbeef"));
    assertEquals(res.status, 401);
  } finally { rF(); rEnv(); }
});

Deno.test("razorpay-webhook: tampered body with old signature -> 401", async () => {
  resetSupaMock(); wire();
  const rEnv = setEnv(ENV);
  const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(FN);
    const body = evt();
    const goodSig = await sign(SECRET, body);
    const tampered = body.replace("10000", "1"); // attacker lowers amount after signing
    const res = await h(req(tampered, goodSig));
    assertEquals(res.status, 401);
  } finally { rF(); rEnv(); }
});

Deno.test("razorpay-webhook: valid signature + full payment -> 200 ok, quote settled, receipts sent", async () => {
  resetSupaMock(); wire({ total: 100 });
  const rEnv = setEnv(ENV);
  const rF = installFetch(() => jsonResponse({ id: "email_1" })); // resend not used (simulated), but safe
  try {
    const h = await loadHandler(FN);
    const body = evt();
    const res = await h(req(body, await sign(SECRET, body)));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "ok");
    // notifications insert happened (receipts recorded)
    assert(supaLog().some((e) => e.table === "notifications"), "notifications recorded");
  } finally { rF(); rEnv(); }
});

Deno.test("razorpay-webhook: REPLAY -> 200 idempotent, NO duplicate receipts", async () => {
  resetSupaMock(); wire({ total: 100, paidAlready: true }); // conditional update returns no row
  const rEnv = setEnv(ENV);
  let emailCalls = 0;
  const rF = installFetch((url) => { if (url.includes("resend")) emailCalls++; return jsonResponse({}); });
  try {
    const h = await loadHandler(FN);
    const body = evt();
    const res = await h(req(body, await sign(SECRET, body)));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "already paid or unknown quote (idempotent)");
    assert(!supaLog().some((e) => e.table === "notifications"), "no duplicate receipts on replay");
    assertEquals(emailCalls, 0);
  } finally { rF(); rEnv(); }
});

Deno.test("razorpay-webhook: UNDERPAYMENT -> not settled (200 mismatch), no receipts", async () => {
  resetSupaMock(); wire({ total: 200 }); // expected 20000 paise, paid only 10000
  const rEnv = setEnv(ENV);
  const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(FN);
    const body = evt(); // amount_paid 10000
    const { result: res, logs } = await captureConsoleError(async () => h(req(body, await sign(SECRET, body))));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "amount mismatch — not marked paid");
    // quotes table was NEVER updated to paid
    assert(!supaLog().some((e) => e.table === "quotes" && e.calls?.some((c: any[]) => c[0] === "update")),
      "quote must not be transitioned to paid on underpayment");
    assert(!supaLog().some((e) => e.table === "notifications"), "no receipts on underpayment");
  } finally { rF(); rEnv(); }
});

Deno.test("razorpay-webhook: unknown event type -> 200 ignored", async () => {
  resetSupaMock(); wire();
  const rEnv = setEnv(ENV);
  const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(FN);
    const body = JSON.stringify({ event: "payment.failed", payload: {} });
    const res = await h(req(body, await sign(SECRET, body)));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "ignored");
  } finally { rF(); rEnv(); }
});

Deno.test("razorpay-webhook: malformed quote_id -> 200 no quote (prevents retry storm)", async () => {
  resetSupaMock(); wire();
  const rEnv = setEnv(ENV);
  const rF = installFetch(() => { throw new Error("no fetch"); });
  try {
    const h = await loadHandler(FN);
    const body = JSON.stringify({
      event: "payment_link.paid",
      payload: { payment_link: { entity: { id: "p", amount_paid: 10000, notes: { quote_id: "not-a-uuid" } } } },
    });
    const res = await h(req(body, await sign(SECRET, body)));
    assertEquals(res.status, 200);
    assertEquals(await res.text(), "no quote");
  } finally { rF(); rEnv(); }
});

Deno.test("razorpay-webhook: HTML/CRLF-injected code/title are neutralised in email + subject", async () => {
  resetSupaMock();
  const evilQuote = {
    id: QID,
    code: "EV1<script>alert(1)</script>\r\nBcc: evil@x.com",
    title: "<img src=x onerror=alert(1)>",
    pricing: { total: 100 },
    client: { email: "c@x.com" },
  };
  wire({ total: 100, quote: evilQuote });
  const rEnv = setEnv({ ...ENV, RESEND_API_KEY: "re_key", RESEND_FROM: "Helm <e@helm.events>" });
  const sentEmails: any[] = [];
  const rF = installFetch((url, init) => {
    if (url.includes("resend")) sentEmails.push(JSON.parse((init as any).body));
    return jsonResponse({ id: "email_1" });
  });
  try {
    const h = await loadHandler(FN);
    const body = evt();
    const res = await h(req(body, await sign(SECRET, body)));
    assertEquals(res.status, 200);
    assert(sentEmails.length >= 1, "emails sent via resend");
    for (const m of sentEmails) {
      assert(!m.html.includes("<script>"), "script tag must be escaped in html body");
      assert(!m.html.includes("<img src=x"), "img tag must be escaped in html body");
      assert(m.html.includes("&lt;script&gt;"), "escaped entity present");
      // subject strips CR/LF (header injection)
      assert(!/[\r\n]/.test(m.subject), "subject must not contain CR/LF");
    }
  } finally { rF(); rEnv(); }
});

// ---- timingSafeEqual property check (constant-time compare, length-guarded) ----
Deno.test("razorpay-webhook: source uses crypto.subtle HMAC-SHA256 + timingSafeEqual (audit)", async () => {
  const src = await Deno.readTextFile(new URL(FN, import.meta.url));
  assert(/crypto\.subtle\.importKey/.test(src) && /HMAC/.test(src) && /SHA-256/.test(src), "HMAC-SHA256 via WebCrypto");
  assert(/function timingSafeEqual/.test(src), "constant-time compare present");
  assert(/a\.length\s*!==\s*b\.length/.test(src), "length guard present");
});
