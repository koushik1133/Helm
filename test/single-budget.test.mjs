// One "Budget" field (saves budget_max); old min-only records show min; old min is kept (hidden), never dropped.
import { readFileSync } from "node:fs"; import assert from "node:assert/strict";
const r = (f) => readFileSync(new URL("../public/" + f, import.meta.url), "utf8");
for (const f of ["flow.html", "discovery.html"]) {
  const h = r(f);
  assert.doesNotMatch(h, /Max should be at least the min/, f);
  assert.doesNotMatch(h, /Budget range \(min|Budget — min|Budget — max/, f);
  assert.match(h, /<label for="d_bmax">Budget \((?:₹|<span class="cur-sym">₹<\/span>)\)<\/label>/, f);   // LA-11: flow shows the quote currency
  assert.match(h, /<input (type="hidden" id="d_bmin"|id="d_bmin" type="hidden")>/, f);
  assert.match(h, /\$\("#d_bmax"\)\.value=d\.budget_max!=null\?d\.budget_max:\(d\.budget_min!=null\?d\.budget_min:""\)/, f);
  assert.match(h, /budget_min/, f);   // the old min is still written back, not nulled
}
assert.match(r("event.html"), /const v=b!=null\?b:a; return v!=null\?inr\(v\):""/);
assert.match(r("leads.html"), /<label for="f_budget">Budget/);
console.log("single-budget: ok");
const idx = r("index.html");
assert.match(idx, /<a href="#film" class="mg-item">[\s\S]{0,120}How it works/);
assert.match(idx, /id="film"/);
assert.doesNotMatch(idx, /href="#how"/);
console.log("how-it-works link: ok");
