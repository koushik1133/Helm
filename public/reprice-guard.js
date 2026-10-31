/* reprice-guard.js - R112: saving a floor layout must never silently change a sent / approved quote's price.
   Pure helpers (no DOM, no network) used by the builder before it writes a re-priced total to the quote:
     committed(q)            the quote was sent to / approved by the client (or confirmed / waiting for re-approval)
     platesFor(client, pr)   the plates the QUOTE is priced with (pricing.guests) - the client head count is only the
                             fallback for a quote that never stored one (it was the other way round: 200 -> 150)
     diff(oldPr, newPr)      { guestsFrom, guestsTo, totalFrom, totalTo, guestsChanged, totalChanged, changed }
     message(d, money)       "Layout changes the quote: guests 200 -> 150, total Rs X -> Rs Y."
   The server is still the pricing authority: the total shown is the one the shared engine computes, and any price
   change of a committed quote also keeps a new quotation version on the server (0321). */
(function (global) {
  "use strict";
  function num(v) { if (v == null || v === "") return null; var n = Number(v); return isFinite(n) ? n : null; }
  function committed(q) {
    if (!q) return false;
    var a = String(q.approvalStatus || q.approval_status || "").toLowerCase();
    return a === "sent" || a === "viewed" || a === "approved" || a === "paid"
      || String(q.status || "").toLowerCase() === "confirmed" || !!(q.consentStale || q.consent_stale);
  }
  function platesFor(client, pricing) {
    var p = num(pricing && pricing.guests);
    if (p != null) return p;
    var c = num(client && client.guests);
    return c;
  }
  function diff(oldPr, newPr) {
    oldPr = oldPr || {}; newPr = newPr || {};
    var gf = num(oldPr.guests), gt = num(newPr.guests), tf = num(oldPr.total), tt = num(newPr.total);
    var guestsChanged = gf != null && gt != null && gf !== gt;
    var totalChanged = tt != null && (tf == null ? tt > 0 : Math.abs(tt - tf) > 0.5);
    return { guestsFrom: gf, guestsTo: gt, totalFrom: tf, totalTo: tt, guestsChanged: guestsChanged, totalChanged: totalChanged,
             changed: guestsChanged || totalChanged };
  }
  function message(d, money) {
    var m = typeof money === "function" ? money : function (n) { return String(Math.round(n || 0)); };
    var bits = [];
    if (d && d.guestsChanged) bits.push("guests " + d.guestsFrom + " → " + d.guestsTo);
    if (d && d.totalChanged) bits.push("total " + (d.totalFrom == null ? "not priced" : m(d.totalFrom)) + " → " + m(d.totalTo));
    return bits.length ? "Layout changes the quote: " + bits.join(", ") + "." : "";
  }
  var api = { committed: committed, platesFor: platesFor, diff: diff, message: message };
  global.HelmRepriceGuard = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
