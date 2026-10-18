#!/usr/bin/env node
// Writes the six Supabase Auth e-mail templates from the shared layout
// (supabase/functions/_shared/email-layout.mjs) into docs/ops/email-templates/ (paste source)
// and mirrors them into docs/email-templates/. `--check` fails if any file is stale.
// Supabase Go-template variables used: {{ .SiteURL }}, {{ .TokenHash }}, {{ .RedirectTo }} (links on
// Helm's own /auth/confirm - 0205), {{ .Email }}, {{ .NewEmail }}, {{ .Token }} and (invite + magic
// link) {{ .Data.studio|role|invited_by }}. {{ .ConfirmationURL }} (the Supabase project URL) is never used.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { layout, h1, para, strong, note, button, fallback, codeBox } from "../supabase/functions/_shared/email-layout.mjs";
import { DEFAULT_POSTAL_ADDRESS } from "../supabase/functions/_shared/email-compliance.mjs";

const root = new URL("../", import.meta.url);
// 0205: every link is on Helm's own domain - {{ .SiteURL }} (Site URL = https://www.helm.events) +
// /auth/confirm (public/auth-confirm.html) with the one-time {{ .TokenHash }}, never the Supabase
// project URL ({{ .ConfirmationURL }}). `next` is LAST: the confirm page takes everything after it.
const link = (type, next) => `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&amp;type=${type}&amp;next=${next}`;
const U_SIGNUP = link("email", "{{ .RedirectTo }}"), U_INVITE = link("invite", "{{ .RedirectTo }}"),
  U_MAGIC = link("magiclink", "{{ .RedirectTo }}"), U_RESET = link("recovery", "/reset-password"),
  U_CHANGE = link("email_change", "{{ .RedirectTo }}");
const EMAIL = "{{ .Email }}";
const SAFE = "If you didn't request this, ignore this email &mdash; nothing changes. Helm will never ask for your password by email.";
const opt = { site: "{{ .SiteURL }}", sub: "" };
// postal address in every footer (HELM_POSTAL_ADDRESS default; fixed here so --check is deterministic)
export const HELM_POSTAL_ADDRESS = DEFAULT_POSTAL_ADDRESS;
const why = (r) => ({ ...opt, reason: r, address: HELM_POSTAL_ADDRESS });
const sentTo = (t) => t + `<br><br>Sent to ${EMAIL}.`;

const INV_SUBJECT = "{{ if .Data.studio }}Join {{ .Data.studio }} on Helm{{ else }}Join your studio on Helm{{ end }}";
const invBody = (URL_) =>
  h1("{{ if .Data.studio }}Join {{ .Data.studio }} on Helm{{ else }}Join your studio on Helm{{ end }}") +
  para(`{{ if .Data.invited_by }}${strong("{{ .Data.invited_by }}")}{{ else }}Your studio admin{{ end }} invited you{{ if .Data.role }} as ${strong("{{ .Data.role }}")}{{ end }}. Accept below with ${strong(EMAIL)}: you choose your password (or sign in, if you already use Helm) and land straight in the studio.`) +
  button(URL_, "Accept invitation") +
  para("This button works once, within 24 hours. If it has expired, click it anyway: the page that opens lets you e-mail yourself a new link.", "0 0 16px") +
  fallback(URL_) + note(sentTo("Not expecting this? If you didn't request this, ignore this email &mdash; nothing happens unless you accept. Helm will never ask for your password by email."));

export const TEMPLATES = {
  "confirm-signup": {
    supabase: "Confirm signup", subject: "Confirm your email for Helm",
    html: layout("Confirm your email for Helm", "One click to confirm your email and open your studio.",
      h1("Confirm your email") +
      para(`Welcome to Helm. Confirm ${strong(EMAIL)} to finish creating your account and open your studio.`) +
      button(U_SIGNUP, "Confirm my email") + fallback(U_SIGNUP) + note(sentTo(SAFE)), why("someone (hopefully you) signed up for Helm with this address")),
  },
  // 0205: ONE invitation e-mail for every invitee. "Invite user" (brand-new address) and "Magic link"
  // (an address that already has a Helm login; invite-mailer refreshes its .Data.studio / role /
  // invited_by first) both read "Join <studio> on Helm - <inviter> invited you as <role>" and land on
  // the same /login?invite=<token> join page. Helm sends magic links only for invitations; without
  // .Data.studio the magic link falls back to the plain sign-in text.
  "invite-user": {
    supabase: "Invite user",
    subject: INV_SUBJECT,
    html: layout("You're invited to Helm", "Accept your invitation to join your studio on Helm.", invBody(U_INVITE), why("a studio on Helm invited this address to join their team")),
  },
  "magic-link": {
    supabase: "Magic link", subject: "{{ if .Data.studio }}Join {{ .Data.studio }} on Helm{{ else }}Your Helm sign-in link{{ end }}",
    html: layout("Your Helm link", "Your Helm link is inside.",
      "{{ if .Data.studio }}" + invBody(U_MAGIC) + "{{ else }}" +
      h1("Sign in to Helm") +
      para(`Tap the button to sign in as ${strong(EMAIL)}. The link works once and expires soon.`) +
      button(U_MAGIC, "Sign in to Helm") + fallback(U_MAGIC) + note(sentTo(SAFE)) + "{{ end }}",
      why("someone asked Helm for a sign-in or invitation link for this address")),
  },
  "reset-password": {
    supabase: "Reset password", subject: "Reset your Helm password",
    html: layout("Reset your Helm password", "Choose a new password for your Helm account.",
      h1("Reset your password") +
      para(`We got a request to reset the password for ${strong(EMAIL)}. Choose a new one below. The link works once and expires soon.`) +
      button(U_RESET, "Choose a new password") + fallback(U_RESET) + note(sentTo(SAFE)), why("someone (hopefully you) asked to reset the password of a Helm account")),
  },
  "change-email": {
    supabase: "Change email address", subject: "Confirm your new email for Helm",
    html: layout("Confirm your new email for Helm", "Confirm the change to your Helm sign-in email.",
      h1("Confirm your new email") +
      para(`You asked to change your Helm sign-in email from ${strong(EMAIL)} to ${strong("{{ .NewEmail }}")}. Confirm below to finish.`) +
      button(U_CHANGE, "Confirm new email") + fallback(U_CHANGE) + note(sentTo(SAFE)), why("someone asked to change the e-mail on a Helm account to this address")),
  },
  // 0205: Supabase "Security notifications" (Authentication -> Emails -> Security). Owner evidence
  // 2026-10-18: the "Password changed" notification carried the Reset-password body (a "Choose a new
  // password" button with an EMPTY link - notifications have no confirmation URL), so it showed as dead
  // text. These two have no one-time link at all: only a fixed "wasn't you? reset it" link.
  "password-changed": {
    supabase: "Password changed (security notification)", subject: "Your Helm password was changed",
    html: layout("Your Helm password was changed", "The password of your Helm account was just changed.",
      h1("Your password was changed") +
      para(`The password for ${strong(EMAIL)} was just changed. If that was you, there's nothing else to do.`) +
      para(`Wasn't you? Reset your password straight away and tell us at ${strong("security@helm.events")}.`, "0 0 16px") +
      button("https://www.helm.events/login#forgot", "Reset my password") + fallback("https://www.helm.events/login#forgot") +
      note(sentTo("Helm will never ask for your password by email.")), why("the password of the Helm account with this address was changed")),
  },
  "email-changed": {
    supabase: "Email address changed (security notification)", subject: "Your Helm sign-in email was changed",
    html: layout("Your Helm sign-in email was changed", "The sign-in email of your Helm account was changed.",
      h1("Your sign-in email was changed") +
      para(`The sign-in email of your Helm account was changed from ${strong(EMAIL)}. If that was you, there's nothing else to do.`) +
      para(`Wasn't you? Write to ${strong("security@helm.events")} from this address straight away.`, "0 0 16px") +
      note(sentTo("Helm will never ask for your password by email.")), why("the sign-in email of the Helm account with this address was changed")),
  },
  "reauthentication": {
    supabase: "Reauthentication", subject: "Your Helm verification code",
    html: layout("Your Helm verification code", "Your Helm verification code is inside.",
      h1("Your verification code") +
      para(`Enter this code in Helm to confirm it's you (${strong(EMAIL)}). It expires soon.`, "0 0 16px") +
      codeBox("{{ .Token }}") + note(sentTo("Never share this code. " + SAFE)), why("someone (hopefully you) asked to confirm a sensitive change on a Helm account")),
  },
};

const DIRS = ["docs/ops/email-templates/", "docs/email-templates/"];
const outName = (dir, n) => (dir === "docs/email-templates/" && n === "invite-user" ? "invite.html" : n + ".html");

if (import.meta.url === `file://${process.argv[1]}`) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const dir of DIRS) for (const [n, t] of Object.entries(TEMPLATES)) {
    const p = new URL(dir + outName(dir, n), root);
    const body = t.html + "\n";
    const cur = existsSync(p) ? readFileSync(p, "utf8") : "";
    if (cur === body) continue;
    if (check) { stale++; console.error("stale:", dir + outName(dir, n)); } else { writeFileSync(p, body); console.log("wrote", dir + outName(dir, n)); }
  }
  if (check && stale) { console.error("run: node scripts/gen-email-templates.mjs"); process.exit(1); }
  if (check) console.log("email templates up to date");
}
