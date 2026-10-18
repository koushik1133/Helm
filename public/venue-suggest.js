/* venue-suggest.js - the studio's saved venues as a dropdown on a free-text venue field.
 * A native <datalist>: pick a saved venue from the list, or keep typing any venue by hand.
 * Picking a saved venue also fills an empty address field and tells the page which venue
 * was picked, so it can link it (client.venueId / venueName - same keys as venue-picker.js, 0085).
 * Builds DOM nodes only (no HTML strings). Needs store-api.js (BPStore.venues.list). */
(function () {
  "use strict";
  if (window.HelmVenueSuggest) return;
  function name(v) { return String((v && v.name) || "").trim(); }
  function addressOf(v) { return [v && v.address, v && v.city].filter(function (x) { return x && String(x).trim(); }).join(", "); }
  function attach(input, opts) {
    opts = opts || {};
    if (!input || !input.parentNode) return null;
    if (input.__helmVenueSuggest) return input.__helmVenueSuggest;
    var dl = document.createElement("datalist");
    dl.id = (input.id || "venue") + "_venues";
    input.setAttribute("list", dl.id);
    input.setAttribute("autocomplete", "off");
    input.parentNode.appendChild(dl);
    var list = [];
    // the saved venue whose name is exactly what is in the field (case-insensitive), else null
    function match() {
      var t = String(input.value || "").trim().toLowerCase();
      if (!t) return null;
      for (var i = 0; i < list.length; i++) if (name(list[i]).toLowerCase() === t) return list[i];
      return null;
    }
    function picked() {
      var v = match();
      var a = opts.address;
      if (v && a && !String(a.value || "").trim()) {
        var addr = addressOf(v);
        if (addr) { a.value = addr; a.dispatchEvent(new Event("input", { bubbles: true })); }
      }
      if (typeof opts.onPick === "function") { try { opts.onPick(v); } catch (e) {} }
    }
    input.addEventListener("change", picked);
    var tries = 0;
    function load() {
      var S = window.BPStore;
      if (!S || !S.venues || !S.auth || !S.auth.user || !S.auth.user()) { if (tries++ < 40) setTimeout(load, 500); return; }
      S.venues.list().then(function (rows) {
        list = (rows || []).filter(function (v) { return name(v); });
        while (dl.firstChild) dl.removeChild(dl.firstChild);
        var seen = {};
        list.forEach(function (v) {
          var n = name(v), k = n.toLowerCase();
          if (seen[k]) return; seen[k] = true;
          var o = document.createElement("option"); o.value = n;
          if (v.city) o.label = n + " - " + v.city;
          dl.appendChild(o);
        });
        if (list.length) input.setAttribute("placeholder", opts.placeholder || "Pick a saved venue or type one");
      }).catch(function () { /* no venues area / not migrated: the field stays plain free text */ });
    }
    load();
    var api = { match: match, venues: function () { return list.slice(); }, reload: function () { tries = 0; load(); } };
    input.__helmVenueSuggest = api;
    return api;
  }
  window.HelmVenueSuggest = { attach: attach };
})();
