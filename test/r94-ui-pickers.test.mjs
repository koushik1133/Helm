// R94: shared Apple-style select/date pickers — exists, loaded on app pages, native fallback, CSP-safe.
import fs from "node:fs";
import assert from "node:assert/strict";

const js = fs.readFileSync("public/ui-pickers.js", "utf8");
const css = fs.readFileSync("public/ui-pickers.css", "utf8");

// native fallback on touch phones + opt-out + multiple skipped
assert.match(js, /\(pointer: coarse\) and \(max-width: 639\.98px\)/, "touch phones keep native pickers");
assert.match(js, /data-native-picker/, "opt-out attribute honoured");
assert.match(js, /sel\.multiple/, "select[multiple] skipped");
// the native control stays the source of truth
assert.match(js, /fire\(sel, "change"\)/, "select fires change");
assert.match(js, /fire\(inp, "change"\)/, "date fires change");
assert.match(js, /MutationObserver/, "late-added controls enhanced");
assert.match(js, /role", "listbox"/);
assert.match(js, /role", "combobox"/);
// CSP: no HTML sinks / inline style attributes
assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, "no HTML sinks");
assert.doesNotMatch(js, /setAttribute\(\s*["']style["']/, "no inline style attributes");
assert.doesNotMatch(js, /\.style\.cssText/, "no cssText");
// viewport clamp + motion
assert.match(js, /vh - MARGIN - h/, "clamps inside viewport");
assert.match(css, /prefers-reduced-motion/);
assert.match(css, /border-radius: 12px/);

// loaded on every app page that uses theme.css, plus the public enquiry form
const pages = fs.readdirSync("public").filter((f) => f.endsWith(".html"));
let loaded = 0;
for (const f of pages) {
  const s = fs.readFileSync("public/" + f, "utf8");
  if (/theme\.css\?v=/.test(s) || f === "enquiry.html") {
    assert.match(s, /ui-pickers\.js\?v=\d+/, f + " loads ui-pickers.js");
    assert.match(s, /ui-pickers\.css\?v=\d+/, f + " loads ui-pickers.css");
    loaded++;
  }
}
for (const f of ["builder.html", "try.html", "capture.html"]) {
  assert.doesNotMatch(fs.readFileSync("public/" + f, "utf8"), /ui-pickers/, f + " left alone (3D canvas)");
}
assert.ok(loaded >= 45, "loaded on app pages (" + loaded + ")");
console.log("r94-ui-pickers: ok (" + loaded + " pages)");
