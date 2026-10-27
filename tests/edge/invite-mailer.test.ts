// invite-mailer (0131 + 0205) — every invitee gets the SAME invitation: "Join <Studio> on Helm" -
// "<Inviter> invited you as <Role>" [Accept invitation] -> /login?invite=<token>. With a provider
// (Resend here) Supabase is never asked to create a login; without one, the Supabase "Invite user"
// e-mail (new address) and "Magic link" e-mail (existing account, its invitation metadata refreshed
// first) carry the same studio / role label / inviter. Fake invites, mocked providers, no network.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, resetSupaMock, supaLog, fetchLog, captureConsoleError } from "./harness.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/invite-mailer/index.ts";
const SECRET = "invite-shared-secret";
const BASE = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret", SUPABASE_ANON_KEY: "anon", HELM_INVITE_EMAIL_SECRET: SECRET };
const RESEND = { ...BASE, RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <notifications@helm.events>" };
const T_NEW = "a".repeat(48), T_OLD = "b".repeat(48);
const ID1 = "c0000000-0000-4000-8000-0000000201a1", ID2 = "c0000000-0000-4000-8000-0000000201a2";
const UID = "d0000000-0000-4000-8000-0000000201b1";
const rows = () => [
  { id: ID1, to: "brand.new@ia.test", token: T_NEW, inviter: "Priya Shah", studio: "ABCD", role: "coordinator", expires_at: "2026-10-25T00:00:00Z" },
  { id: ID2, to: "already@ia.test", token: T_OLD, inviter: "Priya Shah", studio: "ABCD", role: "coordinator", expires_at: "2026-10-25T00:00:00Z" },
];
const req = () => new Request("https://fn.local/", { method: "POST", headers: { "x-helm-cron-secret": SECRET } });
const auth = () => supaLog().filter((l) => l.auth);
const marks = () => supaLog().filter((l) => l.rpc === "invite_email_outbox_mark");

function db() {
  g.__supaRpc = (name: string) => name === "invite_email_outbox_claim" ? { data: rows(), error: null }
    : name === "invite_auth_user_id" ? { data: UID, error: null } : { data: "ok", error: null };
}

Deno.test("invite-mailer: provider set -> one branded invitation for new AND existing addresses, no Supabase login made", async () => {
  resetSupaMock(); db();
  const r = setEnv(RESEND);
  const f = installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ id: "x" }); throw new Error("unexpected " + url); });
  try {
    const h = await loadHandler(FN);
    const res = await h(req());
    assertEquals(res.status, 200);
    assertEquals((await res.json()).sent, 2);
    const sent = fetchLog().map((c) => JSON.parse(String(c.init?.body)));
    assertEquals(sent.length, 2);
    for (const [i, m] of sent.entries()) {
      const tok = i === 0 ? T_NEW : T_OLD;
      assertEquals(m.subject, "Join ABCD on Helm");
      assert(m.html.includes("Accept invitation") && m.html.includes("Event coordinator") && m.html.includes("Priya Shah"), "same branded body");
      assert(m.html.includes("https://www.helm.events/login?invite=" + tok), "join page link");
      assert(m.text.includes("Priya Shah invited you as Event coordinator"), "plain text line");
    }
    assertEquals(sent[0].html.replaceAll(T_NEW, "T").replaceAll("brand.new@ia.test", "E"), sent[1].html.replaceAll(T_OLD, "T").replaceAll("already@ia.test", "E"), "identical e-mail for both invitees");
    assertEquals(auth().length, 0, "no inviteUserByEmail / magic link / user change");
    assertEquals(marks().map((m) => m.args.p_status), ["sent", "sent"]);
  } finally { f(); r(); }
});

Deno.test("invite-mailer: re-invite (same token queued again) -> the same invitation again", async () => {
  resetSupaMock(); db();
  const r = setEnv(RESEND);
  const f = installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ id: "x" }); throw new Error("unexpected " + url); });
  try {
    const h = await loadHandler(FN);
    await h(req()); await h(req());
    const bodies = fetchLog().map((c) => JSON.parse(String(c.init?.body)));
    assertEquals(bodies.length, 4);
    assertEquals(bodies[0].html, bodies[2].html); assertEquals(bodies[0].subject, bodies[2].subject);
  } finally { f(); r(); }
});

Deno.test("invite-mailer: no provider -> Supabase Invite user / Magic link carry the SAME studio, role label and inviter", async () => {
  resetSupaMock(); db();
  g.__supaAuth = (op: string, args: any) => {
    if (op === "inviteUserByEmail" && args.email === "already@ia.test") return { data: null, error: { status: 422, code: "email_exists", message: "A user with this email address has already been registered" } };
    return { data: {}, error: null };
  };
  const r = setEnv(BASE);
  const f = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    const { result: res, logs } = await captureConsoleError(() => Promise.resolve(h(req())));
    assertEquals(res.status, 200);
    const meta = { studio: "ABCD", role: "Event coordinator", invited_by: "Priya Shah" };
    const inv = auth().filter((a) => a.auth === "inviteUserByEmail");
    assertEquals(inv.length, 2);
    assertEquals(inv[0].args.opts, { redirectTo: "https://www.helm.events/login?invite=" + T_NEW, data: meta });
    const upd = auth().find((a) => a.auth === "updateUserById");
    assertEquals(upd?.args, { id: UID, attrs: { user_metadata: meta } }, "existing login gets the same invitation keys first");
    const otp = auth().find((a) => a.auth === "signInWithOtp");
    assertEquals(otp?.args, { email: "already@ia.test", options: { shouldCreateUser: false, emailRedirectTo: "https://www.helm.events/login?invite=" + T_OLD } });
    const order = auth().map((a) => a.auth);
    assert(order.indexOf("updateUserById") < order.indexOf("signInWithOtp"), "metadata before the magic link");
    assert(supaLog().some((l) => l.rpc === "invite_auth_user_id" && l.args.p_token === T_OLD));
    assertEquals(marks().map((m) => m.args.p_status), ["sent", "sent"]);
    assert(!logs.join(" ").includes("@") && !logs.join(" ").includes(T_OLD), "no PII / token in logs");
  } finally { f(); r(); }
});

Deno.test("invite-mailer: no provider + 0205 not applied -> magic link still sent (plain text), never blocked", async () => {
  resetSupaMock();
  g.__supaRpc = (name: string) => name === "invite_email_outbox_claim" ? { data: [rows()[1]], error: null }
    : name === "invite_auth_user_id" ? { data: null, error: { code: "PGRST202", message: "not found" } } : { data: "ok", error: null };
  g.__supaAuth = (op: string) => op === "inviteUserByEmail" ? { data: null, error: { status: 422, message: "already registered" } } : { data: {}, error: null };
  const r = setEnv(BASE); const f = installFetch(() => { throw new Error("no fetch expected"); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(req())).status, 200);
    assert(!auth().some((a) => a.auth === "updateUserById"));
    assert(auth().some((a) => a.auth === "signInWithOtp"));
    assertEquals(marks()[0].args.p_status, "sent");
  } finally { f(); r(); }
});

// R32 AUTH-1: the branded e-mail's join link carries a fresh mail key (&k=); the database stores only its
// SHA-256 (invite_mail_key_set). Without 0282 (RPC missing / not true) the e-mail goes out without &k=.
Deno.test("R32 AUTH-1: branded invitation link carries &k=<key>; only SHA-256(key) is stored", async () => {
  resetSupaMock();
  const stored: Record<string, string> = {};
  g.__supaRpc = (name: string, args: any) => name === "invite_email_outbox_claim" ? { data: rows(), error: null }
    : name === "invite_mail_key_set" ? (stored[args.p_token] = args.p_hash, { data: true, error: null }) : { data: "ok", error: null };
  const r = setEnv(RESEND);
  const f = installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ id: "x" }); throw new Error("unexpected " + url); });
  try {
    const h = await loadHandler(FN);
    await h(req());
    const sent = fetchLog().map((c) => JSON.parse(String(c.init?.body)));
    assertEquals(sent.length, 2);
    const keys: string[] = [];
    for (const [i, m] of sent.entries()) {
      const tok = i === 0 ? T_NEW : T_OLD;
      const mm = new RegExp("/login\\?invite=" + tok + "&(?:amp;)?k=([0-9a-f]{48})").exec(m.html);
      assert(mm, "join link has the mail key");
      assert(m.text.includes("/login?invite=" + tok + "&k=" + mm![1]));
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(mm![1])))].map((b) => b.toString(16).padStart(2, "0")).join("");
      assertEquals(stored[tok], hash, "DB keeps the hash, never the key");
      assert(!Object.values(stored).includes(mm![1]));
      keys.push(mm![1]);
    }
    assert(keys[0] !== keys[1], "a fresh key per e-mail");
  } finally { f(); r(); }
});
