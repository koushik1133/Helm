// invite-signup (0205) — a brand-new invitee can always join. Fake invites, mocked Supabase, no network,
// no real e-mail: peek gives the invite context, a login the invite e-mail made without a password is
// "needs_link" (never "sign in"), "Email me a new link" goes only to the invitation's own e-mail.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { setEnv, installFetch, jsonResponse, loadHandler, post, resetSupaMock, supaLog, fetchLog, captureConsoleError } from "./harness.ts";

const g = globalThis as any;
const FN = "../../supabase/functions/invite-signup/index.ts";
const TOK = "c".repeat(48);
const ENV = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-role-secret" };
const RESEND = { ...ENV, RESEND_API_KEY: "re_test", RESEND_FROM: "Helm <notifications@helm.events>" };
const ORG = "a0000000-0000-4000-8000-000000000201", ADMIN = "b0000000-0000-4000-8000-000000000201";
const future = () => new Date(Date.now() + 86400000).toISOString();
const PW = "Str0ng!Password#1";
// R32 AUTH-1: the e-mailed link's mail key; the DB row keeps only its SHA-256
const KEY = "ab".repeat(24);
const KEY_HASH = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(KEY)))].map((b) => b.toString(16).padStart(2, "0")).join("");
const auth = () => supaLog().filter((l) => l.auth);
const noFetch = () => installFetch(() => { throw new Error("no fetch expected"); });

function db(o: { status?: string; expires_at?: string; state?: unknown; email?: string; stateErr?: boolean; relink?: unknown; keyHash?: string | null } = {}) {
  const inv = { id: "i1", email: o.email ?? "Shagantikoushik+test@gmail.com", status: o.status ?? "pending", expires_at: o.expires_at ?? future(), org_id: ORG, role: "coordinator", invited_by: ADMIN,
    mail_key_hash: o.keyHash === undefined ? KEY_HASH : o.keyHash };
  g.__supaResolver = (table: string) => table === "invitations" ? { data: inv, error: null }
    : table === "organizations" ? { data: { name: "ABCD" }, error: null }
    : table === "profiles" ? { data: { full_name: "Priya Shah" }, error: null } : { data: null, error: null };
  g.__supaRpc = (name: string) => name === "invite_account_state"
    ? (o.stateErr ? { data: null, error: { code: "PGRST202" } } : { data: o.state ?? { valid: true, account: "none", confirmed: false }, error: null })
    : name === "invite_request_new_link" ? { data: o.relink ?? { result: "requested", studio: "ABCD" }, error: null } : { data: null, error: null };
}
const exists = { data: null, error: { status: 422, code: "email_exists", message: "A user with this email address has already been registered" } };

Deno.test("invite-signup peek: invite context (studio, inviter name, role label) + the invited e-mail + account state", async () => {
  resetSupaMock(); db({ state: { valid: true, account: "needs_password", confirmed: true } });
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: TOK, peek: true }));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { email: "shagantikoushik+test@gmail.com", studio: "ABCD", inviter: "Priya Shah", role: "coordinator", role_label: "Event coordinator", account: "needs_link" });
    assertEquals(auth().length, 0);
  } finally { f(); r(); }
});

Deno.test("invite-signup peek: 0205 not applied -> context without account (old behaviour)", async () => {
  resetSupaMock(); db({ stateErr: true });
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const j = await (await h(post({ token: TOK, peek: true }))).json();
    assertEquals(j.account, undefined); assertEquals(j.studio, "ABCD");
  } finally { f(); r(); }
});

for (const [status, exp, reason] of [["pending", "2020-01-01T00:00:00Z", "expired"], ["accepted", undefined, "used"], ["revoked", undefined, "revoked"]] as const) {
  Deno.test(`invite-signup peek: ${reason} token -> 400 invalid_invite with reason + studio only (no e-mail)`, async () => {
    resetSupaMock(); db({ status, expires_at: exp });
    const r = setEnv(ENV); const f = noFetch();
    try {
      const h = await loadHandler(FN);
      const res = await h(post({ token: TOK, peek: true }));
      assertEquals(res.status, 400);
      const j = await res.json();
      assertEquals([j.code, j.reason, j.studio], ["invalid_invite", reason, "ABCD"]);
      assert(!JSON.stringify(j).includes("@"), "no address for a dead token");
      if (reason === "expired") assert(j.error.includes("ask ABCD to resend it"));
    } finally { f(); r(); }
  });
}

Deno.test("invite-signup: new e-mail -> account created confirmed for the invited address", async () => {
  resetSupaMock(); db();
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: TOK, email: "shagantikoushik+test@gmail.com", password: PW, full_name: "Koushik", k: KEY }));
    assertEquals(res.status, 200);
    const c = auth().find((a) => a.auth === "createUser");
    assertEquals(c?.args.email, "shagantikoushik+test@gmail.com"); assertEquals(c?.args.email_confirm, true);
  } finally { f(); r(); }
});

Deno.test("invite-signup: login made by the invite e-mail (no password) -> 409 needs_link, NEVER 'sign in'", async () => {
  resetSupaMock(); db({ state: { valid: true, account: "needs_password", confirmed: false } });
  g.__supaAuth = (op: string) => op === "createUser" ? exists : { data: {}, error: null };
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: TOK, email: "shagantikoushik+test@gmail.com", password: PW, k: KEY }));
    assertEquals(res.status, 409);
    const j = await res.json();
    assertEquals(j.code, "needs_link");
    assert(!/sign in instead/i.test(j.error) && /24 hours/.test(j.error));
  } finally { f(); r(); }
});

Deno.test("invite-signup: real account with a password -> 409 account_exists (sign in, invite kept)", async () => {
  resetSupaMock(); db({ state: { valid: true, account: "existing", confirmed: true } });
  g.__supaAuth = (op: string) => op === "createUser" ? exists : { data: {}, error: null };
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: TOK, email: "shagantikoushik+test@gmail.com", password: PW, k: KEY }));
    assertEquals(res.status, 409); assertEquals((await res.json()).code, "account_exists");
  } finally { f(); r(); }
});

Deno.test("invite-signup resend (no provider): never confirmed -> Invite user e-mail again, to the invited address only", async () => {
  resetSupaMock(); db({ state: { valid: true, account: "needs_password", confirmed: false } });
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: TOK, resend: true, email: "attacker@evil.test" }));
    assertEquals(res.status, 200); assertEquals(await res.json(), { ok: true, sent: true });
    assertEquals(auth().map((a) => a.auth), ["inviteUserByEmail"]);
    assertEquals(auth()[0].args, { email: "shagantikoushik+test@gmail.com", opts: { redirectTo: "https://www.helm.events/login?invite=" + TOK } });
  } finally { f(); r(); }
});

Deno.test("invite-signup resend (no provider): link already opened (confirmed) -> magic link, never creates a user", async () => {
  resetSupaMock(); db({ state: { valid: true, account: "needs_password", confirmed: true } });
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ token: TOK, resend: true }))).status, 200);
    assertEquals(auth().map((a) => a.auth), ["signInWithOtp"]);
    assertEquals(auth()[0].args, { email: "shagantikoushik+test@gmail.com", options: { shouldCreateUser: false, emailRedirectTo: "https://www.helm.events/login?invite=" + TOK } });
  } finally { f(); r(); }
});

Deno.test("invite-signup resend (no provider): invite refused as already registered -> falls back to the magic link", async () => {
  resetSupaMock(); db({ state: { valid: true, account: "needs_password", confirmed: false } });
  g.__supaAuth = (op: string) => op === "inviteUserByEmail" ? exists : { data: {}, error: null };
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ token: TOK, resend: true }))).status, 200);
    assertEquals(auth().map((a) => a.auth), ["inviteUserByEmail", "signInWithOtp"]);
  } finally { f(); r(); }
});

Deno.test("invite-signup resend (provider set): Supabase only makes the link, Helm sends the branded e-mail", async () => {
  resetSupaMock(); db({ state: { valid: true, account: "needs_password", confirmed: true } });
  g.__supaAuth = (op: string) => op === "generateLink" ? { data: { properties: { action_link: "https://proj.supabase.co/auth/v1/verify?token=abc&type=magiclink&redirect_to=https://www.helm.events/login?invite=" + TOK, hashed_token: "f".repeat(56) } }, error: null } : { data: {}, error: null };
  const r = setEnv(RESEND);
  const f = installFetch((url) => { if (url === "https://api.resend.com/emails") return jsonResponse({ id: "x" }); throw new Error("unexpected " + url); });
  try {
    const h = await loadHandler(FN);
    assertEquals((await h(post({ token: TOK, resend: true }))).status, 200);
    assertEquals(auth().map((a) => a.auth), ["generateLink"]);
    assertEquals(auth()[0].args, { type: "magiclink", email: "shagantikoushik+test@gmail.com", options: { redirectTo: "https://www.helm.events/login?invite=" + TOK } });
    const m = JSON.parse(String(fetchLog()[0].init?.body));
    assertEquals(m.to, ["shagantikoushik+test@gmail.com"]); assertEquals(m.subject, "Join ABCD on Helm");
    assert(m.html.includes("Set my password") && m.html.includes("Priya Shah") && m.html.includes("Event coordinator"));
    // 0205: the link is on Helm's own domain - the Supabase project URL never appears in the e-mail
    const own = "https://www.helm.events/auth/confirm?token_hash=" + "f".repeat(56) + "&amp;type=magiclink&amp;next=%2Flogin%3Finvite%3D" + TOK;
    assert(m.html.includes(own), "own-domain confirm link");
    assert(!m.html.includes("supabase.co") && !m.text.includes("supabase.co"), "no Supabase URL");
  } finally { f(); r(); }
});

Deno.test("invite-signup resend: no login yet -> { account: new } (the join form), nothing sent", async () => {
  resetSupaMock(); db({ state: { valid: true, account: "none", confirmed: false } });
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    assertEquals(await (await h(post({ token: TOK, resend: true }))).json(), { account: "new" });
    assertEquals(auth().length, 0);
  } finally { f(); r(); }
});

Deno.test("invite-signup resend: real account -> 409 account_exists, nothing sent", async () => {
  resetSupaMock(); db({ state: { valid: true, account: "existing", confirmed: true } });
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: TOK, resend: true }));
    assertEquals(res.status, 409); assertEquals(auth().length, 0);
  } finally { f(); r(); }
});

Deno.test("invite-signup resend: expired invitation -> asks the studio (bell), never renews, no e-mail", async () => {
  resetSupaMock(); db({ expires_at: "2020-01-01T00:00:00Z" });
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: TOK, resend: true }));
    assertEquals(res.status, 200); assertEquals(await res.json(), { requested: true, studio: "ABCD" });
    assert(supaLog().some((l) => l.rpc === "invite_request_new_link"));
    assertEquals(auth().length, 0);
  } finally { f(); r(); }
});

Deno.test("invite-signup resend: 3 per invitation per hour, then 429", async () => {
  resetSupaMock(); db({ state: { valid: true, account: "needs_password", confirmed: true } });
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const st: number[] = [];
    for (let i = 0; i < 4; i++) st.push((await h(post({ token: TOK, resend: true }))).status);
    assertEquals(st, [200, 200, 200, 429]);
    assertEquals(auth().length, 3);
  } finally { f(); r(); }
});

Deno.test("invite-signup resend: provider error -> 502 send_failed, rate limit -> 429, no PII in logs", async () => {
  resetSupaMock(); db({ state: { valid: true, account: "needs_password", confirmed: true } });
  g.__supaAuth = () => ({ data: null, error: { status: 500, message: "smtp down for shagantikoushik+test@gmail.com" } });
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const { result: res, logs } = await captureConsoleError(() => Promise.resolve(h(post({ token: TOK, resend: true }))));
    assertEquals(res.status, 502); assertEquals((await res.json()).code, "send_failed");
    assert(!logs.join(" ").includes("@") && !logs.join(" ").includes(TOK));
    g.__supaAuth = () => ({ data: null, error: { status: 429, message: "over_email_send_rate_limit" } });
    const res2 = await h(post({ token: TOK, resend: true }));
    assertEquals(res2.status, 429);
  } finally { f(); r(); }
});

Deno.test("invite-signup: self sign-up never confirmed -> 409 needs_link (reason unconfirmed), resend re-sends the invite e-mail", async () => {
  resetSupaMock(); db({ state: { valid: true, account: "unconfirmed", confirmed: false } });
  g.__supaAuth = (op: string) => op === "createUser" ? exists : { data: {}, error: null };
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: TOK, email: "shagantikoushik+test@gmail.com", password: PW, k: KEY }));
    assertEquals(res.status, 409);
    const j = await res.json();
    assertEquals([j.code, j.reason], ["needs_link", "unconfirmed"]);
    const peek = await (await h(post({ token: TOK, peek: true }))).json();
    assertEquals(peek.account, "unconfirmed");
    assertEquals((await h(post({ token: TOK, resend: true }))).status, 200);
    assertEquals(auth().map((a) => a.auth), ["createUser", "inviteUserByEmail"]);
  } finally { f(); r(); }
});

// r21 (0248): an invitation bound to Helm's own domain never makes, re-links or e-mails a login
Deno.test("invite-signup: invitation to a reserved helm.events address -> 403 reserved_domain, no login made or sent", async () => {
  for (const body of [{ token: TOK, email: "anil@helm.events", password: PW }, { token: TOK, resend: true }]) {
    resetSupaMock(); db({ email: "Anil@HELM.events" });
    const r = setEnv(ENV); const f = noFetch();
    try {
      const h = await loadHandler(FN);
      const res = await h(post(body));
      assertEquals(res.status, 403);
      const j = await res.json();
      assertEquals(j.code, "reserved_domain");
      assert(String(j.error).startsWith("Addresses on helm.events are reserved for the Helm team."));
      assertEquals(auth().length, 0);
    } finally { f(); r(); }
  }
});
Deno.test("invite-signup: the database allowlist wins (email_is_reserved = false) -> staff invite proceeds", async () => {
  resetSupaMock(); db({ email: "newhire@helm.events" });
  const rpc0 = g.__supaRpc; g.__supaRpc = (name: string, args: unknown) => name === "email_is_reserved" ? { data: false, error: null } : rpc0(name, args);
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: TOK, email: "newhire@helm.events", password: PW, k: KEY }));
    assertEquals(res.status, 200);
    assert(auth().some((a) => a.auth === "createUser"));
  } finally { f(); r(); }
});
Deno.test("invite-signup email_send: a reserved address is refused (403), email_lookup just says not invited", async () => {
  resetSupaMock(); db();
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const s = await h(post({ email_send: true, email: "x@team.helm.events" }));
    assertEquals(s.status, 403); assertEquals((await s.json()).code, "reserved_domain");
    const l = await h(post({ email_lookup: true, email: "x@helm.com" }));
    assertEquals(await l.json(), { invited: false });
    assertEquals(auth().length, 0);
  } finally { f(); r(); }
});

// ---- r57 (audit A-4): the signed-out e-mail look-up says only yes / no - never the studio or the role ----------------
Deno.test("r57 A-4: email_lookup for an invited e-mail answers { invited: true } only (no studio, role or token)", async () => {
  resetSupaMock(); db();
  const prevRpc = g.__supaRpc;
  g.__supaRpc = (name: string, args: unknown) => name === "invite_open_for_email"
    ? { data: { found: true, token: TOK, studio: "Secret Studio", role: "coordinator", invited_by: ADMIN, expires_at: future() }, error: null }
    : prevRpc(name, args);
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const l = await h(post({ email_lookup: true, email: "someone@corp.test" }));
    const body = await l.json();
    assertEquals(body, { invited: true });
    assert(!JSON.stringify(body).includes("Secret Studio") && !JSON.stringify(body).includes(TOK));
  } finally { f(); r(); }
});

// ---- R32 AUTH-1: the token alone (the studio's "Copy link") never makes a CONFIRMED login --------------------
Deno.test("R32 AUTH-1: token without the e-mailed mail key -> { fallback: true }, no createUser (admin can't pre-make a confirmed login)", async () => {
  for (const [label, body, keyHash] of [
    ["no k", { token: TOK, email: "shagantikoushik+test@gmail.com", password: PW }, KEY_HASH],
    ["wrong k", { token: TOK, email: "shagantikoushik+test@gmail.com", password: PW, k: "cd".repeat(24) }, KEY_HASH],
    ["k not hex", { token: TOK, email: "shagantikoushik+test@gmail.com", password: PW, k: KEY + "'" }, KEY_HASH],
    ["old invitation (no key stored)", { token: TOK, email: "shagantikoushik+test@gmail.com", password: PW, k: KEY }, null],
  ] as const) {
    resetSupaMock(); db({ keyHash: keyHash as string | null });
    const r = setEnv(ENV); const f = noFetch();
    try {
      const h = await loadHandler(FN);
      const res = await h(post(body));
      assertEquals(res.status, 200, label);
      assertEquals(await res.json(), { fallback: true }, label);
      assertEquals(auth().filter((a) => a.auth === "createUser").length, 0, label + ": no login made");
    } finally { f(); r(); }
  }
});

Deno.test("R32 AUTH-1: e-mailed key -> confirmed login + recorded in a155_admin_created (invite_signup_record)", async () => {
  resetSupaMock(); db();
  const rec: unknown[] = [];
  const base = g.__supaRpc;
  g.__supaRpc = (name: string, args: unknown) => { if (name === "invite_signup_record") { rec.push(args); return { data: true, error: null }; } return base(name, args); };
  g.__supaAuth = (op: string) => op === "createUser" ? { data: { user: { id: "c0000000-0000-4000-8000-000000000301" } }, error: null } : { data: {}, error: null };
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: TOK, email: "shagantikoushik+test@gmail.com", password: PW, k: KEY.toUpperCase() }));
    assertEquals(res.status, 200); assertEquals(await res.json(), { ok: true });
    assertEquals(auth().find((a) => a.auth === "createUser")?.args.email_confirm, true);
    assertEquals(rec, [{ p_token: TOK, p_user: "c0000000-0000-4000-8000-000000000301" }]);
  } finally { f(); r(); }
});

Deno.test("R32 AUTH-1: 0282 not applied (no mail_key_hash column) -> fallback, never a confirmed login", async () => {
  resetSupaMock(); db();
  const inv = { id: "i1", email: "a@b.co", status: "pending", expires_at: future(), org_id: ORG, role: "coordinator", invited_by: ADMIN };
  let calls = 0;
  g.__supaResolver = (table: string) => table === "invitations"
    ? (++calls === 1 ? { data: null, error: { code: "42703", message: "column invitations.mail_key_hash does not exist" } } : { data: inv, error: null })
    : { data: null, error: null };
  const r = setEnv(ENV); const f = noFetch();
  try {
    const h = await loadHandler(FN);
    const res = await h(post({ token: TOK, email: "a@b.co", password: PW, k: KEY }));
    assertEquals(await res.json(), { fallback: true });
    assertEquals(auth().filter((a) => a.auth === "createUser").length, 0);
  } finally { f(); r(); }
});
