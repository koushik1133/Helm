// invite-flow: new invitee sets a password, expired e-mail links are explained, branded
// Supabase templates exist, and the reset-password round trip keeps its redirect.
import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0; const t = (name, fn) => { fn(); n++; };

const login = r("public/login.html"), store = r("public/store-api.js"), reset = r("public/reset-password.js");
const mailer = r("supabase/functions/invite-mailer/index.ts");

t("store records a new-invitee flag for type=invite links (or a login without a password, 0205)", () => {
  // R32 AUTH-4: only the /auth/confirm path (asks "Continue as <e-mail>" first) marks it; the legacy
  // #access_token fragment path is gone. 0205: the server (my_needs_password) decides; type=invite otherwise.
  const ac = r("public/auth-confirm.js");
  assert.match(ac, /var need = link\.type === "invite";/);
  assert.match(ac, /var np = await BPStore\.auth\.needsPassword\(\);/);
  assert.match(ac, /BPStore\.auth\.markInviteLinkSession\(need\);/);
  assert.match(store, /markInviteLinkSession\(needPw\) \{/);
  assert.match(store, /inviteSetPasswordPending: \(\) => invitePwPending\(\)/);
  assert.doesNotMatch(store, /inviteFragment/);
});
t("setInvitePassword uses updateUser({password, data:{full_name}}) behind the flag + password rule", () => {
  const m = store.match(/async setInvitePassword\([\s\S]*?\n    \},/); assert.ok(m);
  assert.match(m[0], /if \(!invitePwPending\(\)\)/);
  assert.match(m[0], /passwordProblem\(newPassword\)/);
  assert.match(m[0], /password: newPassword, data: \{ full_name: name \}/);
  assert.match(m[0], /supa\.auth\.updateUser\(attrs\)/);
});
t("login shows Set your password after accepting, only when pending", () => {
  assert.match(login, /id="invitePwForm" hidden/);
  assert.match(login, /<h1 id="ipTitle">Join your studio on Helm<\/h1>/);   // 0205: invite context on this path too
  assert.match(login, /Set your password for <b id="ipEmail"><\/b>/);
  assert.match(login, /"#invitePwForm"(,"#inviteLinkCard")?\]/);
  const i = login.indexOf("await acceptPendingInvite(); }\n        catch(err){ showInviteError");
  const j = login.indexOf("inviteSetPasswordPending()) await inviteSetPassword()");
  const k = login.indexOf("await routeSignedIn();", j);
  assert.ok(i > 0 && j > i && k > j, "accept → set password → route");
  assert.ok(!/id="invitePwForm"[^>]*style=/.test(login), "no inline style on the new form");
});
t("hash error fragments (otp_expired / access_denied) are read and stripped", () => {
  assert.match(store, /hp\.get\("error_code"\) \|\| hp\.get\("error"\)/);
  assert.match(store, /error\|error_code\|error_description\)=/);
  assert.match(login, /otp_expired\|access_denied\|expired/);
  // 0205: links work once, within 24 h; the page then offers the right way in (new link / form / sign in)
  assert.ok(login.includes("This email link has expired or was already used — each link works once, within 24 hours."));
  assert.match(reset, /otp_expired\|access_denied\/\.test\(String\(BPStore\.auth\.linkError\(\)/);
  assert.ok(!/location\.hash/.test(reset), "reset page never reads the fragment itself");
});
t("reset flow: forgot → /reset-password redirect → updatePassword → login?reset=1", () => {
  assert.match(login, /requestPasswordReset\(em,\{[^}]*redirectTo: location\.origin\+"\/reset-password"/);
  assert.match(store, /redirectTo: \(opts && opts\.redirectTo\) \|\| \(location\.origin \+ "\/reset-password"\)/);
  assert.match(reset, /BPStore\.auth\.updatePassword\(a, opts\)/);
  assert.match(reset, /location\.replace\("login\?reset=1"\)/);
  assert.match(login, /QS\.get\("reset"\)==="1"/);
});
t("invite-mailer metadata keys match the template variables", () => {
  assert.match(mailer, /studio: String\(r\?\.studio[\s\S]*role: roleLabel\(r\?\.role\)[\s\S]*invited_by: String\(r\?\.inviter/);   // 0205: human role label
  const inv = r("docs/ops/email-templates/invite-user.html");
  for (const v of [".Data.studio", ".Data.role", ".Data.invited_by", ".TokenHash", ".RedirectTo", ".Email"]) assert.ok(inv.includes("{{ " + v), v);
});
t("all five branded templates + doc exist", () => {
  for (const f of ["invite-user", "magic-link", "reset-password", "confirm-signup", "change-email"]) {
    const h = r("docs/ops/email-templates/" + f + ".html");
    assert.ok(h.includes("{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}") && !h.includes("ConfirmationURL") && h.includes("#0d8a5c") && h.includes("https://www.helm.events/email/helm-logo-v3.png") && h.includes("Helm"), f);
    assert.ok(!/<script/i.test(h), f + " no script");
  }
  assert.ok(r("docs/ops/email-templates/change-email.html").includes("{{ .NewEmail }}"));
  const doc = r("docs/ops/EMAIL-TEMPLATES.md");
  for (const s of ["http://localhost:4402/**", "https://www.helm.events/**", "https://helm.events/**", "86400", "Email OTP expiration", "Your Helm sign-in link", "Reset your Helm password"]) assert.ok(doc.includes(s), s);
});
console.log(`invite-flow: ${n} checks passed`);
