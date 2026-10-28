// Round 21 - e-mail + outgoing link audit (EMAIL-AND-LINKS-AUDIT.md):
//  1. Staff "Invite to log in" / Settings "Users & invites": only a real send says "sent"; queued-but-not-sent,
//     skipped and failed say plainly that nothing has gone out (no "Helm will retry automatically" promise - there is
//     no guaranteed retry unless the owner scheduled the invite-mailer cron)
//  2. trial welcome invite step: "Invites sent" only when the mailer really sent (sent > 0, no failed / skipped)
//  3. invitation website / booklet "Send to client" history: a row still Queued after 15 minutes is flagged
//     "not sent yet" with a Copy-link hint (comms-dispatch runs only from the owner's cron)
//  4. /auth/confirm keeps the invite token when the e-mail link was made on the apex (helm.events) and opened on www
//  5. client-mailer: default link host is https://www.helm.events and APP_URL is honoured
//  6. Operations "Remind due" / "Fire due tasks": say the reminder is LOGGED (no SMS to staff is live) instead of "Sent"
//  7. Nurture "Send greeting" / "Run now": the greeting is only logged (no e-mail sender reads it) - say so
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error("FAIL " + name); throw e; } };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + " missing");
  let i = src.indexOf("{", src.indexOf(")", at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + " unterminated");
};
const STAFF = r("public/staff.html"), CC = r("public/control.html"), TD = r("public/trial-demo.js"), OPS = r("public/ops.html");
const ISH = r("public/invite-site-share.js"), CM = r("supabase/functions/client-mailer/index.ts");

t("1a Staff page invite e-mail line: sent / failed / skipped / queued / dormant / unavailable", () => {
  const ctx = {}; vm.runInNewContext(fnSrc(STAFF, "inviteMailText") + "\nglobalThis.f=inviteMailText;", ctx);
  const f = (x) => ctx.f(x, "a@x.com");
  assert.equal(f({ status: "ok", sent: 1, skipped: 0, failed: 0 }), "Invitation email sent to a@x.com.");
  assert.match(f({ status: "ok", sent: 0, skipped: 0, failed: 1 }), /couldn't be sent .*check the email setup.*Copy the link/);
  assert.match(f({ status: "ok", sent: 0, skipped: 1, failed: 0 }), /wasn't sent/);
  assert.match(f({ status: "ok", sent: 0, skipped: 0, failed: 0 }), /queued for a@x\.com but not sent yet/);
  assert.match(f({ status: "dormant" }), /switched off/);
  assert.match(f({ status: "unavailable", reason: "not_deployed" }), /nothing was emailed/);
  assert.match(f(null), /couldn't confirm the email/);
  for (const x of [{ status: "ok", sent: 0, failed: 1 }, { status: "ok", sent: 0 }, null]) assert.doesNotMatch(f(x), /on its way|retry automatically|email sent/i);
});
t("1b Settings invite message: same rules, [kind, text]", () => {
  const ctx = {}; vm.runInNewContext(fnSrc(CC, "inviteMailMsg") + "\nglobalThis.f=inviteMailMsg;", ctx);
  assert.deepEqual(ctx.f({ status: "ok", sent: 1 }, "a@x.com")[0], "ok");
  assert.equal(ctx.f({ status: "ok", sent: 1, failed: 1 }, "a@x.com")[0], "err");
  const sk = ctx.f({ status: "ok", sent: 0, skipped: 1 }, "a@x.com");
  assert.equal(sk[0], "info"); assert.match(sk[1], /wasn't sent/);
  const q = ctx.f({ status: "ok", sent: 0, skipped: 0, failed: 0 }, "a@x.com", true);
  assert.equal(q[0], "info"); assert.match(q[1], /queued but not sent yet.*Resend email or use Copy link/);
  assert.doesNotMatch(ctx.f({ status: "ok", sent: 0, failed: 1 }, "a@x.com")[1], /It will retry/);
  assert.match(ctx.f({ status: "unavailable", reason: "unauthorized" }, "a@x.com")[1], /--no-verify-jwt/);
});
t("2 trial welcome invites: 'sent' only for a run that really sent", () => {
  const ctx = {}; vm.runInNewContext(fnSrc(TD, "inviteMailOk") + "\nglobalThis.m=inviteMailOk;", ctx);
  assert.equal(ctx.m({ status: "ok", sent: 2, failed: 0 }), true);
  assert.equal(ctx.m({ status: "ok", sent: 0, failed: 0, skipped: 0 }), false, "nothing sent (queued behind the cap)");
  assert.equal(ctx.m({ status: "ok", sent: 1, skipped: 1 }), false);
  assert.equal(ctx.m({ status: "ok", sent: 1, failed: 1 }), false);
  assert.equal(ctx.m({ status: "unavailable" }), false);
  assert.match(TD, /we couldn't confirm their e-mails were sent/);
  assert.doesNotMatch(TD, /their e-mails go out shortly/);
});
t("3 Send to client history: a Queued row older than 15 minutes is flagged", () => {
  const ctx = { window: {}, document: {} }; vm.runInNewContext(ISH, ctx);
  const S = ctx.window.HelmInviteShare; assert.ok(S && typeof S.staleQueued === "function");
  const now = Date.parse("2026-10-19T10:00:00Z");
  assert.equal(S.staleQueued([{ status: "queued", at: "2026-10-19T09:50:00Z" }], now), false, "10 min: still fine");
  assert.equal(S.staleQueued([{ status: "queued", at: "2026-10-19T09:40:00Z" }], now), true, "20 min: stuck");
  assert.equal(S.staleQueued([{ status: "sent", at: "2026-10-19T08:00:00Z" }], now), false);
  assert.equal(S.staleQueued([{ status: "pending", at: "bad" }], now), false);
  assert.equal(S.staleQueued(null, now), false);
  assert.match(S.STALE_NOTE, /Not sent yet.*Copy link/);
  assert.match(ISH, /stale\.hidden = !staleQueued\(list\);/);
  assert.match(ISH, /if \(staleQueued\(\[r\]\)\) label = "Queued — not sent yet";/);
});
t("4 /auth/confirm: an apex link keeps its invite token on www; other hosts still refused", () => {
  const C = require("../public/auth-confirm-core.js");
  const INV = "a1".repeat(24), H = "f".repeat(56);
  const p = C.parse("?token_hash=" + H + "&type=invite&next=https://helm.events/login?invite=" + INV, "https://www.helm.events");
  assert.equal(p.ok, true); assert.equal(p.next, "/login?invite=" + INV); assert.equal(p.invite, INV);
  const w = C.parse("?token_hash=" + H + "&type=invite&next=https://www.helm.events/login?invite=" + INV, "https://helm.events");
  assert.equal(w.invite, INV);
  for (const bad of ["https://evil.example/login?invite=" + INV, "http://helm.events/login?invite=" + INV, "https://helm.events.evil.example/login?invite=" + INV]) {
    const x = C.parse("?token_hash=" + H + "&type=invite&next=" + bad, "https://www.helm.events");
    assert.equal(x.invite, null, bad);
  }
  // staging keeps the strict same-origin rule
  assert.equal(C.parse("?token_hash=" + H + "&type=invite&next=https://helm.events/login?invite=" + INV, "https://helm-v01.vercel.app").invite, null);
});
t("5 client-mailer: canonical www default, APP_URL honoured", () => {
  assert.match(CM, /Deno\.env\.get\("APP_ORIGIN"\) \|\| Deno\.env\.get\("APP_URL"\)/);
  assert.match(CM, /: "https:\/\/www\.helm\.events";/);
  assert.doesNotMatch(CM, /: "https:\/\/helm\.events";/);
});
t("6 Operations reminders say 'Logged', not 'Sent' / 'assignees notified'", () => {
  assert.match(OPS, /"Logged "\+n\+" reminder"/);
  assert.match(OPS, /"Marked "\+n\+" task"/);
  assert.doesNotMatch(OPS, /"Sent "\+n\+" reminder"/);
  assert.doesNotMatch(OPS, /assignees notified/);
});
t("7 Nurture greetings say 'prepared and logged - nothing was e-mailed' (queue_nurture_greeting only logs)", () => {
  const NU = r("public/nurture.html");
  assert.match(NU, /Greeting prepared and logged: /);
  assert.match(NU, /Prepared and logged \$\{n\} greeting/);
  assert.match(NU, /so nothing was e-mailed/);
  assert.doesNotMatch(NU, /Greeting queued: /);
  assert.doesNotMatch(NU, /`Queued \$\{n\} greeting/);
});
console.log("r21-email-audit: " + n + " checks passed");
