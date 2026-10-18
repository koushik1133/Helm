// "Send by email" for approval / booklet links + e-mail OTP (client-mailer, _shared/mailer).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0; const t = (name, fn) => { fn(); n++; };
const flow = read("public/flow.html"), appr = read("public/approve.html"), store = read("public/store-api.js");
const cfg = read("public/config.js"), sc = read("public/share-checklist.js"), ems = read("public/email-send.js");
const fn = read("supabase/functions/client-mailer/index.ts"), mailer = read("supabase/functions/_shared/mailer.ts"), otp = read("supabase/functions/send-otp/index.ts");
t("flow: Send by email mounted next to WhatsApp, manual mailto kept", () => {
  assert.match(flow, /HelmEmailSend\.mount\(\$\("#apprLinks"\), \{ quoteId:id, kind:"approval"/);
  assert.match(flow, /HelmWaProposal\.mount/); assert.match(flow, /Email \(manual\)/); assert.match(flow, /email-send\.js\?v=/);
});
t("booklet share: Email booklet to client", () => { assert.match(sc, /HelmEmailSend\.mount\(live, \{ quoteId: quoteId, kind: "booklet"/); });
t("approve: e-mail code is a first-class option", () => { assert.match(appr, /id="sendEmailOtp"/); assert.match(appr, /sendChannel\("email", \$\("#sendEmailOtp"\)\)/); });
t("store: liveChannels.email gates client-mailer + e-mail OTP", () => {
  assert.match(cfg, /email: true/);
  assert.match(store, /channel === "email" \? LIVE\.email : LIVE\.whatsapp/);
  assert.match(store, /LIVE\.email === false\s*\? Promise\.resolve\(\{ status: "not_configured"/);
});
t("UI shows Emailed to / reason", () => { assert.match(ems, /"Emailed to "/); assert.match(ems, /"Not sent: "/); assert.doesNotMatch(ems, /innerHTML/); });
t("client-mailer: JWT verified, quote read as caller, recipient from DB only", () => {
  assert.match(fn, /auth\.getUser\(jwt\)/); assert.match(fn, /asCaller\.from\("quotes"\)/);
  assert.match(fn, /q\.client && q\.client\.email/); assert.doesNotMatch(fn, /body\.(to|email)\b/);
});
t("mailer: Resend then SMTP, pinned denomailer, '<Studio> via Helm'", () => {
  assert.match(mailer, /denomailer@\d+\.\d+\.\d+\/mod\.ts/); assert.match(mailer, /" via Helm"/);
  for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM", "RESEND_API_KEY"]) assert.ok(mailer.includes(k), k);
});
t("send-otp: e-mail via shared mailer, code never in the log row", () => {
  assert.match(otp, /sendMail\(\{ to: String\(dest\.email\)/);
  assert.doesNotMatch(otp.slice(otp.indexOf('from("notifications")'), otp.indexOf('from("notifications")') + 300), /code/);
});
console.log("client-email-send: " + n + " passed");
