// r21 business ui: the Business page layout pass (presentation only). Static checks + a DOM-free run of
// the sample-name helper. Data, links, gates and masking stay as they were.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const rd = (p) => readFileSync(p, "utf8");
const M = rd("public/shell-b-money.js"), V = rd("public/vendor-bills-ui.js"), C = rd("public/business.css"), H = rd("public/business.html");
let n = 0; const t = (name, fn) => { fn(); n++; };

t("source chip moved under the title (same two texts), no lone footer note", () => {
  assert.match(M, /var note = el\("p", "bz-src"\); note\.hidden = true; hl\.appendChild\(note\);/);
  assert.match(M, /"Exact numbers from your payment ledger\."/);
  assert.match(M, /"Showing estimates from your latest quotes \(exact ledger numbers aren't available on this account yet\)\."/);
  assert.ok(!/root\.appendChild\(note\)/.test(M), "note is no longer appended at the page foot");
});
t("section jump links point at real ids", () => {
  for (const id of ["bz-overview", "bz-revenue", "bz-upcoming", "bz-overdue", "bz-pipeline", "bz-clients"]) {
    assert.ok(M.includes('"#' + id + '"'), "nav link " + id);
    assert.ok(M.includes('"' + id + '")') || M.includes('kpis.id = "' + id + '"'), "element id " + id);
  }
  assert.match(M, /\["#vbBiz", "Profit & payables"\]/); assert.match(H, /<div id="vbBiz" data-vb-mount="business" data-vb-gate="bzApp" hidden><\/div>/);
});
t("gates + data calls unchanged", () => {
  assert.match(M, /S\(\)\.dashboard\.money\(12\)/); assert.match(rd("public/business.js"), /await A\.canView\("business"\)/);
  assert.match(M, /var insL = link\("insights\.html", "bz-btn", "Insights"\); insL\.hidden = true;/);
  assert.match(V, /B\.vendorBills\.payables\(\)/); assert.match(V, /B\.vendorBills\.business\(ymd\(from\), ymd\(to\)\)/); assert.match(V, /d\.getMonth\(\) \+ 13, 0\)/);
  assert.match(V, /closure\.html\?quote=" \+ encodeURIComponent\(e\.quote_id\)/);
});
t("profit tables: header row, numeric columns marked, money masked on the span (not the cell), phone labels", () => {
  assert.match(V, /\["Month", "txt"\], \["Events", "num"\], \["Revenue", "money"\], \["Net profit", "money"\]/);
  assert.match(V, /\["Event", "txt"\], \["Margin", "num"\], \["Revenue", "money"\], \["Net profit", "money"\]/);
  assert.match(V, /money\(el\("span", "bz-m", v\)\)/); assert.ok(!/money\(el\("td"/.test(V));
  assert.match(V, /c\.setAttribute\("data-label", cols\[i\]\[0\]\)/); assert.match(V, /t\.setAttribute\("data-tm", "off"\)/);
  assert.match(V, /pill\("Upcoming", "bz-pill-up"\)/); assert.ok(!/\(upcoming\)"/.test(V), "no more '(upcoming)' text");
  assert.match(V, /pay\.currencies\.length > 1/); assert.match(V, /studioCurrency\(\)/);
});
t("every amount still data-money; masking override is page-scoped and keeps the dots", () => {
  assert.ok((V.match(/money\(el\(/g) || []).length >= 2); assert.match(M, /setAttribute\("data-money"/);
  assert.match(C, /html\.hb-priv-on body\.bz-body \.bz \[data-money\]:not\(svg\):not\(svg \*\) \{ background: transparent !important;/);
  assert.ok(!/content:\s*none/.test(C.split("r21 business ui")[1] || ""), "never hides the dots");
});
t("tables become cards on phones", () => {
  assert.match(C, /@media \(max-width: 640px\)[\s\S]*\.bz-tbl tr \{ display: grid;/);
  assert.match(C, /\.bz-tbl td\.num::before \{ content: attr\(data-label\);/);
});
t("sample-name helper (display only)", () => {
  const src = M.slice(M.indexOf("var SAMPLE_RE"), M.indexOf("function body(c)"));
  const doc = { createElement: (tag) => ({ tag, className: "", textContent: "", kids: [], title: "", appendChild(k) { this.kids.push(k); return k; } }) };
  const fn = new Function("document", "el", src + "; return { nameTag: nameTag, plainName: plainName };");
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = String(text); return e; };
  const { nameTag, plainName } = fn(doc, el);
  const a = nameTag("Demo · Sharma Wedding"); assert.equal(a.kids[0].textContent, "Sharma Wedding"); assert.equal(a.kids[1].textContent, "Sample");
  const b = nameTag("SAMPLE - Reddy & Co"); assert.equal(b.kids[0].textContent, "Reddy & Co"); assert.equal(b.kids.length, 2);
  const c = nameTag("Pandit Ji (sample)"); assert.equal(c.kids[0].textContent, "Pandit Ji"); assert.equal(c.kids.length, 2);
  const d = nameTag("Samplers Inc"); assert.equal(d.kids[0].textContent, "Samplers Inc"); assert.equal(d.kids.length, 1);
  assert.equal(nameTag("Demo-Day Events").kids.length, 1, "a real name starting Demo- is left alone");
  assert.equal(plainName("Demo · Sharma Family"), "Sharma Family"); assert.equal(plainName("Priya"), "Priya");
});
t("assets bumped", () => {
  assert.match(H, /business\.css\?v=9"/); assert.match(H, /shell-b-money\.js\?v=10"/); assert.match(H, /vendor-bills-ui\.js\?v=11"/);
});
console.log("r21-business-ui: " + n + " checks passed");
