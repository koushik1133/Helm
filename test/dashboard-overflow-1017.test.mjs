// Dashboard: nothing overflows its card (Oct 2026) — See more buttons, event mini-cards, card headers.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const css = readFileSync(new URL("../public/shell-b-dash.css", import.meta.url), "utf8");
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log("ok - " + m); };
ok(/\.hd-seemore \{[^}]*box-sizing: border-box;[^}]*width: 100%;[^}]*max-width: 100%/.test(css), "See more is border-box 100% width");
ok(/\.hd-legacy > \.hd-seemore \{ width: calc\(100% - 2 \* var\(--hd-pad\)\)/.test(css), "See more inside adopted cards subtracts the card side margins");
ok(/#mywork > \.pcard \{[^}]*display: flex;[^}]*overflow: hidden;[^}]*padding-bottom: 50px/.test(css), "event mini-cards: flex layout, clipped, room for the toggle");
ok(/#mywork > \.pcard > b \{[^}]*text-overflow: ellipsis/.test(css) && /#mywork > \.pcard > small \{[^}]*text-overflow: ellipsis/.test(css), "long titles / meta ellipsize");
ok(/#mywork > \.pcard > a\.open \{[^}]*float: none !important;[^}]*white-space: nowrap/.test(css), "Open link pinned right, no float wrap");
ok(/#mywork > \.pcard > \.ptoggle \{ position: absolute; left: 14px; bottom: 12px/.test(css), "Show tasks aligned at the card bottom");
ok(/\.hd-tools \{ flex-wrap: wrap;[^}]*min-width: 0/.test(css) && /\.hd-head \{ flex-wrap: wrap; min-width: 0; \}/.test(css), "card header tools wrap on phones");
console.log("dashboard-overflow-1017: " + n + " checks passed");
