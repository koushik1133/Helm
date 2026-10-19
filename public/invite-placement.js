/* invite-placement.js — R23: where each invitation photo shows (shared by the Invitation Studio and the
 * public invitation page, so the live preview and the published site place photos identically).
 *
 * Stored in the site's data JSON (no schema change):
 *   data.photos       [ref, ...]                       (unchanged: storage references / https links)
 *   data.photoPlaces  [place, ...]  parallel to photos  "cover" | "background" | "names" | "gallery"
 *                                                      | "after:details" | "after:schedule" | "after:rsvp"
 *   data.bgDim  0..85 (% the full-background photo is faded into the theme colour), data.bgBlur 0..12 (px)
 * Old sites have no photoPlaces: photo 1 = cover, the rest = gallery (exactly the pre-R23 layout).
 * Cover, Full background and Behind names hold ONE photo each (the first one marked wins; later ones fall
 * back to the gallery). Unknown values fall back too, so a stored value can never break the page. */
(function (global) {
  "use strict";
  var SINGLE = ["cover", "background", "names"];
  var SECTIONS = [
    { key: "details", label: "Details (when & where)" },
    { key: "schedule", label: "Schedule" },
    { key: "rsvp", label: "RSVP" }
  ];
  var OPTIONS = [
    { key: "cover", label: "Cover", hint: "Big photo across the top, names on it" },
    { key: "background", label: "Full background", hint: "Behind the whole invitation, softly faded" },
    { key: "names", label: "Behind names", hint: "Framed behind the names, below the cover" },
    { key: "gallery", label: "Gallery", hint: "In the photo gallery" },
    { key: "inline", label: "After a section", hint: "Between sections - pick which one" }
  ];
  var DIM_DEFAULT = 55, BLUR_DEFAULT = 3;
  function valid(p) {
    if (typeof p !== "string") return false;
    if (SINGLE.indexOf(p) >= 0 || p === "gallery") return true;
    var m = /^after:([a-z]+)$/.exec(p); return !!m && SECTIONS.some(function (s) { return s.key === m[1]; });
  }
  // normalize(count, places) -> one valid place per photo, singles kept unique, old sites = cover + gallery
  function normalize(count, places) {
    var n = Math.max(0, Math.min(60, count | 0)), src = Array.isArray(places) ? places : null, out = [], taken = {};
    for (var i = 0; i < n; i++) {
      var p = src ? src[i] : (i === 0 ? "cover" : "gallery");
      if (!valid(p)) p = (!src && i === 0) ? "cover" : "gallery";
      if (SINGLE.indexOf(p) >= 0) { if (taken[p]) p = "gallery"; else taken[p] = true; }
      out.push(p);
    }
    return out;
  }
  function clamp(v, lo, hi, d) { var x = Number(v); if (!isFinite(x)) return d; return Math.max(lo, Math.min(hi, Math.round(x))); }
  // group photos (already-filtered display URLs, same order as places) by where they go
  function layout(urls, places) {
    var L = { cover: "", background: "", names: "", gallery: [], after: { details: [], schedule: [], rsvp: [] } };
    (urls || []).forEach(function (u, i) {
      var p = places[i] || "gallery";
      if (SINGLE.indexOf(p) >= 0) { if (!L[p]) L[p] = u; else L.gallery.push(u); }
      else if (p.indexOf("after:") === 0) { var k = p.slice(6); (L.after[k] || L.gallery).push(u); }
      else L.gallery.push(u);
    });
    return L;
  }
  global.HelmInvitePlace = Object.freeze({
    OPTIONS: OPTIONS, SECTIONS: SECTIONS, SINGLE: SINGLE, DIM_DEFAULT: DIM_DEFAULT, BLUR_DEFAULT: BLUR_DEFAULT,
    valid: valid, normalize: normalize, layout: layout,
    dim: function (v) { return clamp(v, 0, 85, DIM_DEFAULT); },
    blur: function (v) { return clamp(v, 0, 12, BLUR_DEFAULT); }
  });
})(typeof window !== "undefined" ? window : globalThis);
