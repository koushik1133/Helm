// r29 hotfix - live sign-up said "Couldn't create the studio. Something went wrong" for "Tharun@123456".
// Root cause (Supabase Auth logs): POST /signup -> 422 weak_password, reasons ["pwned"] (leaked-password check).
//  1. store-api authErrorInfo: every documented Supabase Auth code -> a clear message + "Ref: AUTH-<code>"
//  2. signUp / signIn / password change / invite set-password / reset / resend against a stub client (exact 422 body)
//  3. telemetry gets code / status / reasons only (never the e-mail, password or raw message)
//  4. local "easy to guess" check (Name@123456 ...) - meter never says "Strong" for it; checklist warns
//  5. login.html: inline + top error, aria-invalid, focus + scroll, form kept, meter follows the server's verdict
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const SA = r("public/store-api.js"), LOGIN = r("public/login.html"), RESET = r("public/reset-password.js"), IS = r("supabase/functions/invite-signup/index.ts");
const tests = []; const t = (n, f) => tests.push([n, f]);
const PWNED_BODY = { code: "weak_password", message: "Password is known to be weak and easy to guess, please choose a different one.", weak_password: { reasons: ["pwned"] } };
const PWNED_MSG = "This password is too common. Try a different one.";

async function env(o) {
  o = o || {};
  const calls = [], reports = [];
  const client = { auth: {
    async getSession() { return { data: { session: null } }; },
    onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    async signUp(a) { calls.push(["signUp", a]); return { data: { user: null, session: null }, error: o.err || null }; },
    async signInWithPassword(a) { calls.push(["signIn", a]); return { data: {}, error: o.err || null }; },
    async signOut() { return { error: null }; },
    async resetPasswordForEmail() { return { error: o.err || null }; },
    async resend() { return { error: o.err || null }; },
    async updateUser() { return { data: {}, error: o.err || null }; },
  }, rpc: async () => ({ data: null, error: null }), from: () => ({}) };
  const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const el = (tag) => ({ tag, style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, appendChild() {}, addEventListener() {}, querySelector: () => null, remove() {} });
  const doc = { readyState: "complete", addEventListener() {}, removeEventListener() {}, currentScript: { src: "https://www.helm.events/store-api.js?v=1" },
    createElement: el, head: { appendChild() {} }, body: { appendChild() {}, removeChild() {}, insertBefore() {}, firstChild: null },
    documentElement: { setAttribute() {}, getAttribute() { return "light"; }, classList: { contains: () => false, add() {}, remove() {} } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
  const win = { location: { origin: "https://www.helm.events", hostname: "www.helm.events", pathname: "/login.html", search: "", hash: "", href: "https://www.helm.events/login.html", replace() {}, reload() {} },
    SUPABASE_CONFIG: { url: "https://abcdefghijklmnopqrst.supabase.co", anonKey: "anon" }, document: doc, navigator: { onLine: true },
    localStorage: store(), sessionStorage: store(), addEventListener() {}, removeEventListener() {},
    setTimeout: (fn, ms) => { if (!ms || ms < 1000) { try { fn(); } catch (e) {} } return 0; }, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    atob: (b) => Buffer.from(b, "base64").toString("binary"),
    supabase: { createClient: () => client }, console: { log() {}, info() {}, warn() {}, error() {}, debug() {} }, fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    HelmTelemetry: { report: (k, e) => reports.push([k, e && e.message]) },
    Date, Promise, URLSearchParams, URL, JSON, Math, Object, Array, String, Number, RegExp, Error, Map, Set };
  win.window = win; win.globalThis = win; win.self = win;
  const ctx = vm.createContext(win);
  try { vm.runInContext(SA, ctx); } catch (e) { if (process.env.R29_DEBUG) console.error(e); }
  const S = win.BPStore; try { await S.init(); } catch (e) {}
  return { S, calls, reports, win };
}

t("1 the user's exact case: signUp -> 422 weak_password ['pwned'] -> the 'too common' message + Ref, field pw, reported", async () => {
  for (const err of [Object.assign({ status: 422 }, PWNED_BODY), { status: 422, code: "weak_password", message: PWNED_BODY.message, reasons: ["pwned"], name: "AuthWeakPasswordError" }]) {
    const { S, calls, reports, win } = await env({ err });
    const e = await S.auth.signUp("tharun.studios@gmail.com", "Tharun@123456", { fullName: "Tharun studios", termsAgreed: true }).then(() => null, (x) => x);
    assert.equal(calls.length, 1, "Supabase was called");
    assert.ok(e && e.authMapped === true, "mapped");
    assert.equal(e.message, PWNED_MSG + " (Ref: AUTH-weak_password)");
    assert.equal(e.code, "weak_password"); assert.equal(e.field, "pw"); assert.equal(e.authCode, "weak_password");
    assert.ok(!/Something went wrong/.test(e.message));
    assert.equal(reports.length, 1); assert.equal(reports[0][0], "auth_error");
    assert.match(reports[0][1], /ctx=signup ref=AUTH-weak_password status=422 reasons=pwned/);
    assert.ok(!/tharun|gmail|@|123456|known to be weak/i.test(reports[0][1]), "no PII / password / raw message in telemetry");
    if (win.BPUI && win.BPUI.friendlyError) assert.equal(win.BPUI.friendlyError(e, { action: "create your account" }), e.message, "friendlyError shows it as-is");
  }
});

const CASES = [
  [{ code: "weak_password", status: 422, reasons: ["length"] }, /Too short\. Use 12 or more/, "pw"],
  [{ code: "weak_password", status: 422, reasons: ["characters"] }, /mix of uppercase and lowercase letters, numbers & symbols/, "pw"],
  [{ code: "weak_password", status: 422 }, /easy to guess\. Try adding more words/, "pw"],
  [{ code: "email_address_invalid", status: 400 }, /^This e-mail address can't be used — check it or use another\./, "email"],
  [{ code: "email_address_not_authorized", status: 400 }, /couldn't send the confirmation e-mail right now — try again in a few minutes or contact support/, null],
  [{ code: "unexpected_failure", status: 500, message: "Error sending confirmation email" }, /sign-up service had a problem/, null],
  [{ status: 500, message: "Error sending confirmation email" }, /couldn't send the confirmation e-mail[\s\S]*Ref: AUTH-email_send_failed/, null],
  [{ code: "signup_disabled", status: 422 }, /^Sign-ups are paused right now/, null],
  [{ code: "email_provider_disabled", status: 422 }, /^Sign-ups are paused right now/, null],
  [{ code: "over_email_send_rate_limit", status: 429 }, /sent several e-mails to this address recently/, null],
  [{ code: "hook_timeout", status: 500 }, /^Our sign-up check had a problem — try again in a minute\./, null],
  [{ code: "hook_timeout_after_retry", status: 500 }, /^Our sign-up check had a problem/, null],
  [{ code: "hook_payload_over_size_limit", status: 500 }, /^Our sign-up check had a problem/, null],
  [{ code: "hook_payload_invalid_content_type", status: 500 }, /^Our sign-up check had a problem/, null],
  [{ status: 400, message: "Error running hook URI: pg-functions://..." }, /^Our sign-up check had a problem[\s\S]*AUTH-hook_error/, null],
  [{ code: "validation_failed", status: 400 }, /Some details weren't accepted/, null],
  [{ code: "bad_json", status: 400 }, /Some details weren't accepted/, null],
  [{ code: "request_timeout", status: 504 }, /took too long/, null],
  [{ code: "conflict", status: 409 }, /try again in a moment/, null],
  [{ code: "something_new_2027", status: 400 }, /^We couldn't create your account right now[\s\S]*Ref: AUTH-something_new_2027/, null],
  [{ status: 418 }, /Ref: AUTH-418\)$/, null],
];
t("2 every other sign-up error code -> its own clear message, always with (Ref: AUTH-<code>), never 'Something went wrong'", async () => {
  for (const [err, re, field] of CASES) {
    const { S } = await env({ err });
    const e = await S.auth.signUp("a@gmail.com", "Zq7!vB2#kLm9Rt", {}).then(() => null, (x) => x);
    assert.ok(e, JSON.stringify(err));
    assert.match(e.message, re, JSON.stringify(err) + " -> " + e.message);
    assert.match(e.message, /\(Ref: AUTH-[a-z0-9_]+\)$/, "ref on " + JSON.stringify(err));
    assert.equal(e.field || null, field, "field " + JSON.stringify(err));
    assert.ok(!/Something went wrong/.test(e.message));
  }
});
t("3 no enumeration: already registered / banned -> the generic 'we've sent a link'; 429 + captcha unchanged", async () => {
  for (const err of [{ code: "user_already_exists", status: 422 }, { code: "email_exists", status: 422 }, { code: "user_banned", status: 403 }]) {
    const { S } = await env({ err });
    const res = await S.auth.signUp("a@gmail.com", "Zq7!vB2#kLm9Rt", {});
    assert.equal(res.generic, S.auth.genericMessages.sent, err.code);
  }
  const { S } = await env({ err: { code: "over_request_rate_limit", status: 429 } });
  const e = await S.auth.signUp("a@gmail.com", "Zq7!vB2#kLm9Rt", {}).then(() => null, (x) => x);
  assert.equal(e.code, "rate_limited");
});
t("4 sign-in: credentials stay one generic answer; provider off / hook / server trouble get a clear message + Ref", async () => {
  for (const err of [{ code: "invalid_credentials", status: 400 }, { code: "email_not_confirmed", status: 400 }, { code: "user_banned", status: 400 }, { status: 400, message: "Invalid login credentials" }]) {
    const { S } = await env({ err });
    const e = await S.auth.signIn("a@gmail.com", "x").then(() => null, (x) => x);
    assert.equal(e.message, "Invalid email or password.", JSON.stringify(err));
  }
  const exp = [[{ code: "email_provider_disabled", status: 400 }, /^Signing in with e-mail and password is switched off/],
    [{ code: "hook_timeout", status: 500 }, /^Our sign-in check had a problem/], [{ code: "unexpected_failure", status: 500 }, /^Our sign-in service had a problem/],
    [{ code: "validation_failed", status: 400 }, /Some details weren't accepted/]];
  for (const [err, re] of exp) {
    const { S } = await env({ err });
    const e = await S.auth.signIn("a@gmail.com", "x").then(() => null, (x) => x);
    assert.match(e.message, re); assert.match(e.message, /\(Ref: AUTH-/); assert.equal(e.authMapped, true);
  }
});
t("5 reset / resend stay generic on screen (no enumeration) but report the code", async () => {
  const { S, reports } = await env({ err: { code: "email_address_not_authorized", status: 400, message: "Email address a@gmail.com not authorized" } });
  assert.equal(await S.auth.requestPasswordReset("a@gmail.com"), true);
  assert.equal(await S.auth.resendSignup("a@gmail.com"), true);
  assert.equal(reports.length, 2); for (const [, m] of reports) { assert.match(m, /ref=AUTH-email_address_not_authorized/); assert.ok(!/gmail|@/.test(m)); }
});
t("6 password change / reset link / invite set-password: pwned -> the same 'too common' message (field pw)", () => {
  const up = SA.slice(SA.indexOf("async updatePassword(newPassword, opts)"), SA.indexOf("recovery: {"));
  assert.ok(up.includes('throw authError(error, "password");'));
  const cp = SA.slice(SA.indexOf("async completePasswordChange(newPassword, opts)"), SA.indexOf("genericMessages:"));
  assert.ok(cp.includes('throw authError(error, "password");'));
  const ip = SA.slice(SA.indexOf("async setInvitePassword(newPassword, fullName)"), SA.indexOf("isRecoverySession: () =>"));
  assert.ok(ip.includes('authError(error, "password")'));
  assert.ok(IS.includes(PWNED_MSG) && /pwned\|known to be weak/.test(IS), "invite-signup edge function");
  assert.ok(RESET.includes('x.field === "pw"') && /\$\("#new_pw"\)\.focus\(\)/.test(RESET), "reset page focuses the password");
  assert.ok(LOGIN.includes('if(x&&x.field==="pw"){ $("#ip_pw").focus()'), "invite form");
  assert.ok(LOGIN.includes('if(e&&e.field==="pw"){ pw.focus(); pw.select(); }'), "temp-password form");
});
t("7 the pure mapper: password ctx says 'password', unknown code still has a Ref, pwned without reasons via message", async () => {
  const { S } = await env({});
  const m = S.auth.authErrorInfo;
  assert.match(m({ code: "hook_timeout", status: 500 }, "password").message, /^Our password check had a problem/);
  assert.equal(m({ status: 422, message: PWNED_BODY.message }, "password").message, PWNED_MSG + " (Ref: AUTH-weak_password)");
  assert.equal(m({ code: "same_password", status: 422 }, "password").field, "pw");
  assert.equal(m({ code: "reauthentication_needed", status: 400 }, "password").code, "reauth_required");
  assert.match(m({}, "signup").message, /Ref: AUTH-unknown/);
  assert.equal(m({ code: "Weird Code <x>" }, "signup").ref, "AUTH-unknown", "only a clean code is echoed");
});

t("8 local 'easy to guess' check names the specific reason(s) in plain words; real passphrases pass", async () => {
  const { S } = await env({});
  const g = S.auth.passwordRule.guessReasons;
  const SEQ = "Avoid sequences of numbers or letters.", NAME = "Avoid using your name or email in your password.", REP = "Avoid repeating the same character.",
    KEY = "Avoid keyboard patterns.", COMMON = "This password is too common. Try a different one.", WORD = "This password is easy to guess. Try adding more words or characters.";
  const has = (p, why, hints) => assert.ok(g(p, hints).includes(why), p + " -> " + why + " (got " + JSON.stringify(g(p, hints)) + ")");
  has("Tharun@123456", SEQ); has("Tharun@123456", WORD); has("Tharun@123456", NAME, ["Tharun studios", "t@gmail.com"]);
  has("P@ssw0rd12345", COMMON); has("Welcome@2024!", COMMON); has("Aaaaaaaa1!aa", REP); has("Zz!111Qq#xyW", REP);
  has("Qwerty@Lamp57", KEY); has("Koushik#99xyZ", NAME, ["Koushik Goud", "k@x.com"]); has("98765#Orbit!Kite", SEQ);
  assert.ok(!g("Tharun@123456").includes(NAME), "no name reason without hints");
  for (const p of ["Zq7!vB2#kLm9Rt", "Correct-Horse-Battery-9", "tram Lamp 47 violet!", "Mango+Kite7+Orbit3", "Gx9$wL2@pQ7!", "Teal-Window-Rivers-73"])
    assert.equal(g(p, ["Priya Sharma", "priya@studio.in"]).length, 0, "should pass " + p + " (got " + JSON.stringify(g(p, ["Priya Sharma", "priya@studio.in"])) + ")");
  assert.equal(S.auth.passwordRule.guessable("Mango+Kite7+Orbit3"), null);
});
t("9 login.html: meter never 'Strong' for a guessable password; warn once before submit; checklist gets the hints", () => {
  assert.ok(LOGIN.includes('g?"Weak":PW_WORDS[l]') && LOGIN.includes("const l=g?2:pwLevel(v);"));
  assert.ok(/if\(guess && pwWarned!==pw\)\{ pwWarned=pw; setFieldErr\(\$\("#pw"\), "This password is easy to guess\. Try adding more words/.test(LOGIN));
  assert.ok(LOGIN.includes('attachChecklist(document.getElementById("pw"), document.getElementById("pwRules"), {hints:pwHints, confirm:document.getElementById("pw2")})'));
  assert.ok(SA.includes('li.setAttribute("data-guessable", "1")'), "checklist warning line (every set-password form)");
});
t("10 login.html: a mapped password / e-mail error -> top + inline, aria-invalid, focus + scroll, form kept, meter = server verdict", () => {
  const c = LOGIN.slice(LOGIN.indexOf('if(err&&err.authMapped&&(err.field==="pw"||err.field==="email")){'));
  const blk = c.slice(0, c.indexOf("return; }") + 9);
  assert.ok(blk.includes('showErr($("#err"),m); setFieldErr(fi,m);'), "top + inline");
  assert.ok(blk.includes('pwServerWeak(m)') && blk.includes("scrollIntoView") && blk.includes("fi.focus("));
  assert.ok(!/\.value=""/.test(blk), "nothing cleared");
  assert.ok(LOGIN.includes('input.setAttribute("aria-invalid",msg?"true":"false")'), "setFieldErr marks aria-invalid");
  const w = LOGIN.slice(LOGIN.indexOf("function pwServerWeak("), LOGIN.indexOf("function pwServerWeak(") + 600);
  assert.ok(w.includes('setAttribute("data-level","1")') && w.includes('"Too common — choose another"'));
  assert.ok(LOGIN.includes('if($("#pwMeter").hasAttribute("data-server")){ $("#pwMeter").removeAttribute("data-server")'), "cleared once the password changes");
  assert.ok(LOGIN.includes('err.authMapped===true||err.code==="invalid_credentials"'), "other mapped errors shown as-is");
  assert.ok(LOGIN.includes('"create your account":"sign you in"') && !LOGIN.includes("create the studio"));
});
t("12 no 'breach' wording anywhere a person sees it (sign-up / sign-in / reset / invite)", () => {
  for (const [n, src] of [["store-api", SA], ["login", LOGIN], ["reset-password", RESET], ["invite-signup", IS], ["auth-ui", r("public/auth-ui.js")]]) assert.ok(!/breach/i.test(src), n);
  assert.ok(SA.includes('li.setAttribute("data-guessable", "1")') && SA.includes("why.forEach("), "one checklist line per reason");
});
t("13 R29b: the too-common message suggests no example password; no 'breach'/'leak' wording on screen", async () => {
  const { S } = await env({});
  assert.equal(S.auth.passwordRule.pwnedMessage, "This password is too common. Try a different one.");
  assert.ok(IS.includes('"This password is too common. Try a different one. (Ref: AUTH-weak_password)"'));
  for (const [n, src] of [["store-api", SA], ["login", LOGIN], ["reset-password", RESET], ["invite-signup", IS]]) {
    assert.ok(!/Blue-Garden|for example a short phrase|longer phrase/i.test(src), n + ": no example password");
  }
  // every reason / hint line a person can see names the problem only
  const m = S.auth.authErrorInfo;
  for (const rs of [["pwned"], ["length"], ["characters"], []]) assert.ok(!/breach|leak|phrase like/i.test(m({ code: "weak_password", status: 422, reasons: rs }, "signup").message), rs.join());
});
// the attribute value as an HTML attribute (& is written &amp;)
const attrOf = (src, id) => { const mm = src.match(new RegExp('<input id="' + id + '"[^>]*>')) || src.match(new RegExp("<input id=\"" + id + "\"[^']*'")); return mm ? mm[0] : ""; };
t("14 R29b: every NEW account-password field has autocomplete=new-password + passwordrules = our policy; a username field sits with it", async () => {
  const { S } = await env({});
  const rules = S.auth.passwordRule.rulesAttr;
  assert.equal(rules, "minlength: 12; required: lower; required: upper; required: digit; required: [-!#$%&*+=?@^_~.,:;/]; max-consecutive: 2;");
  assert.ok(rules.includes("minlength: " + S.auth.passwordRule.min + ";"), "same minimum as PW_MIN");
  for (const ch of "-!#$%&*+=?@^_~.,:;/") assert.ok(S.auth.passwordRule.symbols.includes(ch), "symbol " + ch + " counts for Supabase");
  const html = rules.replace(/&/g, "&amp;");
  const RP = r("public/reset-password.html");
  for (const [src, id] of [[LOGIN, "pw2"], [LOGIN, "ip_pw"], [LOGIN, "ip_pw2"], [LOGIN, "fpc_pw"], [LOGIN, "fpc_pw2"], [RP, "new_pw"], [RP, "new_pw2"]]) {
    const tag = attrOf(src, id);
    assert.ok(tag, id); assert.ok(tag.includes('autocomplete="new-password"'), id + " new-password");
    assert.ok(tag.includes('passwordrules="' + html + '"'), id + " passwordrules");
    assert.ok(!/data-lpignore|data-1p-ignore|data-bwignore|onpaste|autocomplete="off"/.test(tag), id + " autofill allowed");
  }
  // the main sign-in / sign-up box: sign-in = current-password; sign-up / invite-accept = new-password + the rules
  assert.ok(attrOf(LOGIN, "pw").includes('autocomplete="current-password"'));
  assert.ok(LOGIN.includes('$("#pw").setAttribute("autocomplete", m==="signup" ? "new-password" : "current-password");'));
  assert.ok(LOGIN.includes('if(m==="signup") $("#pw").setAttribute("passwordrules", $("#pw2").getAttribute("passwordrules")||""); else $("#pw").removeAttribute("passwordrules");'));
  // the e-mail (username) comes BEFORE the password in the same form
  const lf = LOGIN.slice(LOGIN.indexOf('<form class="card" id="loginForm">'), LOGIN.indexOf("</form>", LOGIN.indexOf('id="loginForm"')));
  assert.ok(lf.indexOf('<input id="email" type="email" autocomplete="username"') !== -1 && lf.indexOf('<input id="email"') < lf.indexOf('<input id="pw"') && lf.indexOf('<input id="pw"') < lf.indexOf('<input id="pw2"'));
  // forms without a visible e-mail carry a hidden username field, filled with the account's e-mail
  const ipf = LOGIN.slice(LOGIN.indexOf('id="invitePwForm"'), LOGIN.indexOf("</form>", LOGIN.indexOf('id="invitePwForm"')));
  assert.ok(ipf.indexOf('<input type="email" id="ip_user" autocomplete="username" hidden readonly>') !== -1 && ipf.indexOf('id="ip_user"') < ipf.indexOf('id="ip_pw"'));
  assert.ok(LOGIN.includes('$("#ip_user").value=u.email||"";'));
  assert.ok(LOGIN.indexOf("<input id=\"fpc_user\" type=\"email\" autocomplete=\"username\" hidden readonly>") !== -1 && LOGIN.indexOf('id="fpc_user"') < LOGIN.indexOf('id="fpc_pw"'));
  assert.ok(LOGIN.includes('ov.querySelector("#fpc_user").value=((BPStore.auth.user&&BPStore.auth.user())||{}).email||"";'));
  assert.ok(RP.indexOf('id="acct_email" autocomplete="username"') !== -1 && RP.indexOf('id="acct_email"') < RP.indexOf('id="new_pw"'));
  assert.ok(RP.indexOf('id="cur_email" autocomplete="username"') !== -1 && RP.indexOf('id="cur_email"') < RP.indexOf('id="cur_pw"'));
  assert.ok(RESET.includes('$("#acct_email").value = u.email || ""; $("#cur_email").value = u.email || "";'));
  // nothing blocks paste / autofill on the account password pages
  for (const [n, src] of [["login", LOGIN], ["reset", RP], ["reset-js", RESET]]) assert.ok(!/onpaste|addEventListener\(\s*["']paste["']|data-lpignore/.test(src), n);
  // the 4-digit PIN fields are NOT account passwords - no rules there
  assert.ok(!/id="pp_new"[^>]*passwordrules/.test(r("public/control.html")));
});
t("15 R29b: browser-suggested passwords (Safari / Chrome / managers) pass every local check with no warning", async () => {
  const { S } = await env({});
  const R = S.auth.passwordRule, hints = ["Priya Sharma", "priya@studio.in"];
  const ok = (p) => { assert.equal(R.problem(p), null, p + " meets the policy"); assert.deepEqual(Array.from(R.guessReasons(p, hints)), [], p + " no warnings (got " + JSON.stringify(R.guessReasons(p, hints)) + ")"); };
  // real-format samples: Safari "xxxxxx-xxxxxx-xxxxxx", Chrome 15-char, 1Password / Bitwarden random
  ["xamtyw-dofwaS-1kicpu", "Hupduq-7bymgo-wirtip", "jeqxuP-gonbe5-sazkoh", "wofkeR-3zuxpa-hidmyb",
    "Kp7#vQ2mXz9!Lw4", "rT5$hN8qWe2@zXb", "9fG!kL2@pQ7#vB3", "v8!Qm2#Lx7$Rk4z", "Zt4&Nc9*Qs1^Hb6", "u3K=pW8+yD5?mQ1"].forEach(ok);
  // and 300 more in the same formats from a fixed seed (stable)
  let a = 20261026; const rnd = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const pick = (set) => set[Math.floor(rnd() * set.length)];
  const CONS = "bcdfghjkmnpqrstvwxz", VOW = "aeiouy", LOW = "abcdefghijkmnopqrstuvwxyz", UP = "ABCDEFGHJKLMNPQRSTUVWXYZ", DIG = "23456789", SYM = "-!#$%&*+=?@^_~.,:;/";
  const noTriple = (gen) => { let p; do p = gen(); while (/(.)\1\1/.test(p)); return p; };   // max-consecutive: 2 in passwordrules
  for (let i = 0; i < 150; i++) {
    // Safari: three 6-letter syllable groups, one upper-case letter, one digit, joined by "-"
    ok(noTriple(() => { const g = [0, 1, 2].map(() => { let w = ""; for (let k = 0; k < 6; k++) w += k % 3 === 1 ? pick(VOW) : pick(CONS); return w.split(""); });
      g[Math.floor(rnd() * 3)][Math.floor(rnd() * 6)] = pick(DIG); const gi = Math.floor(rnd() * 3), ci = Math.floor(rnd() * 6);
      if (!/[0-9]/.test(g[gi][ci])) g[gi][ci] = g[gi][ci].toUpperCase(); else g[(gi + 1) % 3][0] = g[(gi + 1) % 3][0].toUpperCase();
      return g.map((x) => x.join("")).join("-"); }));
    // Chrome / managers: 15 random characters with every class
    ok(noTriple(() => { const all = LOW + UP + DIG + SYM; const c = [pick(LOW), pick(UP), pick(DIG), pick(SYM)]; while (c.length < 15) c.push(pick(all));
      for (let k = c.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [c[k], c[j]] = [c[j], c[k]]; } return c.join(""); }));
  }
});
t("16 R29b: /.well-known/change-password sends password managers to the change-password page", () => {
  const V = JSON.parse(r("vercel.json"));
  const rd = V.redirects.find((x) => x.source === "/.well-known/change-password");
  assert.ok(rd && rd.destination === "/reset-password?mode=change" && rd.statusCode === 302);
  assert.ok(Buffer.byteLength(r("vercel.json")) < 200 * 1024);
});
t("11 friendlyError shows a mapped auth error as-is (reset page, invite, temp-password)", () => {
  const i = SA.indexOf("function friendlyError(e, o)"); const fe = SA.slice(i, i + 900);
  assert.ok(fe.includes("if (e && e.authMapped === true && typeof e.message === \"string\" && e.message) return e.message;"));
});

let fails = 0;
for (const [n, f] of tests) { try { await f(); console.log("  ✓", n); } catch (e) { fails++; console.error("  ✗", n, "\n   ", e.message); } }
console.log(`\nr29-signup-errors: ${tests.length - fails}/${tests.length} passed.`);
if (fails) process.exit(1);

t("R101 Google-style wording: no example passwords in any hint / reason; live confirm mismatch everywhere", async () => {
  const { S } = await env({});
  const R = S.auth.passwordRule;
  const all = [R.hint, R.pwnedMessage, R.mismatchMessage, ...R.checks("").map((c) => c.label), ...R.guessReasons("Tharun@123456", ["Tharun x"]), R.problem("a"), R.problem("abcdefghijklm")];
  for (const m of all) assert.ok(!/like |e\.g\.|Name@|CarModel|qwerty|123456|aaa/i.test(m), "no examples: " + m);
  assert.equal(R.hint, "Use 12 or more characters with a mix of uppercase and lowercase letters, numbers & symbols.");
  assert.equal(R.problem("short"), "Too short. Use 12 or more characters.");
  assert.equal(R.problem("abcdefghijklm"), "Add an uppercase letter, a number and a symbol.");
  assert.deepEqual(R.strengthLabels.slice(1), ["Weak", "Weak", "Fair", "Strong"]);
  assert.ok(LOGIN.includes('const PW_WORDS=["","Weak","Weak","Fair","Strong"]'));
  assert.ok(!/Name@2024|CarModel|like ! @/.test(LOGIN + SA), "no example passwords left");
  assert.ok(LOGIN.includes('{confirm:pw2}') && LOGIN.includes('{confirm:document.getElementById("ip_pw2"), hints:'));
  assert.ok(SA.includes('cf.addEventListener("input", check)'));
});
