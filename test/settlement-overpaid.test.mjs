// Settlement display: overpaid balance + unpriced-invoice warning (display only, no writes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../public/settlement.html", import.meta.url), "utf8");
const api = readFileSync(new URL("../public/store-api.js", import.meta.url), "utf8");

test("budget.summary exposes an additive pricingMissing flag (revenue math unchanged)", () => {
  assert.match(api, /pricingMissing: !\(Number\(baseRevenue\) > 0\)/);
  assert.match(api, /const baseRevenue = \(ev && \(ev\.total != null \? ev\.total : \(ev\.pricing && ev\.pricing\.total\)\)\) \|\| 0;/);
  assert.match(api, /received, balance, pricingMissing: !!b\.pricingMissing,/);
  // the flag's semantics: missing / 0 / non-numeric total => true
  const f = (t) => !(Number((t ?? null) || 0) > 0);
  assert.equal(f(undefined), true); assert.equal(f(0), true); assert.equal(f(125000), false);
});

test("negative balance renders as Overpaid credit, never ₹-X in the clear style", () => {
  assert.match(html, /\$\("#t_bal_l"\)\.textContent=over\?"Overpaid":"Balance due"/);
  assert.match(html, /inr\(over\?-s\.balance:s\.balance\)/);
  assert.match(html, /"Credit due to client"/);
  assert.match(html, /Overpaid — credit due to client/);
  assert.doesNotMatch(html, /"n "\+\(s\.balance>0/);
});

test("unpriced invoice with payments shows a warning; amounts carry the privacy marker", () => {
  assert.match(html, /id="priceWarn"[^>]*role="alert"[^>]*hidden>This event has no priced invoice — price the quote to settle\./);
  assert.match(html, /\$\("#priceWarn"\)\.hidden=!\(s\.pricingMissing && s\.received>0\)/);
  assert.match(html, /bn\.setAttribute\("data-money",""\)/);
  assert.match(html, /<b data-money style="color:var\(--warn-text,#946200\)">\$\{inr\(-s\.balance\)\}/);
});
