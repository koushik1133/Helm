// invite-accept-0205: a brand-new invitee can always join. The Supabase "Invite user" e-mail makes
// the login up front WITHOUT a password; when its one-time link's sign-in is lost the join page must
// never say "already has an account - sign in" - it e-mails a new link instead (set password -> join).
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import * as nodeModule from "node:module";
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error("FAIL " + name); throw e; } };

const fn = r("supabase/functions/invite-signup/index.ts");
const login = r("public/login.html"), api = r("public/store-api.js");
const mig = r("supabase/migrations/0205_invite_account_state.sql"), apply = r("supabase/APPLY-0205.sql");
const manifest = r("supabase/migrations/MANIFEST"), runAll = r("scripts/db-test/run-all.sh");

// ---- migration ------------------------------------------------------------------------------
t("0205: ASCII, additive, idempotent, no destructive statements", () => {
  assert.ok(/^[\x00-\x7f]*$/.test(mig) && /^[\x00-\x7f]*$/.test(apply), "ASCII only");
  const code = mig.replace(/--.*$/gm, "");
  assert.ok(!/\b(drop|delete|truncate|update|alter\s+table)\b/i.test(code), "no DROP / DELETE / UPDATE / ALTER TABLE");
  assert.equal((code.match(/\binsert\b/gi) || []).length, 1, "the only write: one bell note");
  assert.match(code, /insert into public\.notifications\(quote_id, channel, kind, status, detail, org_id\)/);
  assert.equal((mig.match(/create or replace function/g) || []).length, 4);
});
t("0205: invite_account_state is service-role only and looks at ONE valid invitation", () => {
  assert.match(mig, /invite_account_state\(p_token text\)[\s\S]*security definer set search_path = ''/);
  assert.match(mig, /grant execute on function public\.invite_account_state\(text\) to service_role/);
  assert.match(mig, /revoke all on function public\.invite_account_state\(text\) from authenticated/);
  assert.match(mig, /revoke all on function public\.invite_account_state\(text\) from anon/);
  assert.match(mig, /status is distinct from 'pending'[\s\S]*expires_at <= now\(\)/);
  assert.match(mig, /'needs_password'/);
  assert.match(mig, /provider, ''\) <> 'email'/, "a Google / other sign-in counts as a real account");
  assert.ok(!/'email',\s*v_/.test(mig) && !/'user_id'/.test(mig), "never returns the address or the user id");
});
t("0205: my_needs_password is about the caller's OWN login only", () => {
  assert.match(mig, /my_needs_password\(\)[\s\S]*where u\.id = auth\.uid\(\)/);
  assert.match(mig, /grant execute on function public\.my_needs_password\(\) to authenticated/);
});
t("0205: MANIFEST + APPLY (with VERIFY) + DB suite registered", () => {
  assert.match(manifest, /^forward  supabase\/migrations\/0205_invite_account_state\.sql$/m);
  assert.ok(apply.includes(mig.trim()), "APPLY embeds the migration verbatim");
  assert.match(apply, /^begin;$/m); assert.match(apply, /^commit;$/m); assert.match(apply, /-- VERIFY/);
  assert.match(runAll, /INVITE-ACCEPT-0205: ALL PASS \\\(40\/40\\\)/);
});

// ---- edge function invite-signup ----------------------------------------------------------------
t("invite-signup: an 'already registered' login made by the invite is needs_link, not account_exists", () => {
  const i = fn.indexOf("if (isAlready(cErr))"); assert.ok(i > 0);
  const blk = fn.slice(i, i + 700);
  assert.match(blk, /st\.account === "needs_link"\) return json\(\{ error: NEEDS_LINK_MSG, code: "needs_link" \}, 409\)/);
  assert.match(blk, /code: "account_exists" \}, 409\)/);
  assert.match(fn, /admin\.rpc\("invite_account_state", \{ p_token: token \}\)/);
});
t("invite-signup: resend goes ONLY to the invitation's own e-mail, rate limited, never creates a user by OTP", () => {
  const i = fn.indexOf("if (resend) {\n      const st"); assert.ok(i > 0);
  const blk = fn.slice(i, fn.indexOf("if (bound !== email)"));
  assert.match(blk, /inviteUserByEmail\(bound, \{ redirectTo: link \}\)/);
  assert.match(blk, /signInWithOtp\(\{ email: bound, options: \{ shouldCreateUser: false, emailRedirectTo: link \} \}\)/);
  assert.ok(!/body\.email|\bemail\b(?!:)/.test(blk.replace(/email: bound/g, "").replace(/e-mail/g, "")), "the typed e-mail is never used to send");
  assert.match(blk, /st\.account === "existing"\) return json\(\{ error: EXISTS_MSG, code: "account_exists" \}, 409\)/);
  assert.match(fn, /\["invrs:tok:" \+ token, 3, 60 \* 60_000\], \["invrs:ip:" \+ ip, 10, 60 \* 60_000\]/);
  assert.match(fn, /const resend = !peek && body\.resend === true/);
  // resend is checked against the same pending + unexpired invitation as the form
  assert.ok(fn.indexOf('inv.status !== "pending"') < i, "invitation validated before any send");
});
t("invite-signup: peek gives the invite context (studio, inviter display name, role label) + own e-mail + account", () => {
  assert.match(fn, /const info = \{ email: bound, studio: ctx\.studio, inviter: ctx\.inviter, role: String\(inv\.role \?\? ""\), role_label: roleLabel\(inv\.role\) \}/);
  assert.match(fn, /st\.account === "unknown" \? info : \{ \.\.\.info, account: st\.account \}/);
  assert.match(fn, /from\("profiles"\)\.select\("full_name"\)/, "inviter = display name only");
  // a dead token: reason + studio only (never the e-mail)
  assert.match(fn, /code: "invalid_invite", \.\.\.\(reason \? \{ reason \} : \{\}\), \.\.\.\(studio \? \{ studio \} : \{\}\)/);
  assert.match(fn, /ask \$\{who\} to resend it/);
});
t("invite-signup: an EXPIRED invitation is never renewed - the studio is asked (bell)", () => {
  assert.match(fn, /if \(resend && reason === "expired"\)[\s\S]{0,300}admin\.rpc\("invite_request_new_link", \{ p_token: token \}\)/);
});
t("invite-signup: with a provider, resend sends the branded link (Supabase only generates it)", () => {
  assert.match(fn, /const ltype = st\.confirmed === true \? "magiclink" : "invite";/);
  assert.match(fn, /admin\.auth\.admin\.generateLink\(\{ type: ltype, email: bound, options: \{ redirectTo: link \} \}\)/);
  assert.match(fn, /confirmLink\(String\(gl\?\.properties\?\.hashed_token \?\? ""\), ltype, "\/login\?invite=" \+ token/);
  assert.match(fn, /newLinkEmail\(\{ link: action/);
});
t("invite-signup: no PII in logs", () => {
  assert.ok(!/console\.(log|error)\([^)]*(email|password|token|bound)\b/.test(fn));
});
t("invite-signup: helpers behave (mapAccount / joinLink)", () => {
  const strip = nodeModule.stripTypeScriptTypes;
  if (typeof strip !== "function") return;   // older Node: the static checks above still ran
  const pick = (name) => { const a = fn.indexOf("export function " + name); const b = fn.indexOf("\n}\n", a); return fn.slice(a, b + 2).replace(/^export /, ""); };
  const src = strip("const TOKEN = /^[0-9a-f]{48}$/;\n" + pick("joinLink") + "\n" + "type AccountState = string;\n" + pick("mapAccount")) + "\nreturn { joinLink, mapAccount };";
  const { joinLink, mapAccount } = new Function(src)();
  const tok = "a".repeat(48);
  assert.equal(joinLink(tok, "https://www.helm.events/x"), "https://www.helm.events/login?invite=" + tok);
  assert.equal(joinLink(tok, "javascript:alert(1)"), "https://www.helm.events/login?invite=" + tok);
  assert.equal(joinLink(tok, "http://evil.test"), "https://www.helm.events/login?invite=" + tok);
  assert.equal(joinLink("nothex", ""), null);
  assert.deepEqual(mapAccount({ valid: true, account: "none", confirmed: false }), { account: "new", confirmed: false });
  assert.deepEqual(mapAccount({ valid: true, account: "needs_password", confirmed: true }), { account: "needs_link", confirmed: true });
  assert.deepEqual(mapAccount({ valid: true, account: "existing", confirmed: true }), { account: "existing", confirmed: true });
  assert.deepEqual(mapAccount({ valid: false }), { account: "unknown", confirmed: null });
  assert.deepEqual(mapAccount(null), { account: "unknown", confirmed: null });
  assert.deepEqual(mapAccount({ valid: true, account: "weird" }), { account: "unknown", confirmed: null });
});

// ---- store-api --------------------------------------------------------------------------------
t("store-api: peek + resendLink helpers", () => {
  assert.match(api, /async peek\(token\)/);
  assert.match(api, /body: JSON\.stringify\(\{ token, resend: true \}\)/);
  assert.match(api, /async invitedEmail\(token\) \{ const p = await invitations\.peek\(token\); return p && !p\.invalid \? p\.email : null; \}/);
  assert.match(api, /return \{ invalid: true, reason:/);
  assert.match(api, /if \(res\.ok && j && j\.requested === true\) return \{ requested: true/);
  assert.match(api, /invite_link_request: \["/, "bell label for the studio");
});
t("store-api: after an e-mail link sign-in, 'Set your password' follows the server (own login), else type=invite", () => {
  assert.match(api, /let needPw = isNew;/);
  assert.match(api, /supa\.rpc\("my_needs_password"\)/);
  assert.match(api, /if \(needPw && sr && !sr\.error && sr\.data && sr\.data\.user\) sessionStorage\.setItem\(INVITE_SET_PW_KEY/);
  // the link session is still only adopted when nobody is signed in (login-CSRF guard kept)
  assert.match(api, /if \(!\(cur && cur\.data && cur\.data\.session\)\) \{/);
});

// ---- login page ---------------------------------------------------------------------------------
t("login: new-link card, never 'sign in' for a login without a password", () => {
  assert.match(login, /<section class="card" id="inviteLinkCard" hidden aria-labelledby="ilTitle">/);
  assert.ok(login.includes(">Email me a new link to set my password</button>"));
  assert.ok(login.includes("works once and only for 24 hours"));
  assert.match(login, /"#invitePwForm","#inviteLinkCard"\]/);
  assert.match(login, /if\(x&&x\.code==="needs_link"\)\{ showInviteLink\(email, x\.reason==="unconfirmed"\); return; \}/);
  assert.ok(!login.includes('x.message+" Use the Sign in tab above."'), "old dead-end text gone");
});
t("login: invite context on EVERY path - Join <Studio> on Helm + <Inviter> invited you as <Role> + e-mail", () => {
  assert.match(login, /function inviteTitle\(\)\{ return "Join "\+\(INVITE_ORG\|\|"your studio"\)\+" on Helm"; \}/);
  assert.match(login, /function inviteLine\(\)\{ return \(\(INV&&INV\.inviter\)\|\|"Your studio admin"\)\+" invited you"\+\(INV&&INV\.role\?" as "\+INV\.role:""\); \}/);
  assert.match(login, /\$\("#formTitle"\)\.textContent = J\(\) \? inviteTitle\(\)/);            // join form + sign-in
  assert.match(login, /J\(\)\?inviteLine\(\)\+"\. Choose a password to join\."/);
  assert.match(login, /J\(\)\?inviteLine\(\)\+"\. Sign in to accept\."/);
  assert.match(login, /\$\("#ilTitle"\)\.textContent=inviteTitle\(\);\s*\$\("#ilLine"\)\.textContent=inviteLine\(\)/);   // new-link card
  assert.match(login, /\$\("#ipTitle"\)\.textContent="Join "\+\(st\|\|"your studio"\)\+" on Helm"/);                // set password
  assert.match(login, /\$\("#ipEmail"\)\.textContent=u\.email\|\|""/);
  assert.match(login, /coordinator:"Event coordinator"/, "human role labels when only the anon preview answers");
  // the context is loaded BEFORE a link session accepts the invitation (the token closes then)
  const i = login.indexOf("if(JOINING) await Promise.race([loadInviteCtx()"), j = login.indexOf("if(BPStore.auth.pendingUser()){", i);
  assert.ok(i > 0 && j > i);
});
t("login: the way in is decided only when nobody is signed in", () => {
  assert.match(login, /await loadInviteCtx\(\);\s*if\(BPStore\.auth\.user\(\)\) return;/);
  assert.match(login, /if\(!INV\.valid\)\{ showInviteDead\(\); return; \}/);
  assert.match(login, /if\(INV\.account==="needs_link"\|\|INV\.account==="unconfirmed"\) showInviteLink\(INV\.email, INV\.account==="unconfirmed"\);\s*else if\(INV\.account==="existing"\) showSignInForInvite\(INV\.email\);/);
  assert.match(login, /if\(JOINING\) applyInviteEntry\(\)\.catch/);
});
t("login: expired / used link -> 'ask <studio> to resend it' + Email me a new link; dead token never rides a sign-in", () => {
  assert.ok(login.includes('"This invitation link has expired or was already used — ask "+who+" to resend it."'));
  assert.match(login, /IL_DEAD_LABEL="Email me a new link"/);
  assert.match(login, /INVITE_DEAD=true; clearInvite\(\);/);
  assert.match(login, /const pendingInvite=\(\)=>\{ if\(INVITE_DEAD\) return null;/);
  assert.match(login, /if\(INVITE_DEAD && INV && INV\.reason==="used"\)\{[^}]*openForgot\(\)/, "used: the normal reset link (PKCE)");
  assert.match(login, /if\(r && r\.requested\)/, "expired: the studio was asked");
});
t("login: an existing account signs in with the invite kept (accepted right after sign-in)", () => {
  assert.match(login, /function showSignInForInvite\(em\)\{[\s\S]*?setMode\("signin"\)/);
  assert.match(login, /if\(joining\)\{ await acceptPendingInvite\(\); \}/);
  assert.match(login, /if\(c==="account_exists"\)\{ showSignInForInvite\(inviteAddr\); return; \}/);
  assert.match(login, /\(J\(\)\?"Sign in to accept →":"Sign in →"\)/);
});
t("login: Google on the invite page joins the invited studio", () => {
  assert.ok(!/body\.invite-join[^{]*#googleBtn/.test(login), "Google button not hidden on the join form");
  assert.match(login, /signInWithGoogle\(location\.origin\+"\/login\.html\?"\+\(tok\?"invite="\+encodeURIComponent\(tok\)\+"&":""\)\+"next="/);
  // back from Google: a session + the pending invite → resumeSession accepts (same e-mail checked by the DB)
  assert.match(login, /if\(pendingInvite\(\)\)\{\s*const tok=pendingInvite\(\);\s*try\{ await acceptPendingInvite\(\); \}/);
});
t("login: resend button cools down and shows only our own messages", () => {
  const i = login.indexOf('$("#ilSend").addEventListener'); assert.ok(i > 0);
  const blk = login.slice(i, i + 2200);
  assert.match(blk, /BPStore\.invitations\.resendLink\(inviteTok\|\|pendingInvite\(\)\)/);
  assert.match(blk, /cooldown\(b,label,COOLDOWN\)/);
  assert.match(blk, /\/\^\(rate_limited\|send_failed\|invalid_invite\|unavailable\|network\)\$\/\.test\(c\)/);
});
t("login: no inline style on the new card", () => {
  const i = login.indexOf('id="inviteLinkCard"'); const blk = login.slice(i, login.indexOf("</section>", i));
  assert.ok(!/style=/.test(blk));
});
t("an invitee never goes through the self sign-up (no 'Confirm your email' e-mail)", () => {
  const i = login.indexOf("if(joining){"), j = login.indexOf("// r22 step 1: the account only", i);
  assert.ok(i > 0 && j > i);
  const blk = login.slice(i, j);
  assert.ok(!/signUp\(/.test(blk.replace(/\/\/.*$/gm, "")), "no signUp() on the invite path");
  assert.match(blk, /We couldn't create your account just now/);
});
t("self sign-up never confirmed -> new link (confirms + joins), never 'sign in'", () => {
  assert.match(mig, /v_state := 'unconfirmed'/);
  assert.match(fn, /if \(r\.account === "unconfirmed"\) return \{ account: "unconfirmed", confirmed: false \}/);
  assert.match(fn, /code: "needs_link", reason: "unconfirmed"/);
  assert.match(login, /INV\.account==="unconfirmed"\) showInviteLink\(INV\.email, INV\.account==="unconfirmed"\)/);
});
t("a login already in another studio gets a plain explanation", () => {
  assert.match(login, /already belong to an organi\[sz\]ation/);
  assert.ok(login.includes("a login can be in one studio at a time"));
});
// ---- one invitation e-mail for everyone ----------------------------------------------------------
t("invite-mailer: every invitee gets the same branded invitation when a provider is set", () => {
  const mailer = r("supabase/functions/invite-mailer/index.ts"), tpl = r("supabase/functions/invite-mailer/templates.ts");
  assert.match(mailer, /if \(mail && branded\) res = await sendBranded\(to, mail/);
  assert.match(tpl, /button\(esc\(link\), "Accept invitation"\)/);
});
t("Supabase templates: Invite user + Magic link read as the same invitation", () => {
  const inv = r("docs/ops/email-templates/invite-user.html"), ml = r("docs/ops/email-templates/magic-link.html");
  for (const h of [inv, ml]) {
    assert.ok(h.includes("Join {{ .Data.studio }} on Helm") && h.includes("{{ .Data.invited_by }}") && h.includes("{{ .Data.role }}") && h.includes(">Accept invitation<"));
  }
  assert.ok(ml.includes("{{ if .Data.studio }}") && ml.includes("Sign in to Helm"), "plain sign-in only without invitation data");
  const gen = r("scripts/gen-email-templates.mjs");
  assert.match(gen, /"magic-link": \{\s*supabase: "Magic link", subject: "\{\{ if \.Data\.studio \}\}Join \{\{ \.Data\.studio \}\} on Helm\{\{ else \}\}Your Helm sign-in link\{\{ end \}\}"/);
});
console.log(`invite-accept-0205: ${n} checks passed`);
