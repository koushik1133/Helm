#!/usr/bin/env node
// Writes the six Supabase Auth e-mail templates from the shared layout
// (supabase/functions/_shared/email-layout.mjs) into docs/ops/email-templates/ (paste source)
// and mirrors them into docs/email-templates/. `--check` fails if any file is stale.
// Supabase Go-template variables used: {{ .ConfirmationURL }}, {{ .Email }}, {{ .NewEmail }},
// {{ .Token }}, {{ .SiteURL }} and (invite only) {{ .Data.studio|role|invited_by }}.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { layout, h1, para, strong, note, button, fallback, codeBox } from "../supabase/functions/_shared/email-layout.mjs";
import { DEFAULT_POSTAL_ADDRESS } from "../supabase/functions/_shared/email-compliance.mjs";

const root = new URL("../", import.meta.url);
const URL_ = "{{ .ConfirmationURL }}";
const EMAIL = "{{ .Email }}";
const SAFE = "If you didn't request this, ignore this email &mdash; nothing changes. Helm will never ask for your password by email.";
const opt = { site: "{{ .SiteURL }}", sub: "" };
// postal address in every footer (HELM_POSTAL_ADDRESS default; fixed here so --check is deterministic)
export const HELM_POSTAL_ADDRESS = DEFAULT_POSTAL_ADDRESS;
const why = (r) => ({ ...opt, reason: r, address: HELM_POSTAL_ADDRESS });
const sentTo = (t) => t + `<br><br>Sent to ${EMAIL}.`;

export const TEMPLATES = {
  "confirm-signup": {
    supabase: "Confirm signup", subject: "Confirm your email for Helm",
    html: layout("Confirm your email for Helm", "One click to confirm your email and open your studio.",
      h1("Confirm your email") +
      para(`Welcome to Helm. Confirm ${strong(EMAIL)} to finish creating your account and open your studio.`) +
      button(URL_, "Confirm my email") + fallback(URL_) + note(sentTo(SAFE)), why("someone (hopefully you) signed up for Helm with this address")),
  },
  "invite-user": {
    supabase: "Invite user",
    subject: "{{ if .Data.studio }}You're invited to join {{ .Data.studio }} on Helm{{ else }}You're invited to join a studio on Helm{{ end }}",
    html: layout("You're invited to Helm", "Accept your invitation and set your password.",
      h1("{{ if .Data.studio }}Join {{ .Data.studio }} on Helm{{ else }}You're invited to Helm{{ end }}") +
      para(`{{ if .Data.invited_by }}${strong("{{ .Data.invited_by }}")} invited you{{ else }}You've been invited{{ end }} to join {{ if .Data.studio }}${strong("{{ .Data.studio }}")}{{ else }}a studio{{ end }} on Helm{{ if .Data.role }} as ${strong("{{ .Data.role }}")}{{ end }}. Accept below, then choose a password for ${strong(EMAIL)} and you land straight in the studio.`) +
      button(URL_, "Accept invitation") +
      para("This button works once and expires in 24 hours. If it has expired, ask your studio to resend the invite.", "0 0 16px") +
      fallback(URL_) + note(sentTo("Not expecting this? If you didn't request this, ignore this email &mdash; nothing happens unless you accept. Helm will never ask for your password by email.")), why("a studio on Helm invited this address to join their team")),
  },
  "magic-link": {
    supabase: "Magic link", subject: "Your Helm sign-in link",
    html: layout("Your Helm sign-in link", "Your one-click sign-in link for Helm.",
      h1("Sign in to Helm") +
      para(`Tap the button to sign in as ${strong(EMAIL)}. The link works once and expires soon.`) +
      button(URL_, "Sign in to Helm") + fallback(URL_) + note(sentTo(SAFE)), why("someone (hopefully you) asked to sign in to Helm with this address")),
  },
  "reset-password": {
    supabase: "Reset password", subject: "Reset your Helm password",
    html: layout("Reset your Helm password", "Choose a new password for your Helm account.",
      h1("Reset your password") +
      para(`We got a request to reset the password for ${strong(EMAIL)}. Choose a new one below. The link works once and expires soon.`) +
      button(URL_, "Choose a new password") + fallback(URL_) + note(sentTo(SAFE)), why("someone (hopefully you) asked to reset the password of a Helm account")),
  },
  "change-email": {
    supabase: "Change email address", subject: "Confirm your new email for Helm",
    html: layout("Confirm your new email for Helm", "Confirm the change to your Helm sign-in email.",
      h1("Confirm your new email") +
      para(`You asked to change your Helm sign-in email from ${strong(EMAIL)} to ${strong("{{ .NewEmail }}")}. Confirm below to finish.`) +
      button(URL_, "Confirm new email") + fallback(URL_) + note(sentTo(SAFE)), why("someone asked to change the e-mail on a Helm account to this address")),
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
