// invite-flow: new invitee sets a password, expired e-mail links are explained, branded
// Supabase templates exist, and the reset-password round trip keeps its redirect.
import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0; const t = (name, fn) => { fn(); n++; };

const login = r("public/login.html"), store = r("public/store-api.js"), reset = r("public/reset-password.js");
const mailer = r("supabase/functions/invite-mailer/index.ts");

t("store records a new-invitee flag only for type=invite links", () => {
  assert.match(store, /const isNew = inviteFragment\.type === "invite"/);
  assert.match(store, /sessionStorage\.setItem\(INVITE_SET_PW_KEY, sr\.data\.user\.id\)/);
  assert.match(store, /inviteSetPasswordPending: \(\) => invitePwPending\(\)/);
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
  assert.match(login, /<h1>Set your password<\/h1>/);
  assert.match(login, /"#invitePwForm"\]/);
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
  assert.ok(login.includes("This email link has expired — ask your studio to resend the invite"));
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
  assert.match(mailer, /studio: String\(r\?\.studio[\s\S]*role: String\(r\?\.role[\s\S]*invited_by: String\(r\?\.inviter/);
  const inv = r("docs/ops/email-templates/invite-user.html");
  for (const v of [".Data.studio", ".Data.role", ".Data.invited_by", ".ConfirmationURL", ".Email"]) assert.ok(inv.includes("{{ " + v), v);
});
t("all five branded templates + doc exist", () => {
  for (const f of ["invite-user", "magic-link", "reset-password", "confirm-signup", "change-email"]) {
    const h = r("docs/ops/email-templates/" + f + ".html");
    assert.ok(h.includes("{{ .ConfirmationURL }}") && h.includes("#6d28d9") && h.includes("Helm"), f);
    assert.ok(!/<script/i.test(h), f + " no script");
  }
  assert.ok(r("docs/ops/email-templates/change-email.html").includes("{{ .NewEmail }}"));
  const doc = r("docs/ops/EMAIL-TEMPLATES.md");
  for (const s of ["http://localhost:4402/**", "https://www.helm.events/**", "https://helm.events/**", "86400", "Email OTP expiration", "Your Helm sign-in link", "Reset your Helm password"]) assert.ok(doc.includes(s), s);
});
console.log(`invite-flow: ${n} checks passed`);
