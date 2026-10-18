/* flow-layout-sync.js — keeps the quote flow's quotation in step with the floor layout.
   Pure helpers (no DOM) so they can be unit-tested in node:
   - reconcile(): given the quote's saved pricing and the layout's counts, work out the
     chairs / "Décor / setup" (other) values the quotation should now show. Mirrors the
     builder's syncQuotePricing rules: R8b — chairs NEVER follow the layout (the quote's one chairs
     value is the pricing source; a differing layout count only raises chairsMismatch for a note); `other` follows the
     layout's objects cost UNLESS it was hand-edited (other !== the last auto value).
   - flag helpers: a one-shot per-quote marker set when the flow opens the builder, so the
     return trip (Save & back, browser Back, bfcache) re-prices exactly once. */
(function (global) {
  "use strict";
  var num = function (v) { var n = +v; return isFinite(n) && n >= 0 ? n : 0; };
  function reconcile(pricing, layout, client) {
    var pr = pricing || {}, lo = layout || {};
    var layoutChairs = Math.round(num(lo.chairs));
    var S = global.HelmSizing, chairs;
    // R9: the quote's ONE chairs value (same rule as the flow seed + builder panel) — a stale saved
    // pricing.chairs no longer wins over a newer client-side edit/reset made in the builder
    if (S && S.quoteChairs) chairs = S.quoteChairs(client, pr, pr.chairs != null ? pr.chairs : layoutChairs) || 0;
    else if (pr.chairs != null && isFinite(+pr.chairs)) chairs = Math.round(num(pr.chairs));
    else chairs = layoutChairs;
    var auto = num(lo.objectsCost) + num(lo.layoutBase);
    var prevAuto = pr.otherAuto != null ? +pr.otherAuto : null;
    // no record of the last auto value → treat an existing `other` as hand-set (never clobber it)
    var hand = pr.other != null && (prevAuto == null || +pr.other !== prevAuto);
    var other = hand ? num(pr.other) : auto;
    var chairsChanged = pr.chairs == null ? chairs > 0 : +pr.chairs !== chairs;
    var otherChanged = pr.other == null ? other > 0 : +pr.other !== other;
    return { chairs: chairs, layoutChairs: layoutChairs, chairsMismatch: layoutChairs > 0 && layoutChairs !== chairs, other: other, otherAuto: auto, otherHand: hand,
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
  // r19 L2: "Save & back to quote" must write a version whenever the canvas differs from the version stored
  // on the server - not only when the edit tracker says "dirty" (a default layout generated on arrival was
  // marked "Saved" and thrown away). A layout is compared by object count + a hash of its content signature.
  function hash(str) { var s = String(str == null ? "" : str), h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return ("0000000" + h.toString(16)).slice(-8) + ":" + s.length; }
  function layoutKey(count, sig) { var n = Math.round(+count); return { count: isFinite(n) && n > 0 ? n : 0, hash: hash(sig) }; }
  // stored = layoutKey of the version on the server (null = not known / never written); current = the canvas.
  // Unknown stored copy: save a canvas with objects (versions are append-only, nothing is overwritten) or one the
  // person changed; never write an untouched empty canvas.
  function needsVersion(stored, current, dirty) {
    if (!current) return false;
    if (!stored) return !!dirty || current.count > 0;
    return !!dirty || stored.count !== current.count || stored.hash !== current.hash;
  }
  var api = { reconcile: reconcile, mark: mark, consume: consume, returnUrl: returnUrl, KEY: KEY, hash: hash, layoutKey: layoutKey, needsVersion: needsVersion };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.HelmFlowLayout = api;
})(typeof window !== "undefined" ? window : globalThis);
