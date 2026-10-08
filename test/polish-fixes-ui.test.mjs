// feat/polish-fixes: static + unit checks for the polish pass.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const r = (p) => fs.readFileSync(new URL("../public/" + p, import.meta.url), "utf8");

const login = r("login.html");
assert.match(login, /\.meter\[hidden\],#pwRules\[hidden\],#pwHint\[hidden\]\{display:none\}/, "sign-in hides strength meter/rules");
assert.match(login, /\$\("#pwMeter"\)\.hidden = m!=="signup"/);

const booklet = r("booklet.html");
assert.match(booklet, /<meta name="bp-theme-toggle" content="off">/, "booklet opts out of floating theme toggle");
assert.match(r("booklet.css"), /\.bp-theme-toggle\{display:none!important\}/);

const ui = r("auth-ui.js");
assert.match(ui, /function cropThen\(f, done\)/, "profile photo crop step");
assert.match(ui, /cropThen\(f, upload\)/);
assert.match(ui, /hau_mfa_nudge_session/, "2FA nudge once per session");
assert.match(ui, /tourActive\(\)/, "2FA nudge waits for tour");
assert.match(ui, /hau-notes-pad/, "mobile bottom padding under notices");

assert.match(r("ops.html"), /\.chip\{max-width:100%;min-width:0;flex-wrap:wrap;overflow-wrap:anywhere/);
assert.match(r("event.html"), /\[ev\.code,ev\.title\]\.filter\(\(v,i,a\)=>v&&a\.indexOf\(v\)===i\)/);
assert.match(r("builder.js"), /\[q\.code,q\.title\]\.filter\(\(v,i,a\)=>v&&a\.indexOf\(v\)===i\)/);
assert.match(r("nav-trail.js"), /"CODE CODE"/);

// client initials skip non-letters
const ctx = { window: {}, document: { querySelector: () => null, addEventListener() {} }, console };
ctx.globalThis = ctx; ctx.self = ctx.window;
const src = r("client.js");
const m = src.match(/function initials\(name\) \{[\s\S]*?\n  \}/);
const initials = vm.runInNewContext("(" + m[0] + ")");
assert.equal(initials("E2E Kapoor Wedding (testing)"), "EK");
assert.equal(initials("Asha Rao"), "AR");
assert.equal(initials("(123) !!"), "?");
assert.equal(initials(""), "?");
console.log("polish-fixes-ui: ok");
