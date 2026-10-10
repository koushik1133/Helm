/* venue-area.js (0096) - venue length x breadth vs the USABLE area actually laid out.
 * The venue's full size (from Control Center -> Venues) is kept for reference on the quote's
 * client JSON as venueLen / venueWid (ft). The hall fields #g_len / #g_wid stay the usable
 * area = client.hallLen / hallWid, which is what the builder WORLD and the layout wizard use.
 *   calc({ venueLen, venueWid, len, wid, cap })  -> { errors, warnings, label, full }
 * Flow page: shows "Venue size 262×164 ft · Using 180×120 ft" + "Reset to full venue".
 * Validation: positive, <= hall cap (errors); usable larger than the venue = warning only. */
(function (G) {
  "use strict";
  function pos(v) { if (v === null || v === undefined || String(v).trim() === "") return null; var n = +v; return isFinite(n) ? n : NaN; }
  function fmt(n) { return String(Math.round(n * 10) / 10); }
  function calc(o) {
    o = o || {};
    var cap = pos(o.cap) > 0 ? pos(o.cap) : 1000;
    var vl = pos(o.venueLen), vw = pos(o.venueWid), l = pos(o.len), w = pos(o.wid);
    var hasVenue = vl > 0 && vw > 0;
    var errors = [], warnings = [];
    [["len", l, "Hall length"], ["wid", w, "Hall breadth"]].forEach(function (x) {
      if (x[1] === null) return;
      if (isNaN(x[1]) || x[1] <= 0) errors.push({ field: x[0], msg: x[2] + " must be more than 0." });
      else if (x[1] > cap) errors.push({ field: x[0], msg: x[2] + " can be at most " + cap + " ft." });
    });
    if (hasVenue && l > 0 && w > 0 && (l > vl + 0.05 || w > vw + 0.05))
      warnings.push({ code: "over_venue", msg: "The area used (" + fmt(l) + "×" + fmt(w) + " ft) is larger than the venue (" + fmt(vl) + "×" + fmt(vw) + " ft) - check the numbers." });
    var full = hasVenue && l > 0 && w > 0 && Math.abs(l - vl) < 0.05 && Math.abs(w - vw) < 0.05;
    var label = "";
    if (hasVenue) label = "Venue size " + fmt(vl) + "×" + fmt(vw) + " ft · " + (l > 0 && w > 0 ? (full ? "Using the full venue" : "Using " + fmt(l) + "×" + fmt(w) + " ft") : "enter the area you will use");
    return { errors: errors, warnings: warnings, label: label, full: full, hasVenue: hasVenue };
  }
  var API = { calc: calc };
  G.HelmVenueArea = API;
  if (typeof module !== "undefined" && module.exports) module.exports = API;

  /* ---------------- flow page ---------------- */
  var doc = G.document; if (!doc) return;
  function mount() {
    var gl = doc.getElementById("g_len"), gw = doc.getElementById("g_wid"), vl = doc.getElementById("v_vlen"), vw = doc.getElementById("v_vwid");
    if (!gl || !gw || !vl || !vw) return;
    var row = gl.closest(".row4") || gl.parentNode;
    var lab = doc.createElement("span"); lab.id = "g_area_lbl";
    var reset = doc.createElement("button"); reset.type = "button"; reset.className = "btn sm"; reset.id = "g_area_reset"; reset.textContent = "Reset to full venue"; reset.hidden = true;
    var warn = doc.createElement("p"); warn.id = "g_area_warn"; warn.className = "g-area-warn"; warn.setAttribute("role", "alert"); warn.hidden = true;
    var box = doc.createElement("div"); box.id = "g_area"; box.className = "g-area"; box.setAttribute("aria-live", "polite"); box.hidden = true;
    box.append(lab, doc.createTextNode(" "), reset, warn);
    row.parentNode.insertBefore(box, row.nextSibling);
    function set(el, v) { el.value = v == null ? "" : String(v); el.dispatchEvent(new Event("input", { bubbles: true })); }
    function refresh() {
      var r = calc({ venueLen: vl.value, venueWid: vw.value, len: gl.value, wid: gw.value });
      lab.textContent = r.label; box.hidden = !r.hasVenue && !r.errors.length;
      reset.hidden = !r.hasVenue || r.full;
      var msgs = r.errors.map(function (e) { return e.msg; }).concat(r.warnings.map(function (x) { return "⚠ " + x.msg; }));
      warn.textContent = msgs.join(" "); warn.hidden = !msgs.length;
      gl.setAttribute("aria-invalid", String(r.errors.some(function (e) { return e.field === "len"; })));
      gw.setAttribute("aria-invalid", String(r.errors.some(function (e) { return e.field === "wid"; })));
      [gl, gw].forEach(function (el) { el.title = r.hasVenue ? "Usable area: the part of the venue you will lay out (the venue itself is " + vl.value + "×" + vw.value + " ft)" : ""; });
    }
    reset.addEventListener("click", function () { set(gl, vl.value); set(gw, vw.value); refresh(); });
    [gl, gw, vl, vw].forEach(function (el) { el.addEventListener("input", refresh); el.addEventListener("change", refresh); });
    API.refresh = refresh;
    refresh();
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mount); else mount();
})(typeof window !== "undefined" ? window : globalThis);
