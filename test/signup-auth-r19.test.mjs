// Round 19 - trial sign-up & auth (0210):
//  1. login.html?trial=1 desktop: the brand column is sticky (>= 1024px) so "See all trial rules" never leaves a blank column
//  2. an OPEN invitation for the sign-up e-mail is offered BEFORE anything is created ("Join <Studio>" / "Start my own trial");
//     the server lookup (invite-signup email_lookup -> invite_open_for_email, service role only) reveals only studio + role,
//     is rate limited, and the Join link reaches the browser only through an e-mail to that address
//  3. the "Check your inbox" screen: "Already have a Helm account? Sign in · Reset password" for everyone (no enumeration)
//  4. /auth/confirm: "Confirming your email…" at once, no sign-in form flash on /login (auth-handoff.js), straight on to the welcome
//  5. trial welcome "Name your studio": City + State (Indian states) + Country India (fixed); phone optional; trial_welcome_save
//  6. invite step: progress per e-mail + a clear result list ("Invites sent to a@x.com (Planner), ...") or per-e-mail errors
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import * as nodeModule from "node:module";
const require = createRequire(import.meta.url);
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error("FAIL " + name); throw e; } };
const LOGIN = r("public/login.html"), API = r("public/store-api.js"), TD = r("public/trial-demo.js");
const AC = r("public/auth-confirm.js"), ACH = r("public/auth-confirm.html"), HO = r("public/auth-handoff.js");
const FN = r("supabase/functions/invite-signup/index.ts");
const MIG = r("supabase/migrations/0210_signup_invite_location.sql"), APPLY = r("supabase/APPLY-0210.sql");
const MAN = r("supabase/migrations/MANIFEST"), RUNALL = r("scripts/db-test/run-all.sh");
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + " missing");
  let i = src.indexOf("{", src.indexOf(")", at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + " unterminated");
};

// ---- 1) sticky brand column -------------------------------------------------------------------------------------
t("1 desktop / laptop: the brand column is sticky, full viewport height; phones unchanged", () => {
  assert.match(LOGIN, /@media\(min-width:1024px\)\{\.brandpane\{position:sticky;top:0;align-self:start;height:100vh;height:100dvh\}\}/);
  assert.match(LOGIN, /@media\(max-width:820px\)\{\.brandpane\{display:none\}\}/, "phones: brand column still hidden");
  assert.match(LOGIN, /@media\(min-width:1024px\) and \(max-height:820px\)\{\.brandpane\{padding:36px 48px\}/, "short laptop screens: compact so nothing is cut");
});

// ---- 2) open invitation before a trial is created ---------------------------------------------------------------
t("2a sign-up asks about an open invitation BEFORE signUp, only for a new (not joining) sign-up, once per e-mail", () => {
  const i = LOGIN.indexOf("BPStore.invitations.openForEmail(email,{timeoutMs:4000})"), j = LOGIN.indexOf("await BPStore.auth.signUp(email, pw,");
  assert.ok(i > 0 && j > i, "lookup before signUp");
  assert.match(LOGIN, /if\(existing\)\{ await routeSignedIn\(\); return; \}/);   // r22: a signed-in retry never signs up again
  assert.match(LOGIN, /if\(ivSkip!==email && BPStore\.invitations\.openForEmail\)\{/);
  assert.match(LOGIN, /if\(iv && iv\.invited\)\{ keepCap=true; showInvited\(iv, email\); return; \}/);
  assert.ok(LOGIN.indexOf("if(joining){") < i, "an invitee (joining) never gets here");
  assert.match(LOGIN, /\}finally\{ if\(!keepCap\) capReset\(cap\); btn\.textContent=submitLabel\(\); \}/, "the unused security check is kept for 'Start my own trial'");
});
t("2b the choice card: 'You've been invited to join <Studio> as <role>' - Join <Studio> / Start my own trial", () => {
  assert.match(LOGIN, /<section class="card" id="invitedCard" hidden aria-labelledby="ivTitle">/);
  assert.match(LOGIN, /\$\("#ivTitle"\)\.textContent="You've been invited to join "\+ivStudio\+\(role\?" as "\+role:""\);/);
  assert.match(LOGIN, /jb\.textContent="Join "\+ivStudio;/);
  assert.match(LOGIN, /\$\("#ivOwn"\)\.textContent="Create my own studio";/);
  assert.match(LOGIN, /ivSkip=ivEmail; showView\("#loginForm"\);/);
  assert.match(LOGIN, /"#inboxCard","#invitedCard","#invitePwForm","#inviteLinkCard"\]/, "the card is one of the page's views");
  // Join: the invitation e-mail again (the token never comes to this browser)
  assert.match(LOGIN, /const r=await BPStore\.invitations\.emailInviteLink\(ivEmail\);/);
  assert.ok(!/invite=["']?\s*\+\s*iv\b|iv\.token/.test(LOGIN), "no token from the lookup is ever used");
});
t("2c store-api: openForEmail / emailInviteLink post only the e-mail (no token), time out, never throw on lookup", () => {
  const a = API.indexOf("async openForEmail(email, opts)"), b = API.indexOf("async emailInviteLink(email)"), c = API.indexOf("async preview(token)");
  assert.ok(a > 0 && b > a && c > b);
  const look = API.slice(a, b), send = API.slice(b, c);
  assert.match(look, /body: JSON\.stringify\(\{ email_lookup: true, email: em \}\)/);
  assert.match(look, /ctl\.abort\(\)/); assert.match(look, /catch \(e\) \{ return null; \}/);
  assert.match(look, /return \{ invited: true, studio: str\(j\.studio, 120\), role: str\(j\.role, 40\), role_label: str\(j\.role_label, 60\) \};/);
  assert.ok(!/token/.test(look.replace(/\/\/.*$/gm, "")), "the lookup never handles a token");
  assert.match(send, /body: JSON\.stringify\(\{ email_send: true, email: em \}\)/);
  assert.ok(!/token/.test(send.replace(/\/\/.*$/gm, "")), "the browser never gets the token");
});
t("2d edge function: e-mail modes branch BEFORE the token limits, own rate limits, studio + role only", () => {
  const i = FN.indexOf("if (body.email_lookup === true || body.email_send === true) {"), j = FN.indexOf('["invsu:tok:" + token');
  assert.ok(i > 0 && j > i, "an empty token never shares one bucket");
  assert.match(FN, /\["invem:ip:" \+ ip, 10, 60 \* 60_000\], \["invem:em:" \+ email, 3, 60 \* 60_000\]/);
  assert.match(FN, /\["invlk:ip:" \+ ip, 20, 10 \* 60_000\], \["invlk:em:" \+ email, 5, 10 \* 60_000\]/);
  assert.match(FN, /admin\.rpc\("invite_open_for_email", \{ p_email: email \}\)/);
  assert.match(FN, /if \(mode === "lookup"\) return json\(ans\);/);
  // send: the same invitation e-mail (Join link /login?invite=<token>) to that address only
  assert.match(FN, /inviteEmail\(\{ token, inviter, studio, role: r\.role, expires_at: r\.expires_at, key: await mintMailKey\(admin, token\) \}\)/);   // R32 AUTH-1: + the mail key
  assert.match(FN, /signInWithOtp\(\{ email, options: \{ shouldCreateUser: false, emailRedirectTo: link \} \}\)/);
  assert.ok(!/console\.(log|error)\([^)]*(email|password|token|bound)\b/.test(FN), "no PII in logs");
});
t("2e edge function lookupAnswer: studio + role (+ label) only, never the token / inviter / expiry", () => {
  const strip = nodeModule.stripTypeScriptTypes;
  if (typeof strip !== "function") return;   // older Node: the static checks above still ran
  const a = FN.indexOf("export function lookupAnswer"), b = FN.indexOf("\n}\n", a);
  const src = strip("const TOKEN = /^[0-9a-f]{48}$/;\nconst clean = (s, max = 80) => String(s ?? '').replace(/[\\u0000-\\u001f\\u007f]+/g, ' ').replace(/\\s+/g, ' ').trim().slice(0, max);\n" +
    "const roleLabel = (r) => ({ planner: 'Planner', coordinator: 'Event coordinator' })[String(r)] || 'a team member';\n" +
    FN.slice(a, b + 2).replace(/^export /, "")) + "\nreturn lookupAnswer;";
  const lookupAnswer = new Function(src)();
  const tok = "ab".repeat(24);
  const got = lookupAnswer({ found: true, studio: " Aurora\nEvents ", role: "planner", token: tok, expires_at: "2026-10-30", invited_by: "u1" });
  assert.deepEqual(got, { invited: true, studio: "Aurora Events", role: "planner", role_label: "Planner" });
  assert.deepEqual(lookupAnswer({ found: false }), { invited: false });
  assert.deepEqual(lookupAnswer(null), { invited: false });
  assert.deepEqual(lookupAnswer({ found: true, studio: "X", role: "planner", token: "short" }), { invited: false });
});

// ---- 3) check-your-inbox: sign in / reset for everyone ---------------------------------------------------------------
t("3 inbox screen: 'Already have a Helm account? Sign in · Reset password' (always shown, no enumeration)", () => {
  assert.match(LOGIN, /<p class="helper inbox-have" id="inboxHave">Already have a Helm account\? <button type="button" class="linkbtn" id="inboxSignin">Sign in<\/button> · <button type="button" class="linkbtn" id="inboxReset">Reset password<\/button><\/p>/);
  assert.ok(!/inboxHave"\)\.hidden|#inboxHave"\)\.hidden/.test(LOGIN), "never toggled per account state");
  assert.match(LOGIN, /\$\("#inboxSignin"\)\.addEventListener\("click", \(\)=>\{ showView\("#loginForm"\); setMode\("signin"\); \$\("#email"\)\.value=inboxAddr;/);
  assert.match(LOGIN, /\$\("#inboxReset"\)\.addEventListener\("click", \(\)=>\{ \$\("#email"\)\.value=inboxAddr; \$\("#fg_email"\)\.value=inboxAddr; openForgot\(\); \}\);/);
  // the existing-account sign-up still looks exactly like a new one
  assert.match(API, /if \(\/user_already_exists\|email_exists\|already registered\|already exists\/i\.test\(c \+ " " \+ m\)\) return \{ user: null, session: null, generic: GENERIC_SENT \};/);
});

// ---- 4) /auth/confirm + the hand-over to /login ----------------------------------------------------------------------
t("4a auth-confirm: 'Confirming your email…' at once (its scripts run before store-api), work starts once store-api is in", () => {
  const core = ACH.indexOf('<script src="/auth-confirm-core.js'), page = ACH.indexOf('<script src="/auth-confirm.js'), api = ACH.indexOf('<script src="/store-api.js');
  assert.ok(core > 0 && page > core && api > page, "auth-confirm scripts before store-api.js");
  assert.match(AC, /if \(SIGNUP\) say\("Confirming your email…", "One moment — we're confirming your e-mail address\."\);/);
  assert.match(AC, /if \(window\.BPStore\) run\(\); else document\.addEventListener\("DOMContentLoaded", run\);/);
  assert.match(AC, /history\.replaceState\(null, "", location\.pathname\)/, "token still leaves the address bar first");
});
t("4b auth-confirm: same browser -> straight on (hand-over flag); another browser -> 'Continue as <e-mail>' once, or sign out", () => {
  assert.match(AC, /BPStore\.auth\.signupStartedHere\(user\.email\)\) \{\n\s+say\("Email confirmed", "Setting up your studio…"\); handoff\(\); go\(link\.next\); return; \}/);
  assert.match(AC, /if \(SIGNUP && user && user\.email\) \{ askContinue\(user\.email\); return; \}/);
  const k = AC.indexOf("function askContinue("), e = AC.indexOf("\n  }\n", k);
  const blk = AC.slice(k, e);
  assert.match(blk, /"Continue as " \+ \(email \|\| "this account"\) \+ " →"/);
  assert.match(blk, /handoff\(\); go\(link\.next\);/);
  assert.match(blk, /await BPStore\.auth\.signOut\(\);[\s\S]*go\("\/login\?confirmed=1"\)/);
  assert.match(blk, /cloneNode\(false\)/, "no 'Sign out and continue' listener left on the button");
  assert.match(blk, /window\.addEventListener\("pagehide", function \(\) \{ if \(!chosen\) dropSessionNow\(\); \}\);/, "left without choosing: no session kept");
  assert.match(AC, /\/\^sb-\[a-z0-9\]\+-auth-token\$\/\.test\(k\)\) localStorage\.removeItem\(k\)/);
  assert.match(AC, /sessionStorage\.setItem\("bp_confirm_handoff", String\(Date\.now\(\)\)\)/);
});
t("4c login.html: the hand-over card from <head> (no sign-in form flash), ended by any real form", () => {
  const hs = LOGIN.indexOf('<script src="/auth-handoff.js?v='), body = LOGIN.indexOf("<body>");
  assert.ok(hs > 0 && hs < body, "auth-handoff.js runs in <head>");
  assert.match(LOGIN, /html\.auth-handoff \.formpane > \.card:not\(#handoffCard\)\{display:none!important\}/);
  assert.match(LOGIN, /<section class="card ho" id="handoffCard" hidden aria-live="polite" aria-busy="true" aria-labelledby="hoTitle">/);
  assert.match(LOGIN, /function showView\(id\)\{ hoEnd\(\);/);
  assert.match(LOGIN, /hoEnd\(\); showView\("#onboardForm"\);/, "onboarding ends it");
  assert.match(LOGIN, /hoEnd\(\);   \/\/ nobody signed in: the normal sign-in \/ sign-up page/);
  // r22: a confirmed sign-up no longer creates a studio behind the hand-over card - step 3 (studio) shows instead
  assert.match(LOGIN, /hoStep\("Opening your studio…",""\);/);
});
t("4d auth-handoff.js: one-shot flag, fresh for 2 minutes only, never stuck", () => {
  const H = require("../public/auth-handoff.js");
  const now = 1_800_000_000_000;
  assert.equal(H.fresh(String(now - 1000), now), true);
  assert.equal(H.fresh(String(now - 3 * 60 * 1000), now), false);
  assert.equal(H.fresh(String(now + 5000), now), false, "a future stamp is not fresh");
  assert.equal(H.fresh("x", now), false); assert.equal(H.fresh(null, now), false);
  assert.match(HO, /root\.sessionStorage\.removeItem\(KEY\); flagged = fresh\(v, Date\.now\(\)\);/, "used up on read");
  assert.match(HO, /safety = setTimeout\(end, 60 \* 1000\);/);
  assert.ok(!/innerHTML|eval\(|new Function/.test(HO));
});
t("4e another browser: the sign-up's own note (plan, mode, Terms agreed) carries on to step 3 - nothing is created by the confirm link (r22, auditor #1)", () => {
  assert.match(API, /so\.data = Object\.assign\(\{\}, so\.data \|\| \{\}, \{ helm_signup_intent: intent, helm_signup_studio: sn \}\);/);
  assert.match(API, /helm_signup_plan: String\(opts\.plan\)/); assert.match(API, /helm_signup_mode: String\(opts\.mode\)/);
  assert.match(LOGIN, /async function finishPendingStudio\(\)\{ return; \}/);
  const sf = require("../public/signup-flow.js");
  assert.equal(sf.agreedEarlier(null, { helm_terms_agreed_at: new Date().toISOString() }, Date.now()), "signup");
  assert.match(r("public/signup-flow.js"), /function wantPlan\(\) \{ return intent\.plan \|\| String\(metaOf\(\)\.helm_signup_plan \|\| ""\); \}/);
});

// ---- 5) trial welcome: City + State + Country ------------------------------------------------------------------------
t("5a welcome step: City + State dropdown (Indian states) + Country India (read-only); phone optional", () => {
  const k = TD.indexOf("function stepName()"), e = TD.indexOf("function step2(", k);
  const blk = TD.slice(k, e);
  assert.match(blk, /field\("tdw_city", "City", "text", ""\)/);
  assert.match(blk, /const fs = stateField\("tdw_state"\);/);
  assert.match(blk, /field\("tdw_country", "Country", "text", "India", "The free trial is for studios in India\."\); fk\.input\.readOnly = true;/);
  assert.match(blk, /field\("tdw_phone", "Phone \(optional\)", "tel", ""/);
  assert.match(blk, /if \(!state\) \{ showErr\("Choose your state\."\); fs\.input\.focus\(\); return; \}/);
  assert.match(blk, /st\.trialOrg\.welcomeSave\(\{ name: name, city: city, state: state, phone: fp\.input\.value, country: "IN" \}\)/);
  assert.match(TD, /global\.HelmCountry\.get\("IN"\)/);
  assert.ok(!/innerHTML|\.style\.|setAttribute\("style"/.test(TD), "CSP-safe DOM");
});
t("5b store-api welcomeSave -> trial_welcome_save (country IN), falls back to the 0167 step while 0210 is not applied", () => {
  const a = API.indexOf("welcomeSave: (o) => {"), b = API.indexOf("welcomePending:", a);
  const blk = API.slice(a, b);
  assert.match(blk, /rpc\("trial_welcome_save", args\)/);
  assert.match(blk, /p_country: "IN"/);
  assert.match(blk, /if \(!rpcMissing\(e\)\) throw e;\s*return rpc\("trial_welcome_setup", \{ p_name: args\.p_name, p_city: args\.p_city \|\| "Hyderabad", p_phone: args\.p_phone \}\);/);
});
t("5c the SQL states list is exactly public/country-profile.js IN_STATES", () => {
  const C = require("../public/country-profile.js");
  const js = C.get("IN").regions.map((x) => x.name);
  const m = MIG.match(/select array\[([\s\S]*?)\]::text\[\]/);
  assert.ok(m, "list in 0210");
  const sql = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.deepEqual(sql, js);
  assert.equal(sql.length, 36);
});

// ---- 6) invite step: progress + results ------------------------------------------------------------------------------
t("6a invite step: progress per e-mail, keeps going past one failure, then a result list", () => {
  const k = TD.indexOf("function step2("), e = TD.indexOf("keepOpen(dlg);", k);
  const blk = TD.slice(k, e);
  assert.match(blk, /prog\.textContent = inviteProgress\(i, list\.length, it\.email\);/);
  assert.match(blk, /catch \(e\) \{ results\.push\(\{ email: it\.email, roleKey: it\.role, role: label\(it\.role\), ok: false, error: errMsg\(e, "invite " \+ it\.email\) \}\); \}/);
  assert.ok(!/catch \(e\) \{ done\(\); showErr\(errMsg\(e, "invite " \+ it\.email\)\); return; \}/.test(blk), "no longer stops at the first error");
  assert.match(blk, /prog\.textContent = "Sending the invitation e-mails…";/);
  assert.match(blk, /showInviteResults\(results, inviteMailOk\(mail\)\);/);
  assert.match(blk, /btn\("Try again", "btn", \(\) => step2\(bad\.map\(\(r\) => \(\{ email: r\.email, role: r\.roleKey \}\)\)\)\)/);
  assert.match(blk, /prog\.setAttribute\("aria-live", "polite"\)/);
});
t("6b pure helpers: 'Invites sent to a@x.com (Planner), b@y.com (Event coordinator).' / saved / errors", () => {
  const ctx = {};
  vm.runInNewContext(fnSrc(TD, "inviteProgress") + "\n" + fnSrc(TD, "inviteMailOk") + "\n" + fnSrc(TD, "inviteSummary") +
    "\nglobalThis.p=inviteProgress;globalThis.m=inviteMailOk;globalThis.s=inviteSummary;", ctx);
  assert.equal(ctx.p(0, 2, "a@x.com"), "Sending invite 1 of 2 to a@x.com…");
  const both = [{ email: "a@x.com", role: "Planner", ok: true }, { email: "b@y.com", role: "Event coordinator", ok: true }];
  assert.equal(ctx.s(both, true), "Invites sent to a@x.com (Planner), b@y.com (Event coordinator).");
  assert.equal(ctx.s(both, false), "Invites saved for a@x.com (Planner), b@y.com (Event coordinator).");
  assert.equal(ctx.s([both[0], { email: "c@z.com", role: "Sales", ok: false, error: "x" }], true), "Invites sent to a@x.com (Planner). 1 invite could not be sent:");
  assert.equal(ctx.s([{ email: "c@z.com", role: "Sales", ok: false }], true), "1 invite could not be sent:");
  assert.equal(ctx.m({ status: "ok", sent: 2, failed: 0 }), true);
  assert.equal(ctx.m({ status: "ok", sent: 1, failed: 1 }), false);
  assert.equal(ctx.m({ status: "unavailable", reason: "not_deployed" }), false);
  assert.equal(ctx.m(null), false);
});

// ---- SQL packaging --------------------------------------------------------------------------------------------------
t("SQL 0210: ASCII, additive (no drop / delete / truncate), MANIFEST in numeric order, APPLY verbatim + VERIFY, DB suite wired", () => {
  assert.ok(!/[^\x00-\x7F]/.test(MIG), "migration ASCII"); assert.ok(!/[^\x00-\x7F]/.test(APPLY), "APPLY ASCII");
  const code = MIG.replace(/--.*$/gm, "");
  assert.ok(!/\b(drop|delete|truncate)\b/i.test(code), "nothing dropped or deleted");
  assert.match(MIG, /grant execute on function public\.invite_open_for_email\(text\) to service_role/);
  assert.match(MIG, /revoke all on function public\.invite_open_for_email\(text\) from anon/);
  assert.match(MIG, /revoke all on function public\.invite_open_for_email\(text\) from authenticated/);
  const a = MAN.indexOf("forward  supabase/migrations/0208_"), b = MAN.indexOf("forward  supabase/migrations/0210_signup_invite_location.sql"), c = MAN.indexOf("forward  supabase/migrations/0236_");
  assert.ok(a > 0 && b > a && c > b, "MANIFEST: 0208 < 0210 < 0236");
  assert.ok(APPLY.includes(MIG.trim()), "APPLY embeds the migration verbatim");
  assert.match(APPLY, /^begin;$/m); assert.match(APPLY, /^commit;$/m); assert.match(APPLY, /-- VERIFY/);
  assert.match(RUNALL, /run "signup-invite-0210" "SIGNUP-INVITE-0210: ALL PASS \\\(39\/39\\\)" psql -q -f tests\/db\/signup-invite-0210\.sql/);
});
t("pins: the changed files are re-pinned on the pages that load them", () => {
  assert.match(LOGIN, /<script src="\/auth-handoff\.js\?v=2"><\/script>/);
  assert.match(ACH, /<script src="\/auth-confirm\.js\?v=7"><\/script>/);
  assert.match(r("public/dashboard.html"), /<script src="trial-demo\.js\?v=(?:1[5-9]|[2-9][0-9])"><\/script>/);
});
console.log(`signup-auth-r19: ${n} checks passed`);
