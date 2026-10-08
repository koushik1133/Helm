// verify-upload — magic-byte sniffing per bucket, dormant mode, shared-secret gate,
// dormant / allowlisted / timed-out antivirus, reject → mark + quarantine. Mock-only, no network.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, resetSupaMock, supaLog, fetchLog } from "./harness.ts";
import { sniff, verdict } from "../../supabase/functions/verify-upload/sniff.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/verify-upload/index.ts";
const SECRET = "scan-secret-test";
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" };
const ON = { ...BASE, HELM_UPLOAD_SCAN_ENABLED: "true", HELM_UPLOAD_SCAN_SECRET: SECRET };
const ID = "c0000000-0000-4000-8000-000000000001";
const ORGP = "a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/";

const pad = (h: number[], n = 64) => { const b = new Uint8Array(n); b.set(h); return b; };
const PNG = pad([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const PDF = pad([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31]);
const JPG = pad([0xFF, 0xD8, 0xFF, 0xE0]);
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>____");
const req = (h: Record<string, string> = { "x-helm-cron-secret": SECRET }) =>
  new Request("https://fn.local/", { method: "POST", headers: h, body: JSON.stringify({ type: "INSERT", record: { bucket_id: "evil", name: "../x" } }) });

// exports (avScan / secretMatches) from index.ts with Deno.serve stubbed
async function mod() {
  const orig = (Deno as any).serve;
  (Deno as any).serve = () => ({ finished: Promise.resolve(), shutdown() {} });
  try { return await import(`${FN}?m=${crypto.randomUUID()}`); } finally { (Deno as any).serve = orig; }
}

// ---- sniffing -------------------------------------------------------------------
Deno.test("sniff: recognises png/pdf/jpg, rejects html and short input", () => {
  assertEquals(sniff(PNG)?.mime, "image/png");
  assertEquals(sniff(PDF)?.mime, "application/pdf");
  assertEquals(sniff(JPG)?.mime, "image/jpeg");
  assertEquals(sniff(HTML), null);
  assertEquals(sniff(new Uint8Array(4)), null);
});
Deno.test("verdict: matching bytes + extension + bucket → ok", () => {
  assert(verdict("event-docs", ORGP + "x.pdf", PDF, 1000, "application/pdf").ok);
  assert(verdict("invite-media", ORGP + "x.png", PNG, 1000, "image/png").ok);
  assert(verdict("chat-media", ORGP + "x.jpg", JPG, 1000, "image/jpg").ok);           // alias
});
Deno.test("verdict: mismatches and disallowed types are rejected", () => {
  const r = (v: any) => (v.ok ? "ok" : v.reason);
  assert(/mismatch/.test(r(verdict("event-docs", ORGP + "x.pdf", PNG, 1000, null))), "png bytes named .pdf");
  assert(/unrecognised/.test(r(verdict("event-docs", ORGP + "x.pdf", HTML, 1000, "application/pdf"))), "html as pdf");
  assert(/not allowed/.test(r(verdict("invite-media", ORGP + "x.pdf", PDF, 1000, null))), "pdf in invite-media");
  assert(/declared/.test(r(verdict("event-docs", ORGP + "x.png", PNG, 1000, "text/html"))), "declared text/html");
  assert(/size cap/.test(r(verdict("invite-media", ORGP + "x.png", PNG, 9_000_000, null))), "over cap");
  assert(/empty/.test(r(verdict("event-docs", ORGP + "x.png", PNG, 3, null))), "truncated");
  assert(/extension/.test(r(verdict("event-docs", ORGP + "x.svg", PNG, 1000, null))), "svg ext");
  assert(/not scanned/.test(r(verdict("helm-manual", "x.png", PNG, 1000, null))), "unknown bucket");
});

// ---- gate -------------------------------------------------------------------------
Deno.test("dormant: no flag → 200 dormant, no DB, no fetch", async () => {
  const restoreEnv = setEnv({ ...BASE, HELM_UPLOAD_SCAN_SECRET: SECRET });
  const restoreFetch = installFetch(() => { throw new Error("no fetch expected"); });
  resetSupaMock();
  try {
    const h = await loadHandler(FN);
    const res = await h(req());
    assertEquals(res.status, 200);
    assertEquals((await res.json()).status, "dormant");
    assertEquals(supaLog().filter((x) => x.rpc).length, 0);
    assertEquals(fetchLog().length, 0);
  } finally { restoreFetch(); restoreEnv(); }
});
Deno.test("secret: missing / wrong / unset secret → 401 before any DB call", async () => {
  for (const [env, hdr] of [[ON, {}], [ON, { "x-helm-cron-secret": "nope" }], [{ ...ON, HELM_UPLOAD_SCAN_SECRET: "" }, { "x-helm-cron-secret": "" }]] as const) {
    const restoreEnv = setEnv(env as any);
    resetSupaMock();
    try {
      const h = await loadHandler(FN);
      const res = await h(req(hdr as any));
      assertEquals(res.status, 401);
      assertEquals(supaLog().filter((x) => x.rpc).length, 0);
    } finally { restoreEnv(); }
  }
  const m = await mod();
  assert(await m.secretMatches("a", "a"));
  assert(!(await m.secretMatches("", "")));
  assert(!(await m.secretMatches("a", "b")));
});
Deno.test("body cap: oversize webhook payload → 413", async () => {
  const restoreEnv = setEnv(ON);
  try {
    const h = await loadHandler(FN);
    const res = await h(new Request("https://fn.local/", { method: "POST", headers: { "x-helm-cron-secret": SECRET, "content-length": "999999" }, body: "x" }));
    assertEquals(res.status, 413);
  } finally { restoreEnv(); }
});

// ---- scan run ------------------------------------------------------------------------
function db(rows: any[]) {
  const marks: any[] = [];
  g.__supaRpc = (name: string, args: any) => {
    if (name === "upload_scan_claim") return { data: rows, error: null };
    if (name === "upload_scan_mark") { marks.push(args); return { data: args.p_status, error: null }; }
    return { data: null, error: null };
  };
  return marks;
}
function storage(body: Uint8Array, av?: (u: string) => Response) {
  return installFetch((url) => {
    if (url.startsWith("https://proj.supabase.co/storage/v1/object/move")) return jsonResponse({ message: "ok" });
    if (url.startsWith("https://proj.supabase.co/storage/v1/object/")) return new Response(body, { status: 200 });
    if (av) return av(url);
    throw new Error("unexpected fetch " + url);
  });
}

Deno.test("run: caller-supplied bucket/path ignored; mismatch → rejected + quarantined", async () => {
  const restoreEnv = setEnv(ON);
  const restoreFetch = storage(PNG);
  resetSupaMock();
  const marks = db([{ object_id: ID, bucket_id: "event-docs", name: ORGP + "f.pdf", mimetype: "application/pdf" }]);
  try {
    const h = await loadHandler(FN);
    const res = await h(req());
    assertEquals(res.status, 200);
    const out = await res.json();
    assertEquals(out.rejected, 1);
    assertEquals(marks[0].p_status, "rejected");
    assert(fetchLog().some((f) => f.url.endsWith("/object/move") && String(f.init?.body).includes("upload-quarantine")));
    assert(!fetchLog().some((f) => f.url.includes("evil") || f.url.includes("..")));
  } finally { restoreFetch(); restoreEnv(); }
});
Deno.test("run: matching bytes, AV dormant → clean, no AV call", async () => {
  const restoreEnv = setEnv(ON);
  const restoreFetch = storage(PDF);
  resetSupaMock();
  const marks = db([{ object_id: ID, bucket_id: "event-docs", name: ORGP + "f.pdf", mimetype: "application/pdf" }]);
  try {
    const h = await loadHandler(FN);
    const out = await (await h(req())).json();
    assertEquals(out.clean, 1);
    assertEquals(marks[0].p_status, "clean");
    assertEquals(fetchLog().length, 1);   // only the download
  } finally { restoreFetch(); restoreEnv(); }
});
Deno.test("run: HELM_UPLOAD_QUARANTINE=keep → rejected but not moved", async () => {
  const restoreEnv = setEnv({ ...ON, HELM_UPLOAD_QUARANTINE: "keep" });
  const restoreFetch = storage(HTML);
  resetSupaMock();
  const marks = db([{ object_id: ID, bucket_id: "invite-media", name: ORGP + "f.png", mimetype: "image/png" }]);
  try {
    const h = await loadHandler(FN);
    await h(req());
    assertEquals(marks[0].p_status, "rejected");
    assert(!fetchLog().some((f) => f.url.endsWith("/object/move")));
  } finally { restoreFetch(); restoreEnv(); }
});

// ---- antivirus ----------------------------------------------------------------------
const AV = { ...ON, HELM_AV_URL: "https://av.example.com/scan", HELM_AV_ALLOWED_HOSTS: "av.example.com", HELM_AV_TIMEOUT_MS: "1000" };
Deno.test("AV: infected verdict → rejected", async () => {
  const restoreEnv = setEnv(AV);
  const restoreFetch = storage(PDF, (u) => u.startsWith("https://av.example.com/") ? jsonResponse({ status: "FOUND" }) : (() => { throw new Error(u); })());
  resetSupaMock();
  const marks = db([{ object_id: ID, bucket_id: "event-docs", name: ORGP + "f.pdf", mimetype: null }]);
  try {
    const h = await loadHandler(FN);
    await h(req());
    assertEquals(marks[0].p_status, "rejected");
    assertEquals(marks[0].p_reason, "antivirus: infected");
  } finally { restoreFetch(); restoreEnv(); }
});
Deno.test("AV: clean verdict → clean", async () => {
  const restoreEnv = setEnv(AV);
  const restoreFetch = storage(PDF, () => jsonResponse({ infected: false }));
  resetSupaMock();
  const marks = db([{ object_id: ID, bucket_id: "event-docs", name: ORGP + "f.pdf", mimetype: null }]);
  try {
    const h = await loadHandler(FN);
    await h(req());
    assertEquals(marks[0].p_status, "clean");
    assertEquals(marks[0].p_reason, "magic+av ok");
  } finally { restoreFetch(); restoreEnv(); }
});
Deno.test("AV: host not allowlisted / http → never called, object stays pending (retry)", async () => {
  for (const bad of [{ HELM_AV_ALLOWED_HOSTS: "other.example.com" }, { HELM_AV_URL: "http://av.example.com/scan" }]) {
    const restoreEnv = setEnv({ ...AV, ...bad });
    const restoreFetch = storage(PDF, (u) => { throw new Error("AV must not be called: " + u); });
    resetSupaMock();
    const marks = db([{ object_id: ID, bucket_id: "event-docs", name: ORGP + "f.pdf", mimetype: null }]);
    try {
      const h = await loadHandler(FN);
      await h(req());
      assertEquals(marks[0].p_status, "retry");
      assert(!fetchLog().some((f) => f.url.includes("av.example.com")));
    } finally { restoreFetch(); restoreEnv(); }
  }
});
Deno.test("AV: timeout → retry (stays pending)", async () => {
  const restoreEnv = setEnv(AV);
  const restoreFetch = installFetch((url, init) => {
    if (url.startsWith("https://proj.supabase.co/")) return new Response(PDF, { status: 200 });
    return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
  });
  resetSupaMock();
  const marks = db([{ object_id: ID, bucket_id: "event-docs", name: ORGP + "f.pdf", mimetype: null }]);
  try {
    const h = await loadHandler(FN);
    await h(req());
    assertEquals(marks[0].p_status, "retry");
  } finally { restoreFetch(); restoreEnv(); }
});
Deno.test("AV: unset → avScan reports off", async () => {
  const restoreEnv = setEnv(ON);
  try { const m = await mod(); assertEquals(await m.avScan(PDF), "off"); } finally { restoreEnv(); }
});
