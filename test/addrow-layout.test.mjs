// Static guard: inline add-rows must wrap inside their card (no "+ Add" overflow).
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const css = readFileSync(new URL("../public/theme.css", import.meta.url), "utf8");
assert.match(css, /\.addrow:not\(#_\),\.reserve-row:not\(#_\)\{display:flex;flex-wrap:wrap/, "shared add-row flex-wrap rule");
assert.match(css, /\.addrow:not\(#_\)>\*,\.reserve-row:not\(#_\)>\*\{flex:1 1 150px;min-width:0/, "children may shrink");
assert.match(css, /\.addrow:not\(#_\) \.btn,\.reserve-row:not\(#_\) \.btn\{white-space:nowrap\}/, "button label never wraps");
assert.match(css, /\.addrow:not\(#_\)>\[hidden\]/, "hidden fields stay hidden");
const rs = readFileSync(new URL("../public/runsheet.html", import.meta.url), "utf8");
assert.match(rs, /id="r_add">＋ Add item<\/button>/, "run-sheet full label");
for (const f of ["runsheet.html","resources.html","logistics.html","control.html","inventory.html"]) {
  const h = readFileSync(new URL("../public/" + f, import.meta.url), "utf8");
  assert.match(h, /theme\.css\?v=/, f + " loads theme.css");
}
console.log("addrow-layout: ok");
