// r78: referral-demo.js (never deployed) is requested ONLY on localhost + ?demo=1; consumers wait for it only then.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const g = require("../public/referral-demo-gate.js");
for (const [h, s, want] of [["localhost", "?demo=1", true], ["127.0.0.1", "?a=2&demo=1", true], ["[::1]", "demo=1", true],
  ["localhost", "", false], ["localhost", "?demo=10", false], ["helm.events", "?demo=1", false], ["www.helm.events", "?demo=1", false],
  ["localhost.evil.com", "?demo=1", false], ["", "?demo=1", false]]) assert.equal(g.demoWanted(h, s), want, h + s);
for (const f of ["login.html", "refer.html", "hq-referrals.html"]) {
  const src = read("public/" + f);
  assert.doesNotMatch(src, /referral-demo\.js/, f + ": no static demo tag (404 + MIME error in prod)");
  assert.match(src, /referral-demo-gate\.js\?v=\d+/, f + ": loads the gate");
}
assert.match(read("public/refer-boot.js"), /if \(!g \|\| !g\.wanted\) return;/, "refer-boot lifts the gate synchronously only when the demo is wanted");
for (const f of ["refer.js", "hq-referrals.js", "referral-signup.js"]) {
  assert.match(read("public/" + f), /if \(g && g\.wanted\) g\.ready\.then\(run\); else run\(\);/, f + ": waits for the demo only when wanted");
}
assert.doesNotMatch(read(".vercelignore"), /referral-demo-gate/, "gate is deployed");
console.log("r78-referral-demo-gate: ok");
