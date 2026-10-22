// r29 referral program PHASE 1 (UI only, local): the shared rules, the localhost-only demo guard, the pages' wiring,
// the /r/<code> redirect and the sign-up field. No network, no SQL.
import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const R = require("../public/referral-rules.js");
const DAY = 864e5, NOW = Date.UTC(2026, 9, 21, 6);

// ---- codes
assert.equal(R.normalizeCode(" shaadisq-7k2q "), "SHAADISQ-7K2Q");
for (const bad of ["", "ab", "-ABC", "A B<", "x".repeat(25), "../evil", "javascript:1"]) assert.equal(R.normalizeCode(bad), "", bad);
let i = 0; const seq = () => (i++ % 7) / 7;
const pc = R.personalCode("Shaadi Squad Events!", seq);
assert.match(pc, /^SHAADISQ-[2-9A-HJ-NP-Z]{4}$/, "8 letters + 4 safe characters");
assert.equal(R.shareLink("demo123", "https://helm.events/"), "https://helm.events/r/DEMO123");
assert.equal(R.shareLink("<x>"), "", "bad codes never become links");

// ---- qualifying
const base = { signedUpAt: NOW - 40 * DAY, planStartedAt: NOW - 32 * DAY };
assert.equal(R.qualifies({ ...base }, NOW).status, "first_month");
assert.equal(R.qualifies({ signedUpAt: NOW - 3 * DAY }, NOW).status, "trial");
assert.equal(R.qualifies({ ...base, firstPaidAt: NOW - 5 * DAY }, NOW).status, "hold", "14-day hold after the first real payment");
assert.deepEqual(R.qualifies({ ...base, firstPaidAt: NOW - 15 * DAY }, NOW), { ok: true, status: "qualified", reason: "" });
assert.equal(R.qualifies({ ...base, firstPaidAt: NOW - 20 * DAY, refunded: true }, NOW).reason, "refunded");
assert.equal(R.qualifies({ ...base, firstPaidAt: NOW - 20 * DAY, chargeback: true }, NOW).reason, "refunded");
assert.equal(R.qualifies({ ...base, selfReferral: true, firstPaidAt: NOW - 20 * DAY }, NOW).reason, "self_referral");
assert.equal(R.qualifies({ ...base, existingCustomer: true }, NOW).reason, "existing");
assert.equal(R.qualifies({ signedUpAt: NOW - 61 * DAY }, NOW).reason, "no_payment", "must pay within 60 days");
assert.equal(R.qualifies({ ...base, cancelled: true }, NOW).reason, "cancelled");
assert.equal(R.qualifies({ ...base, firstPaidAt: NOW - 20 * DAY, cancelled: true, cancelledAt: NOW - 18 * DAY }, NOW).reason, "cancelled", "cancelled inside the hold");
assert.equal(R.qualifies({ ...base, codeAddedAt: base.signedUpAt + 15 * DAY }, NOW).reason, "code_after", "late code > 14 days");
assert.equal(R.qualifies({ ...base, firstPaidAt: NOW - 20 * DAY, codeAddedAt: NOW - 19 * DAY }, NOW).reason, "code_after", "code after first payment");
assert.equal(R.qualifies({ ...base, firstPaidAt: NOW - 20 * DAY, flagged: true }, NOW).status, "review");
assert.equal(R.qualifies({ ...base, firstPaidAt: NOW - 20 * DAY, flagged: true, approved: true }, NOW).status, "qualified");

// ---- free months: next renewals in a row (month 3 paid -> month 4 free -> billing resumes month 5), yearly = extend
const ren = Date.UTC(2026, 0, 31);
const s = R.freeSchedule({ earned: 2, nextRenewalAt: ren, interval: "monthly" });
assert.equal(s.length, 2);
assert.equal(new Date(s[0].to).toISOString().slice(0, 10), "2026-02-28", "31 Jan + 1 month clamps to 28 Feb");
assert.equal(s[1].from, s[0].to, "stacked months are consecutive");
const y = R.freeSchedule({ earned: 3, nextRenewalAt: ren, interval: "yearly" });
assert.equal(y.length, 1); assert.equal(y[0].kind, "extend"); assert.equal(new Date(y[0].to).toISOString().slice(0, 7), "2026-04");
assert.equal(R.freeSchedule({ earned: 40, nextRenewalAt: ren }).length, R.RULES.capPerYear, "capped at 12");
assert.equal(R.capRoom(11, 3), 1); assert.equal(R.capRoom(12, 1), 0);
assert.equal(R.monthValueUsd("starter"), 24); assert.equal(R.monthValueUsd("enterprise"), 59, "enterprise valued at Studio");

// ---- fraud signals
assert.equal(R.fraudSignals({ email: "a@x.in" }, { email: "A@X.in" }).action, "reject");
assert.equal(R.fraudSignals({ cardFp: "c1" }, { cardFp: "c1" }).action, "reject");
assert.equal(R.fraudSignals({ email: "a@gmail.com" }, { email: "b@gmail.com" }).action, "auto", "public mail domains are not a signal");
assert.equal(R.fraudSignals({ email: "a@studio.in" }, { email: "b@studio.in" }).action, "review");
assert.equal(R.fraudSignals({ ip: "1.2.3.4" }, { ip: "1.2.3.4" }).action, "review");
assert.equal(R.fraudSignals({}, { codeSignups24h: 9 }).action, "review");

// ---- partner codes
assert.equal(R.partnerOffer({ reward: "months", months: 2 }), "2 free months after your first payment");
assert.equal(R.partnerOffer({ reward: "percent", percent: 30, forMonths: 3 }), "30% off for 3 months after your first payment");
assert.equal(R.partnerUsable({ active: true, expiresAt: NOW - 1 }, NOW).ok, false);
assert.equal(R.partnerUsable({ active: true, maxUses: 5, uses: 5 }, NOW).ok, false);
assert.equal(R.partnerUsable({ active: false }, NOW).ok, false);

// ---- demo data: localhost + ?demo=1 only
const demo = read("public/referral-demo.js");
function runDemo(host, search, path = "/refer") {
  const win = {}; win.window = win; win.location = { hostname: host, search, pathname: path };
  vm.runInNewContext(demo, win); return win.HelmReferralDemo;
}
assert.ok(runDemo("localhost", "?demo=1"), "demo on localhost");
assert.ok(runDemo("127.0.0.1", "?x=1&demo=1"));
assert.equal(runDemo("www.helm.events", "?demo=1"), undefined, "never on the live site");
assert.equal(runDemo("localhost.evil.com", "?demo=1"), undefined);
assert.equal(runDemo("localhost", "?demo=10"), undefined);
assert.equal(runDemo("localhost", ""), undefined);
assert.ok(runDemo("localhost", "?demo=1").store, "studio page gets the sidebar stand-in");
assert.equal(runDemo("localhost", "?demo=1", "/hq-referrals").store, undefined);
assert.match(read(".vercelignore"), /^public\/referral-demo\.js$/m, "demo data is never deployed");
for (const f of ["refer.js", "hq-referrals.js", "referral-signup.js", "refer-boot.js"])
  assert.match(read("public/" + f), /localhost\|127\\\.0\\\.0\\\.1\|\\\[::1\\\]/, f + " re-checks the host");

// ---- pages + CSP hygiene: no inline scripts / handlers, DOM via textContent
for (const p of ["refer.html", "hq-referrals.html", "referral-terms.html"]) assert.ok(existsSync(new URL("../public/" + p, import.meta.url)), p);
for (const f of ["refer.js", "hq-referrals.js", "referral-signup.js", "referral-rules.js", "referral-demo.js"]) {
  const src = read("public/" + f);
  assert.doesNotMatch(src, /\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\(|fetch\(|XMLHttpRequest/, f + ": no HTML sinks, no network");
}
const refer = read("public/refer.html");
assert.match(refer, /<html[^>]*class="auth-pending"/, "studio page is behind the sign-in gate");
assert.ok(refer.indexOf("refer-boot.js") < refer.indexOf("store-api.js"), "demo gate lift runs before store-api");
assert.ok(refer.indexOf("referral-demo.js") < refer.indexOf("refer-boot.js"));
assert.doesNotMatch(refer, /<script>(?!<\/script>)|\son[a-z]+=/i);
const hq = read("public/hq-referrals.html");
assert.doesNotMatch(hq, /store-api\.js|auth-pending/, "HQ preview has no data outside the demo (no session needed)");
assert.match(read("public/hq-referrals.js"), /if \(!R \|\| !D\) \{ \$\("vSoon"\)\.hidden = false; return; \}/, "non-demo: notice only");
const terms = read("public/referral-terms.html");
assert.match(terms, /Draft: the program is not live yet/);
for (const k of ["self-referral", "chargeback", "no cash value", "14 days", "12 free months", "ASCI", "Cookie Policy"]) assert.ok(terms.toLowerCase().includes(k.toLowerCase()), "terms mention " + k);

// ---- sign-up page
const login = read("public/login.html");
assert.match(login, /id="rfsRow" class="rfs-row" hidden/);
assert.match(login, /id="rfsBanner"[^>]*hidden/);
assert.ok(login.indexOf('id="rfsRow"') < login.indexOf('id="agreeRow"'), "code field sits above the Terms box");
assert.match(login, /<input type="checkbox" id="rfsConsent">/, "name-sharing consent is optional and unticked");
const sig = read("public/referral-signup.js");
assert.match(sig, /qs\.get\("ref"\)/);
assert.doesNotMatch(sig, /qs\.get\("code"\)/, "?code= belongs to the auth callback");
assert.match(sig, /sessionStorage/); assert.doesNotMatch(sig, /localStorage/, "kept for this tab only in phase 1");
assert.match(read("public/referral-signup.css"), /\.rfs-banner\[hidden\]/, "[hidden] wins over display:flex");

// ---- sidebar + routing
assert.match(read("public/shell-proto.js"), /refer: 1/);
assert.match(read("public/shell-b.js"), /item\("gift", "Refer a studio", "refer\.html", "refer"\)/);
assert.match(read("public/store-api.js"), /"ready", "refer", "reports"/, "refer is a valid ?next= page");
const srv = read("server.js");
assert.match(srv, /\/\^\\\/r\\\/\(\[\^\/\]\{1,40\}\)\\\/\?\$\//, "/r/<code> route");
assert.match(srv, /\^\[A-Z0-9\]\[A-Z0-9_-\]\{2,23\}\$/, "same code shape as referral-rules.js");
assert.match(srv, /encodeURIComponent\(code\)/);

console.log("r29-referral-ui: ok");
