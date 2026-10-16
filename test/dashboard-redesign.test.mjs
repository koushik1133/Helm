// Dashboard redesign: Fraunces display font loaded on the dashboard only; shell-b-dash keeps the
// preserved element contracts, builds DOM without data-bearing innerHTML or inline styles, honours
// reduced motion, and never renders money on the client-facing dashboard.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const html = readFileSync("public/dashboard.html", "utf8");
const js = readFileSync("public/shell-b-dash.js", "utf8");
const css = readFileSync("public/shell-b-dash.css", "utf8");
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
const code = noComments(js);

const fontLink = html.match(/<link[^>]+href="https:\/\/fonts\.googleapis\.com\/css2\?[^"]+"/);
assert.ok(fontLink, "dashboard has a Google Fonts stylesheet link");
assert.match(fontLink[0], /family=Fraunces:opsz,wght@9\.\.144,400;9\.\.144,500;9\.\.144,600/, "loads Fraunces 400/500/600 with opsz axis");
assert.match(fontLink[0], /display=swap/, "font-display swap");
assert.equal((html.match(/fonts\.googleapis\.com\/css2/g) || []).length, 1, "single font request");

for (const id of ["createBtn", "gsCard", "mytasksSection", "myworkSection", "elist", "roleboard", "loginBtn", "nextName"])
  assert.ok(new RegExp("[\"'#]" + id + "\\b").test(code), "shell-b-dash.js still handles #" + id);

// innerHTML only ever cleared (= "" / '') - never assigned data
for (const m of code.matchAll(/\b(innerHTML|outerHTML)\s*\+?=\s*([^;\n]*)/g))
  assert.match(m[2].trim(), /^(""|''|``)$/, "no data-bearing " + m[1] + " assignment: " + m[0]);
assert.ok(!/insertAdjacentHTML|document\.write\s*\(/.test(code), "no insertAdjacentHTML / document.write");

assert.ok(!/setAttribute\(\s*["']style["']/.test(code), "no setAttribute('style')");
assert.ok(!/style=["'\\]/.test(code), "no style= in markup strings");

assert.match(css, /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/, "reduced-motion block in shell-b-dash.css");

// Owner decision (Oct 2026): Demo 1 shows Revenue (finance roles only); every amount goes through
// mny() / HelmMoney.money, i.e. [data-money], so privacy mode masks it. No other block creates money.
assert.match(code, /function mny\(n\) \{ var h = HM\(\); if \(h && h\.money\) return h\.money\(n\); n\.setAttribute\("data-money", ""\); return n; \}/, "mny marks data-money");
assert.match(code, /mny\(el\("b", "hd-rv-total"\)\)/, "revenue total is data-money");
assert.match(code, /HM\(\)\.revenueBars\(booked, collected, now, "hd-rv-"\)/, "chart from shell-b-money.js (svg is data-money)");
assert.match(code, /canView\("finance"\)\.then/, "revenue gated on finance view");
for (const b of ["calendar", "revenue", "upcoming", "followups", "notes", "activity", "attention", "pipeline"]) assert.match(code, new RegExp('block: "' + b + '"'), "data-block " + b);
assert.ok(code.includes("A free day, nothing booked."), "calendar empty day");
assert.ok(!/dataset\.money\s*=/.test(code), "no dataset.money assignment");
assert.match(css, /\.hd-dash \.hd-money\s*\{\s*display:\s*none/, "hd-money spans are hidden");
console.log("dashboard-redesign: ok");
