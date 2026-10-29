/* pricing-form-core.js - pure rules for Settings > Pricing & coupons.
 * Default pricing (chair / plate price, tax rates, service charge, layout fee, venue gap)
 * and coupons. No DOM, no network: control.html shows each message under its own field,
 * and the node tests run every edge case against these same functions.
 *
 * Rules (owner, Oct 2026):
 *   - a required field left empty is an error at THAT field ("Enter a price per chair (Rs 0 or more)"),
 *     never one message about both chair and plate;
 *   - 0 is allowed for chair / plate, but changing a price TO 0 asks "Chairs free?" first;
 *   - negative, not-a-number, more than 2 decimal places and out-of-range values are refused;
 *   - GST 0-28 %, service charge 0-25 % (r59: same limit as the server, 0300), venue booking gap 0-48 hours;
 *   - coupons: code 3-20 letters / numbers / - / _, % off 0.01-100, flat off more than 0. */
(function (global) {
  "use strict";
  var MONEY_MAX = 10000000;      // Rs 1,00,00,000 per chair / per plate / flat coupon
  var FEE_MAX = 100000000;       // Rs 10,00,00,000 layout & setup fee
  var GST_MAX = 28, SVC_MAX = 25, HOURS_MAX = 48;
  var CODE_MIN = 3, CODE_MAX = 20;

  function fmt(n, symbol) {
    var s = String(symbol == null ? "₹" : symbol);
    var loc = s.trim() === "₹" ? "en-IN" : "en-US";
    var t; try { t = Number(n).toLocaleString(loc, { maximumFractionDigits: 2 }); } catch (e) { t = String(n); }
    return s + t;
  }

  // The fields of the Default pricing card. kind: money | pct | hours.
  // required:true -> empty is an error; otherwise empty means `blank`.
  function fields(ctx) {
    ctx = ctx || {};
    var sym = ctx.symbol == null ? "₹" : ctx.symbol, tax = ctx.taxName || "GST";
    return {
      chairPrice:          { id: "p_chair",  kind: "money", required: true, max: MONEY_MAX, label: "Price / chair",
                             empty: "Enter a price per chair (" + fmt(0, sym) + " or more).", zero: "chairs", unit: "per chair" },
      platePrice:          { id: "p_plate",  kind: "money", required: true, max: MONEY_MAX, label: "Price / plate",
                             empty: "Enter a price per plate (" + fmt(0, sym) + " or more).", zero: "plates", unit: "per plate" },
      gstPct:              { id: "p_gst",    kind: "pct", required: true, max: GST_MAX, label: tax + " %",
                             empty: "Enter the " + tax + " rate (0 to " + GST_MAX + "%). 0 is allowed." },
      // outside India one rate applies: an empty catering box just follows the main rate (blank: null)
      cateringGstPct:      { id: "p_cgst",   kind: "pct", required: ctx.split !== false, blank: null, max: GST_MAX, label: "Catering " + tax + " %",
                             empty: "Enter the catering " + tax + " rate (0 to " + GST_MAX + "%). 0 is allowed." },
      serviceChargePct:    { id: "p_svc",    kind: "pct", required: false, blank: 0, max: SVC_MAX, label: "Service charge %" },
      layoutBase:          { id: "p_layout", kind: "money", required: false, blank: 0, max: FEE_MAX, label: "Layout & setup fee" },
      conflictBufferHours: { id: "p_buffer", kind: "hours", required: false, blank: 3, max: HOURS_MAX, label: "Venue booking gap" }
    };
  }

  // One value. raw is the input's text; flags.badInput = the browser holds text it can't read as a number;
  // flags.rejected = the shared number hardener just cleared a pasted negative.
  // -> { ok, value } | { ok:false, error }
  function checkNumber(raw, spec, ctx, flags) {
    ctx = ctx || {}; flags = flags || {};
    var sym = ctx.symbol == null ? "₹" : ctx.symbol;
    var s = raw == null ? "" : String(raw).trim();
    var money = spec.kind === "money", eg = money ? "250" : spec.kind === "hours" ? "3" : "18";
    if (s === "") {
      if (flags.rejected === "negative") return { ok: false, error: money ? "Negative amounts aren’t allowed. Enter " + fmt(0, sym) + " or more." : "Negative numbers aren’t allowed. Enter 0 or more." };
      if (flags.badInput) return { ok: false, error: "Enter a number, like " + eg + "." };
      if (spec.required) return { ok: false, error: spec.empty || ("Enter " + spec.label + ".") };
      return { ok: true, value: spec.blank, blank: true };
    }
    if (/^-/.test(s)) return { ok: false, error: money ? "Negative amounts aren’t allowed. Enter " + fmt(0, sym) + " or more." : "Negative numbers aren’t allowed. Enter 0 or more." };
    if (!/^\+?(\d+(\.\d*)?|\.\d+)$/.test(s)) return { ok: false, error: "Enter a number, like " + eg + "." };
    var dec = s.indexOf(".") >= 0 ? s.split(".")[1].length : 0;
    // "paise" only for rupees: an AED / USD studio reads "e.g. 199.50" without the Indian sub-unit name
    if (dec > 2) return { ok: false, error: "Use at most 2 decimal places" + (money ? (String(sym).trim() === "₹" ? " (paise)" : "") + ", e.g. 199.50." : ", e.g. " + (spec.kind === "hours" ? "2.5." : "2.75.")) };
    var n = Number(s);
    if (!isFinite(n)) return { ok: false, error: "Enter a number, like " + eg + "." };
    if (n > spec.max) {
      if (money) return { ok: false, error: spec.label + " can be at most " + fmt(spec.max, sym) + "." };
      if (spec.kind === "hours") return { ok: false, error: "The booking gap can be 0 to " + spec.max + " hours." };
      return { ok: false, error: spec.label.replace(/ %$/, "") + " can be 0 to " + spec.max + "%." };
    }
    return { ok: true, value: Math.round(n * 100) / 100 };
  }

  function checkField(key, raw, ctx, flags) {
    var spec = fields(ctx)[key]; if (!spec) throw new Error("unknown pricing field " + key);
    return checkNumber(raw, spec, ctx, flags);
  }

  // raws: { chairPrice:"200", ... }, flags: { chairPrice:{badInput,rejected} }
  // -> { ok, values:{...}, errors:{key:msg}, first:key|null }
  function validatePricing(raws, ctx, flags) {
    raws = raws || {}; flags = flags || {};
    var F = fields(ctx), values = {}, errors = {}, first = null;
    Object.keys(F).forEach(function (k) {
      var r = checkNumber(raws[k], F[k], ctx, flags[k]);
      if (r.ok) values[k] = r.value; else { errors[k] = r.error; if (!first) first = k; }
    });
    return { ok: !first, values: values, errors: errors, first: first };
  }

  // Which priced items were CHANGED to 0 in this save (a price that was already 0 is not asked about again).
  // -> [] | ["chairs"] | ["chairs","plates"]
  function newlyZero(values, saved) {
    saved = saved || {};
    var out = [];
    [["chairPrice", "chairs"], ["platePrice", "plates"]].forEach(function (p) {
      var was = saved[p[0]];
      var wasZero = was != null && String(was).trim() !== "" && Number(was) === 0;
      if (values && values[p[0]] === 0 && !wasZero) out.push(p[1]);
    });
    return out;
  }
  // the confirm text for newlyZero(); null when nothing to ask
  function zeroConfirm(list, ctx) {
    if (!list || !list.length) return null;
    var both = list.length > 1, what = both ? "Chairs and plates" : (list[0] === "chairs" ? "Chairs" : "Plates");
    var unit = both ? "" : (list[0] === "chairs" ? " per chair" : " per plate");
    return {
      title: what + " free?",
      // no currency amount in the text: the privacy "hide amounts" mode would blank it out
      text: what + " will cost nothing (price" + unit + " = 0) on new quotes, so they add nothing to the total. Saved and sent quotes keep their prices. Is that what you want?",
      okLabel: both ? "Yes, make them free" : "Yes, make " + (list[0] === "chairs" ? "chairs" : "plates") + " free"
    };
  }

  // ---- coupons ----
  function normCode(raw) { return String(raw == null ? "" : raw).trim().toUpperCase(); }
  // existing: codes of the studio's active coupons (any case)
  function checkCouponCode(raw, existing) {
    var c = normCode(raw);
    if (!c) return { ok: false, error: "Enter a coupon code, like DIWALI10." };
    if (/\s/.test(c)) return { ok: false, error: "No spaces in a code. Use letters, numbers, - or _ (e.g. NEW-YEAR)." };
    if (!/^[A-Z0-9_-]+$/.test(c)) return { ok: false, error: "Use only letters, numbers, - or _ in a code." };
    if (!/^[A-Z0-9]/.test(c)) return { ok: false, error: "Start the code with a letter or number." };
    if (c.length < CODE_MIN || c.length > CODE_MAX) return { ok: false, error: "A code is " + CODE_MIN + " to " + CODE_MAX + " characters long." };
    var dup = (existing || []).some(function (x) { return normCode(x) === c; });
    if (dup) return { ok: false, error: c + " already exists. Pick another code, or remove the old one first." };
    return { ok: true, value: c };
  }
  // kind: "percent" | "flat"
  function checkCouponValue(raw, kind, ctx, flags) {
    ctx = ctx || {}; flags = flags || {};
    var sym = ctx.symbol == null ? "₹" : ctx.symbol;
    var pct = kind === "percent";
    var s = raw == null ? "" : String(raw).trim();
    if (kind !== "percent" && kind !== "flat") return { ok: false, error: "Pick % off or " + String(sym).trim() + " off." };
    if (s === "" && !flags.badInput && flags.rejected !== "negative") return { ok: false, error: pct ? "Enter the % off (more than 0, up to 100)." : "Enter the amount off, like " + fmt(500, sym) + "." };
    var r = checkNumber(s, { kind: pct ? "pct" : "money", required: true, max: pct ? 100 : MONEY_MAX, label: pct ? "Discount %" : "Amount off", empty: "" }, ctx, flags);
    if (!r.ok) {
      if (pct && /can be 0 to/.test(r.error)) return { ok: false, error: "A % coupon can be at most 100% off." };
      return r;
    }
    if (r.value <= 0) return { ok: false, error: "A coupon must take something off. Enter more than 0." };
    return r;
  }
  // a coupon that makes a whole quote free asks first; -> confirm spec or null
  function couponConfirm(kind, value) {
    if (kind === "percent" && Number(value) >= 100) return { title: "100% off?", text: "This coupon makes the whole quote free. Add it anyway?", okLabel: "Add coupon" };
    return null;
  }
  function validateCoupon(input, existing, ctx, flags) {
    input = input || {}; flags = flags || {};
    var errors = {}, c = checkCouponCode(input.code, existing), v = checkCouponValue(input.value, input.kind, ctx, flags.value);
    if (!c.ok) errors.code = c.error;
    if (!v.ok) errors.value = v.error;
    return { ok: c.ok && v.ok, errors: errors, value: c.ok && v.ok ? { code: c.value, kind: input.kind, value: v.value } : null };
  }

  var api = {
    LIMITS: { MONEY_MAX: MONEY_MAX, FEE_MAX: FEE_MAX, GST_MAX: GST_MAX, SVC_MAX: SVC_MAX, HOURS_MAX: HOURS_MAX, CODE_MIN: CODE_MIN, CODE_MAX: CODE_MAX },
    fields: fields, checkField: checkField, validatePricing: validatePricing, newlyZero: newlyZero, zeroConfirm: zeroConfirm,
    normCode: normCode, checkCouponCode: checkCouponCode, checkCouponValue: checkCouponValue, couponConfirm: couponConfirm, validateCoupon: validateCoupon,
    fmt: fmt
  };
  global.HelmPricingForm = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
