/* flow-layout-sync.js — keeps the quote flow's quotation in step with the floor layout.
   Pure helpers (no DOM) so they can be unit-tested in node:
   - reconcile(): given the quote's saved pricing and the layout's counts, work out the
     chairs / "Décor / setup" (other) values the quotation should now show. Mirrors the
     builder's syncQuotePricing rules: chairs always follow the layout; `other` follows the
     layout's objects cost UNLESS it was hand-edited (other !== the last auto value).
   - flag helpers: a one-shot per-quote marker set when the flow opens the builder, so the
     return trip (Save & back, browser Back, bfcache) re-prices exactly once. */
(function (global) {
  "use strict";
  var num = function (v) { var n = +v; return isFinite(n) && n >= 0 ? n : 0; };
  function reconcile(pricing, layout) {
    var pr = pricing || {}, lo = layout || {};
    var chairs = Math.round(num(lo.chairs));
    var auto = num(lo.objectsCost) + num(lo.layoutBase);
    var prevAuto = pr.otherAuto != null ? +pr.otherAuto : null;
    // no record of the last auto value → treat an existing `other` as hand-set (never clobber it)
    var hand = pr.other != null && (prevAuto == null || +pr.other !== prevAuto);
    var other = hand ? num(pr.other) : auto;
    // R8: chairs typed by hand (pricing.chairsManual) are kept until the user resets them to 70%
    if (pr.chairsManual && pr.chairs != null) chairs = Math.round(num(pr.chairs));
    var chairsChanged = pr.chairs == null ? chairs > 0 : +pr.chairs !== chairs;
    var otherChanged = pr.other == null ? other > 0 : +pr.other !== other;
    return { chairs: chairs, other: other, otherAuto: auto, otherHand: hand,
      chairsChanged: chairsChanged, otherChanged: otherChanged, changed: chairsChanged || otherChanged };
  }
  var KEY = "helm_flow_builder:";
  function mark(store, quoteId) { try { store.setItem(KEY + quoteId, String(Date.now())); } catch (e) {} }
  // returns true once (then clears) if the builder was opened from this flow quote
  function consume(store, quoteId) {
    try { var v = store.getItem(KEY + quoteId); if (v == null) return false; store.removeItem(KEY + quoteId); return true; }
    catch (e) { return false; }
  }
  // where "Save & back to quote" goes (builder.html has <base href="/">, so this is site-root relative)
  function returnUrl(quoteId) { return "flow.html?quote=" + encodeURIComponent(String(quoteId || "")) + "&from=builder#sec-quote"; }
  var api = { reconcile: reconcile, mark: mark, consume: consume, returnUrl: returnUrl, KEY: KEY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.HelmFlowLayout = api;
})(typeof window !== "undefined" ? window : globalThis);
