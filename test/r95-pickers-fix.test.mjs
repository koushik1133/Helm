// R95: picker flicker fix (class collision + same-gesture guard), full page coverage, datalist popover, form polish.
import fs from "node:fs";
import assert from "node:assert/strict";

const js = fs.readFileSync("public/ui-pickers.js", "utf8");
const css = fs.readFileSync("public/ui-pickers.css", "utf8");
const theme = fs.readFileSync("public/theme.css", "utf8");

// 1. root cause: ui-pickers must not share class names with phone-input.js (.hp-pop/.hp-list/.hp-opt in theme.css)
assert.doesNotMatch(js, /["' .]hp-(pop|open|list|opt|search|empty|up|select|date)\b/, "ui-pickers.js uses its own uip- namespace");
assert.doesNotMatch(css, /\.hp-/, "ui-pickers.css never styles phone-input's .hp-* classes");
assert.match(css, /\.uip-pop\.uip-open \{ opacity: 1/);
// selects already owned by phone-input's searchable picker are skipped (two pickers on one control)
assert.match(js, /hasAttribute\("data-picker"\)/);
assert.match(js, /hp-sel-native/);
// 2. no-flicker guard: the opening press never closes its own popover
assert.match(js, /function sameGesture\(e\)/);
assert.match(js, /function outside\(e\) \{ if \(sameGesture\(e\)\) return;/);
assert.match(js, /e\.stopPropagation\(\); \/\/ page "click outside"/);
assert.match(js, /openEvt = e; openAt = e\.timeStamp/);
// focus-halo is a full shadow value; never wrap it in another shadow
assert.doesNotMatch(css, /0 0 0 3px var\(--focus-halo/);
// Safari never shows its native up/down arrows on an enhanced select
assert.match(css, /appearance: none !important/);
// 3. datalist popover: list moved to data-uip-list, free text kept, late list= handled
assert.match(js, /function enhanceList\(inp\)/);
assert.match(js, /setAttribute\("data-uip-list", id\)/);
assert.match(js, /removeAttribute\("list"\)/);
assert.match(js, /attributeFilter: \["list"\]/);
// CSP
assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
assert.doesNotMatch(js, /setAttribute\(\s*["']style["']/);
// 4. coverage: every page with a select / date / datalist loads ui-pickers (canvas pages excepted)
// marketing (index, demo) + vendor-request: public pages with pinned head/script lists, stay native
// vendor-request.html: public vendor page keeps a fixed 3-script allowlist (r23-vendors), stays native
const skip = new Set(["builder.html", "try.html", "capture.html", "vendor-request.html", "index.html", "demo.html"]);
const miss = [];
for (const f of fs.readdirSync("public").filter((x) => x.endsWith(".html"))) {
  if (skip.has(f)) continue;
  const s = fs.readFileSync("public/" + f, "utf8");
  if (/<select|type="date"|<datalist|\slist="/.test(s) && !/ui-pickers\.js\?v=\d+/.test(s)) miss.push(f);
}
assert.deepEqual(miss, [], "pages with pickers but no ui-pickers.js: " + miss.join(", "));
// 5. Apple form polish lives in shared theme.css; checkbox labels sentence case
assert.match(theme, /R95 Apple-style form controls/);
assert.match(theme, /min-height: 44px/);
assert.match(theme, /accent-color: var\(--accent/);
assert.match(theme, /\.fld label \{ text-transform: none; letter-spacing: normal; \}|\.fld label, html body label\.fld-l, html body \.field > label \{ text-transform: none/);
// 6. setup page spacing: searchable select uses the LEFT padding; country spans the row; steps wrap
assert.match(fs.readFileSync("public/phone-input.js", "utf8"), /"--hp-px", px\(cs\.paddingLeft\)/);
const ob = fs.readFileSync("public/onboarding.js", "utf8");
assert.match(ob, /\.ob-steps\{display:flex;flex-wrap:wrap/);
assert.match(ob, /gap:18px 16px/);
console.log("r95-pickers-fix: ok");

// R95 follow-up: lists opened from a modal <dialog> (top layer) must mount inside that dialog, not <body>
{
  const src = (await import('node:fs')).readFileSync(new URL('../public/ui-pickers.js', import.meta.url), 'utf8');
  if (!/closest\("dialog\[open\]"\)/.test(src) || !/host\.appendChild\(pop\)/.test(src)) { console.error('FAIL: popover not mounted inside open dialog'); process.exit(1); }
  console.log('  ✓ popover mounts inside an open modal dialog');
}
