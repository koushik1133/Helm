// Control Center > Pricing & coupons: every edge case of the Default pricing fields and the coupon form.
// Owner report (Oct 2026): clearing or changing the chair price said "update the price of the chair and
// plates" as if both were zero. Now each field has its own rule and its own message under it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const PF = require("../public/pricing-form-core.js");
const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
let n = 0; const t = (name, fn) => { fn(); n++; };

const IN = { symbol: "₹", taxName: "GST", split: true };
const AE = { symbol: "AED ", taxName: "VAT", split: false };
const good = { chairPrice: "200", platePrice: "500", gstPct: "18", cateringGstPct: "18", serviceChargePct: "0", layoutBase: "0", conflictBufferHours: "3" };
const withv = (k, v) => Object.assign({}, good, { [k]: v });
const one = (k, v, ctx, flags) => PF.validatePricing(withv(k, v), ctx || IN, flags ? { [k]: flags } : {});

// ---------------- Default pricing ----------------
t("valid defaults pass and come back as numbers", () => {
  const r = PF.validatePricing(good, IN);
  assert.equal(r.ok, true); assert.equal(r.first, null);
  assert.deepEqual(r.values, { chairPrice: 200, platePrice: 500, gstPct: 18, cateringGstPct: 18, serviceChargePct: 0, layoutBase: 0, conflictBufferHours: 3 });
});
t("empty chair price: an error at the chair field ONLY - nothing about plates", () => {
  const r = one("chairPrice", "");
  assert.equal(r.ok, false); assert.equal(r.first, "chairPrice");
  assert.deepEqual(Object.keys(r.errors), ["chairPrice"]);
  assert.equal(r.errors.chairPrice, "Enter a price per chair (₹0 or more).");
  assert.doesNotMatch(r.errors.chairPrice, /plate|both|zero/i);
  assert.equal(r.values.platePrice, 500, "the plate price is still read normally");
});
t("empty plate price: an error at the plate field only", () => {
  const r = one("platePrice", "   ");
  assert.deepEqual(Object.keys(r.errors), ["platePrice"]);
  assert.equal(r.errors.platePrice, "Enter a price per plate (₹0 or more).");
  assert.doesNotMatch(r.errors.platePrice, /chair|both/i);
});
t("both empty: two separate messages, one per field", () => {
  const r = PF.validatePricing(Object.assign({}, good, { chairPrice: "", platePrice: "" }), IN);
  assert.equal(r.first, "chairPrice");
  assert.match(r.errors.chairPrice, /per chair/); assert.match(r.errors.platePrice, /per plate/);
});
t("0 is a valid price (it is confirmed, not refused)", () => {
  for (const k of ["chairPrice", "platePrice", "layoutBase", "gstPct", "cateringGstPct", "serviceChargePct", "conflictBufferHours"]) {
    const r = one(k, "0"); assert.equal(r.ok, true, k); assert.equal(r.values[k], 0, k);
  }
});
t("negative values are refused at the field (typed, or pasted and cleared by the hardener)", () => {
  assert.match(one("chairPrice", "-1").errors.chairPrice, /Negative amounts aren.t allowed\. Enter ₹0 or more/);
  assert.match(one("platePrice", "", null, { rejected: "negative" }).errors.platePrice, /Negative amounts/);
  assert.match(one("gstPct", "-5").errors.gstPct, /Negative numbers/);
  assert.match(one("conflictBufferHours", "-2").errors.conflictBufferHours, /Negative numbers/);
});
t("non-numeric input is refused (letters, e-notation, symbols, two dots, a browser 'bad input')", () => {
  for (const v of ["abc", "1e3", "12a", "1.2.3", "₹200", "1,000", "Infinity", "NaN", "."]) {
    assert.match(one("chairPrice", v).errors.chairPrice || "", /Enter a number, like 250/, v);
  }
  assert.match(one("chairPrice", "", null, { badInput: true }).errors.chairPrice, /Enter a number/);
  assert.match(one("gstPct", "x").errors.gstPct, /like 18/);
  assert.match(one("conflictBufferHours", "x").errors.conflictBufferHours, /like 3/);
});
t("more than 2 decimal places is refused; 1-2 places are kept exactly", () => {
  assert.match(one("chairPrice", "199.555").errors.chairPrice, /at most 2 decimal places/);
  assert.match(one("gstPct", "18.125").errors.gstPct, /at most 2 decimal places/);
  assert.match(one("conflictBufferHours", "2.125").errors.conflictBufferHours, /at most 2 decimal places/);
  assert.equal(one("chairPrice", "199.5").values.chairPrice, 199.5);
  assert.equal(one("chairPrice", "199.50").values.chairPrice, 199.5);
  assert.equal(one("platePrice", "0.01").values.platePrice, 0.01);
  assert.equal(one("platePrice", ".5").values.platePrice, 0.5);
  assert.equal(one("chairPrice", "0200").values.chairPrice, 200, "leading zeros are just the number");
  assert.equal(one("chairPrice", " 250 ").values.chairPrice, 250, "spaces around are ignored");
});
t("GST is 0 to 28 %", () => {
  assert.equal(one("gstPct", "28").ok, true);
  assert.equal(one("gstPct", "28.01").errors.gstPct, "GST can be 0 to 28%.");
  assert.equal(one("gstPct", "100").errors.gstPct, "GST can be 0 to 28%.");
  assert.equal(one("cateringGstPct", "29").errors.cateringGstPct, "Catering GST can be 0 to 28%.");
  assert.equal(one("gstPct", "5").values.gstPct, 5);
});
t("GST may not be left empty (a blank rate would drop tax from new quotes)", () => {
  assert.match(one("gstPct", "").errors.gstPct, /Enter the GST rate \(0 to 28%\)\. 0 is allowed\./);
  assert.match(one("cateringGstPct", "").errors.cateringGstPct, /Enter the catering GST rate/);
});
t("outside India the tax is called VAT and the catering box may be empty (one rate applies)", () => {
  assert.match(one("gstPct", "", AE).errors.gstPct, /Enter the VAT rate/);
  assert.equal(one("gstPct", "30", AE).errors.gstPct, "VAT can be 0 to 28%.");
  const r = one("cateringGstPct", "", AE);
  assert.equal(r.ok, true); assert.equal(r.values.cateringGstPct, null, "null = follow the main rate (control.html uses gstPct)");
  assert.match(one("chairPrice", "", AE).errors.chairPrice, /Enter a price per chair \(AED 0 or more\)\./);
});
t("service charge is optional and 0 to 50 %", () => {
  assert.equal(one("serviceChargePct", "").values.serviceChargePct, 0);
  assert.equal(one("serviceChargePct", "50").ok, true);
  assert.equal(one("serviceChargePct", "50.5").errors.serviceChargePct, "Service charge can be 0 to 50%.");
});
t("layout & setup fee is optional (empty = 0) and capped at Rs 10 crore", () => {
  assert.equal(one("layoutBase", "").values.layoutBase, 0);
  assert.equal(one("layoutBase", "100000000").ok, true);
  assert.match(one("layoutBase", "100000001").errors.layoutBase, /Layout & setup fee can be at most ₹10,00,00,000\./);
});
t("chair / plate price is capped at Rs 1 crore (in the studio's currency)", () => {
  assert.equal(one("chairPrice", "10000000").ok, true);
  assert.match(one("chairPrice", "10000001").errors.chairPrice, /Price \/ chair can be at most ₹1,00,00,000\./);
  assert.match(one("platePrice", "99999999999", AE).errors.platePrice, /Price \/ plate can be at most AED 10,000,000\./);
});
t("venue booking gap is 0 to 48 hours; empty keeps the 3-hour default", () => {
  assert.equal(one("conflictBufferHours", "").values.conflictBufferHours, 3);
  assert.equal(one("conflictBufferHours", "48").ok, true);
  assert.equal(one("conflictBufferHours", "2.5").values.conflictBufferHours, 2.5);
  assert.equal(one("conflictBufferHours", "49").errors.conflictBufferHours, "The booking gap can be 0 to 48 hours.");
});
t("the first wrong field (in form order) is the one focused", () => {
  const r = PF.validatePricing(Object.assign({}, good, { gstPct: "40", layoutBase: "-1" }), IN);
  assert.equal(r.first, "gstPct"); assert.deepEqual(Object.keys(r.errors).sort(), ["gstPct", "layoutBase"]);
});
t("field ids match control.html", () => {
  const F = PF.fields(IN), html = read("public/control.html");
  for (const k of Object.keys(F)) assert.match(html, new RegExp('<input id="' + F[k].id + '"'), F[k].id);
});

// ---------------- "Chairs free?" ----------------
t("changing ONLY the chair price to 0 asks about chairs only", () => {
  const z = PF.newlyZero({ chairPrice: 0, platePrice: 500 }, { chairPrice: 200, platePrice: 500 });
  assert.deepEqual(z, ["chairs"]);
  const c = PF.zeroConfirm(z, IN);
  assert.equal(c.title, "Chairs free?"); assert.match(c.text, /^Chairs will cost nothing \(price per chair = 0\)/);
  assert.doesNotMatch(c.text, /plate|both/i); assert.doesNotMatch(c.text, /₹/, "no amount: privacy mode would blank it");
});
t("changing only the plate price to 0 asks about plates only", () => {
  const z = PF.newlyZero({ chairPrice: 200, platePrice: 0 }, { chairPrice: 200, platePrice: 450 });
  assert.deepEqual(z, ["plates"]); assert.equal(PF.zeroConfirm(z).title, "Plates free?");
});
t("both changed to 0 in the same save: one question naming both", () => {
  const c = PF.zeroConfirm(PF.newlyZero({ chairPrice: 0, platePrice: 0 }, { chairPrice: 1, platePrice: 2 }));
  assert.equal(c.title, "Chairs and plates free?");
});
t("a price that was ALREADY 0 is not asked about again (only the field that changed)", () => {
  assert.deepEqual(PF.newlyZero({ chairPrice: 0, platePrice: 0 }, { chairPrice: 0, platePrice: 500 }), ["plates"]);
  assert.deepEqual(PF.newlyZero({ chairPrice: 0, platePrice: 300 }, { chairPrice: "0", platePrice: 500 }), []);
  assert.equal(PF.zeroConfirm([]), null);
});
t("a studio that never saved a price (default 200 shown) and picks 0 is asked", () => {
  assert.deepEqual(PF.newlyZero({ chairPrice: 0, platePrice: 500 }, {}), ["chairs"]);
  assert.deepEqual(PF.newlyZero({ chairPrice: 0, platePrice: 500 }, { chairPrice: null }), ["chairs"]);
});

// ---------------- Coupons ----------------
const ex = ["DIWALI10", "summer"];
t("coupon code: empty, spaces, symbols, too short / long, must start with a letter or number", () => {
  assert.equal(PF.checkCouponCode("", ex).error, "Enter a coupon code, like DIWALI10.");
  assert.equal(PF.checkCouponCode("   ", ex).error, "Enter a coupon code, like DIWALI10.");
  assert.match(PF.checkCouponCode("NEW YEAR", ex).error, /No spaces/);
  assert.match(PF.checkCouponCode("save$5", ex).error, /Use only letters, numbers, - or _/);
  assert.match(PF.checkCouponCode("<b>", ex).error, /Use only letters/);
  assert.match(PF.checkCouponCode("-SALE", ex).error, /Start the code with a letter or number/);
  assert.match(PF.checkCouponCode("AB", ex).error, /3 to 20 characters/);
  assert.match(PF.checkCouponCode("A".repeat(21), ex).error, /3 to 20 characters/);
  assert.equal(PF.checkCouponCode("A".repeat(20), ex).ok, true);
});
t("coupon code is trimmed and upper-cased; NEW-YEAR_25 style is fine", () => {
  assert.deepEqual(PF.checkCouponCode("  new-year_25 ", ex), { ok: true, value: "NEW-YEAR_25" });
});
t("a code that already exists is refused at the field, whatever its case", () => {
  assert.match(PF.checkCouponCode("diwali10", ex).error, /^DIWALI10 already exists/);
  assert.match(PF.checkCouponCode("SUMMER", ex).error, /^SUMMER already exists/);
  assert.equal(PF.checkCouponCode("DIWALI11", ex).ok, true);
});
t("% coupon: required, more than 0, at most 100, 2 decimals", () => {
  assert.equal(PF.checkCouponValue("", "percent").error, "Enter the % off (1 to 100).");
  assert.match(PF.checkCouponValue("0", "percent").error, /must take something off/);
  assert.equal(PF.checkCouponValue("100", "percent").value, 100);
  assert.equal(PF.checkCouponValue("100.01", "percent").error, "A % coupon can be at most 100% off.");
  assert.equal(PF.checkCouponValue("150", "percent").error, "A % coupon can be at most 100% off.");
  assert.equal(PF.checkCouponValue("7.5", "percent").value, 7.5);
  assert.match(PF.checkCouponValue("7.555", "percent").error, /2 decimal places/);
  assert.match(PF.checkCouponValue("-5", "percent").error, /Negative/);
  assert.match(PF.checkCouponValue("abc", "percent").error, /Enter a number/);
});
t("flat coupon: required, more than 0, paise allowed, capped at Rs 1 crore", () => {
  assert.equal(PF.checkCouponValue("", "flat").error, "Enter the amount off, like ₹500.");
  assert.equal(PF.checkCouponValue("", "flat", { symbol: "AED " }).error, "Enter the amount off, like AED 500.");
  assert.match(PF.checkCouponValue("0", "flat").error, /must take something off/);
  assert.equal(PF.checkCouponValue("150", "flat").value, 150, "150 is fine as an amount (not as a %)");
  assert.equal(PF.checkCouponValue("499.99", "flat").value, 499.99);
  assert.match(PF.checkCouponValue("10000001", "flat").error, /at most ₹1,00,00,000/);
  assert.match(PF.checkCouponValue("", "flat", {}, { rejected: "negative" }).error, /Negative amounts/);
});
t("unknown coupon kind is refused", () => {
  assert.match(PF.checkCouponValue("10", "bogo").error, /Pick % off or ₹ off/);
});
t("100% off asks first; other values do not", () => {
  assert.equal(PF.couponConfirm("percent", 100).title, "100% off?");
  assert.equal(PF.couponConfirm("percent", 99.99), null);
  assert.equal(PF.couponConfirm("flat", 100), null);
});
t("validateCoupon reports code and value separately and returns the clean coupon", () => {
  const bad = PF.validateCoupon({ code: "", kind: "percent", value: "" }, ex);
  assert.equal(bad.ok, false); assert.ok(bad.errors.code); assert.ok(bad.errors.value); assert.equal(bad.value, null);
  const onlyVal = PF.validateCoupon({ code: "NEWYEAR", kind: "percent", value: "120" }, ex);
  assert.deepEqual(Object.keys(onlyVal.errors), ["value"]);
  assert.deepEqual(PF.validateCoupon({ code: " newyear ", kind: "flat", value: "250.5" }, ex).value, { code: "NEWYEAR", kind: "flat", value: 250.5 });
});

// ---------------- control.html wiring ----------------
const html = read("public/control.html");
t("the misleading 'both chair and plate' message is gone", () => {
  assert.doesNotMatch(html, /Enter a price for both chair and plate/);
});
t("control.html loads the shared rules and validates per field, inline", () => {
  assert.match(html, /<script src="pricing-form-core\.js\?v=\d+"><\/script>/);
  assert.match(html, /const PF=window\.HelmPricingForm;/);
  assert.match(html, /PF\.validatePricing\(raws,ctx,flags\)/);
  assert.match(html, /e\.id=inp\.id\+"_err"; e\.className="pf-err hbp-skip"; e\.setAttribute\("role","alert"\)/, "message element under each field");
  assert.match(html, /inp\.setAttribute\("aria-invalid",msg\?"true":"false"\)/);
  assert.match(html, /b\.disabled=!pricingLoaded\|\|pricingInvalid;/, "Save is off while a field is wrong");
  assert.match(html, /PF\.zeroConfirm\(PF\.newlyZero\(v\.values,pricingCfg\),ctx\)/, "a price changed to 0 is confirmed");
  assert.match(html, /pfFill\(nextCfg\);/, "the boxes show what was stored after a save");
});
t("pricing save messages stay in the pricing card (no top banner)", () => {
  const s = html.indexOf('$("#savePricing").addEventListener'), e = html.indexOf('$("#saveCaps").addEventListener');
  assert.ok(s > 0 && e > s); const body = html.slice(s, e);
  assert.doesNotMatch(body, /setMsg\(/); assert.match(body, /pfStatus\("ok","Pricing saved/); assert.match(body, /pfStatus\("err",errMsg\(e,"save pricing"\)\)/);
});
t("money inputs accept paise (step 0.01): a pasted 199.50 is no longer turned into 19950 by the integer hardener", () => {
  for (const id of ["p_chair", "p_plate", "p_layout", "co_val"]) assert.match(html, new RegExp('<input id="' + id + '" type="number" min="0" step="0\\.01"'), id);
  assert.match(html, /<input id="co_code"[^>]*maxlength="20"/);
});
t("coupons: inline messages, twin / removed codes explained, Enter adds", () => {
  assert.match(html, /PF\.validateCoupon\(/);
  assert.match(html, /e\.id="co_err"; e\.className="pf-err co-err hbp-skip"/);
  assert.match(html, /e\.code==="23505"/);
  assert.match(html, /by a coupon that was removed/);
  assert.match(html, /e\.key==="Enter"/);
  const s = html.indexOf('$("#co_add").addEventListener'), e = html.indexOf("async function renderChairs");
  assert.doesNotMatch(html.slice(s, e), /setMsg\(/, "coupon messages are in the coupon card");
});
t("Item prices save no longer saves the Default pricing box's unsaved chair price (or turns ₹0 into 200)", () => {
  const s = html.indexOf('$("#saveItemPrices").addEventListener'), e = html.indexOf("async function renderLayoutRules");
  const body = html.slice(s, e);
  assert.doesNotMatch(body, /\$\("#p_chair"\)/);
  assert.match(body, /const nextCfg=Object\.assign\(\{\},pricingCfg,\{assetPrices:ap\}\);/);
  assert.match(body, /pricingCfg=nextCfg;/);
});
t("Capacity limits save works on a copy (a failed save leaves memory as the server has it)", () => {
  const s = html.indexOf('$("#saveCaps").addEventListener'), e = html.indexOf('$("#saveItemPrices").addEventListener');
  const body = html.slice(s, e);
  assert.doesNotMatch(body, /Object\.assign\(pricingCfg,patch\)/);
  assert.match(body, /const nextCfg=Object\.assign\(\{\},pricingCfg,patch\);/);
});
t("alignment CSS: tax tick on its own row, equal label slots, item boxes aligned", () => {
  const css = read("public/control-polish.css");
  assert.match(css, /#pricingCard \.grid>\.fld:has\(#p_taxIncl\)\{grid-column:1\/-1;order:20\}/);
  assert.match(css, /#pricingCard \.grid>\.fld>label:not\(\.mpchk\)\{display:flex;align-items:flex-end;min-height:2\.7em/);
  assert.match(css, /#itemPriceList\.grid,#app \.card \.grid:has\(#cap_guests\)\{align-items:end\}/);
  assert.match(css, /\.pf-err/);
  assert.match(html, /control-polish\.css\?v=(\d+)/); assert.ok(+html.match(/control-polish\.css\?v=(\d+)/)[1] >= 3, "control-polish.css pin bumped");
});

console.log("cc-pricing-validation: ok (" + n + " checks)");
