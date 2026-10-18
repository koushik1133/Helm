/* asset-price-grid.js — Control Center "Object & item prices (layout builder)" grid.
   The per-unit price of every object placed on the floor plan (pricingCfg.assetPrices).

   Layout (Oct 2026 fix): the old 3-column grid put "(default ₹1,500)" inside each label, so a long
   name wrapped to two lines and pushed its input below its neighbours, and the privacy mask pill made
   the labels uneven. Now every item is name / input / helper line on a subgrid, so the inputs in a row
   always line up; the default sits UNDER the input ("Default ₹1,500", masked by the privacy screen),
   the currency sits inside the input, numbers are right-aligned, items are grouped by category with
   headings, a search box filters them, and each item has "Reset" (back to the default).

   Rules (no data loss):
     - empty = use the built-in default (the key is not stored)
     - a typed value must be a number >= 0 and <= 1,00,00,000 (BPStore.validate.money); a value the
       browser could not read (badInput) or that the number hardener cleared as negative BLOCKS the
       save instead of silently becoming "default"
     - prices stored for types this grid does not list are kept as they are
     - filtering only hides items; Save always reads every item
   Builds every element with the DOM API (no HTML strings). Pure helpers work in Node for tests. */
(function (global) {
  "use strict";

  var MAX = 10000000;
  var CATS = [
    ["structure", "Structure & stage"],
    ["av", "Sound, light & AV"],
    ["seating", "Seating & lounge"],
    ["security", "Security & crowd control"],
    ["logistics", "Logistics, power & food"],
    ["safety", "Safety"],
    ["decor", "Decor & florals"],
    ["fun", "Entertainment & experiences"],
    ["other", "Other"]
  ];
  var LIST = {
    structure: "stage mandap tent canopy dancefloor greenroom viprisers press truss walkway podium stageroof varmala dais lectern booth brandwall drape interpreter",
    av: "videowall ledscreen linearray foh dj piano led lighting speaker monitor movinghead uplight smoke subwoofer patower lightingtree micstand teleprompter projector tvstand pyro towerlight chandelier",
    seating: "sofa loveseat armchair ottoman bench lounge couplesofa gaddi bleacher coffeetable",
    security: "barricade stagebarrier fence checkpoint stanchion watchtower",
    logistics: "bar buffet truck generator distro parking restroom coatcheck desk gifttable caketable heater aircooler livecounter dessert coffee stall counter kiosk ticketbooth shoerack",
    safety: "exit firstaid extinguisher ambulance cableramp",
    decor: "fountain floralarch arch redcarpet floral pillar planter entrancegate phoolchadar haldi mehendi welcomeboard fairylights floralentrance stagebackdrop flowerwall toran floralpillar aislefloral centrepiece balloonarch balloonbunch flagstand hoarding diyastand havankund rangoli lanterns hangingfloral neonsign backdrop floralstand decorbox signage easel urli umbrellas kalash altar plinth trophytable",
    fun: "dancers photobooth chocolatefountain chariot jhoola kidszone doli selfieframe"
  };
  var CAT_OF = {};
  Object.keys(LIST).forEach(function (c) { LIST[c].split(" ").forEach(function (t) { CAT_OF[t] = c; }); });
  var CAT_NAME = {}; CATS.forEach(function (c) { CAT_NAME[c[0]] = c[1]; });

  function categoryOf(type) { return CAT_OF[type] || "other"; }

  // catalog = [[type, label, defaultPrice], ...] -> [{key, name, items:[{type,label,def}]}] in CATS order, names A-Z
  function groupCatalog(catalog) {
    var by = {};
    (catalog || []).forEach(function (row) {
      if (!row || !row[0]) return;
      var c = categoryOf(row[0]); (by[c] = by[c] || []).push({ type: String(row[0]), label: String(row[1] || row[0]), def: Number(row[2]) || 0 });
    });
    return CATS.filter(function (c) { return by[c[0]] && by[c[0]].length; }).map(function (c) {
      return { key: c[0], name: c[1], items: by[c[0]].sort(function (a, b) { return a.label.localeCompare(b.label); }) };
    });
  }

  function norm(s) { return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
  // every word of the query must appear in the item's name or type key
  function matches(item, query) {
    var q = norm(query); if (!q) return true;
    var hay = " " + norm(item.label) + " " + norm(item.type) + " ";
    return q.split(" ").every(function (w) { return hay.indexOf(w) >= 0; });
  }
  // a whole category is shown when every query word IS a word of its name ("seating", "safety", "food";
  // not "floral" -> "Decor & florals", which would pull in every decor item)
  function catMatches(type, query) {
    var q = norm(query); if (!q) return false;
    var words = " " + norm(CAT_NAME[categoryOf(type)]) + " ";
    return q.split(" ").every(function (w) { return words.indexOf(" " + w + " ") >= 0; });
  }
  function filterTypes(items, query) {
    var out = {};
    items.forEach(function (it) { if (matches(it, query) || catMatches(it.type, query)) out[it.type] = 1; });
    return out;
  }

  // what the input shows for a stored price: "" (use default) unless it is a real number
  function shownValue(v) {
    if (v == null) return "";
    if (typeof v === "string" && v.trim() === "") return "";
    var n = Number(v); return isFinite(n) ? String(n) : "";
  }

  function fallbackMoney(raw, field) {
    var s = String(raw).trim();
    if (!/^[+-]?\d+(\.\d+)?$/.test(s)) return { ok: false, error: field + " must be a number" };
    var n = Number(s); if (!isFinite(n)) return { ok: false, error: field + " must be a finite number" };
    if (n < 0) return { ok: false, error: field + " cannot be negative" };
    if (n > MAX) return { ok: false, error: field + " must be at most " + MAX };
    return { ok: true, value: Math.round(n * 100) / 100 };
  }
  // -> {ok, value} (value null = use the default) | {ok:false, error, short}
  //    st: {badInput, rejected} from the input element
  function checkRate(raw, label, st) {
    st = st || {}; var field = (label || "Item") + " price", s = String(raw == null ? "" : raw).trim();
    if (st.badInput) return { ok: false, error: field + " must be a number", short: "Enter a number" };
    if (s === "") {
      if (st.rejected === "negative") return { ok: false, error: field + " cannot be negative — enter 0 or more, or press Reset under it to use the default", short: "Can't be negative" };
      return { ok: true, value: null };
    }
    var V = global.BPStore && global.BPStore.validate;
    var r = V && V.money ? V.money(s, { field: field, max: MAX }) : fallbackMoney(s, field);
    if (r.ok) return { ok: true, value: r.value };
    var short = /negative/.test(r.error) ? "Can't be negative" : /at most/.test(r.error) ? "Too large" : "Enter a number";
    return { ok: false, error: r.error, short: short };
  }

  // merge the grid's values over the stored prices: types the grid does not list are kept untouched
  function mergePrices(prev, entries, catalogTypes) {
    var out = {}, listed = {};
    (catalogTypes || []).forEach(function (t) { listed[t] = 1; });
    if (prev && typeof prev === "object") Object.keys(prev).forEach(function (k) { if (!listed[k]) out[k] = prev[k]; });
    (entries || []).forEach(function (e) { if (e.value != null) out[e.type] = e.value; });
    return out;
  }

  function currencySymbol() {
    try { var s = global.BPStore.studioMoney(0); s = String(s).replace(/[\d.,\s ]+$/, "").trim(); if (s) return s; } catch (e) {}
    return "₹";
  }
  function moneyText(n) {
    try { return global.BPStore.studioMoney(n); } catch (e) { return "₹" + Number(n || 0).toLocaleString("en-IN"); }
  }

  /* ---------------- DOM ---------------- */
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }

  // host: the #itemPriceList element. opts: {catalog, prices}
  // -> {read() -> {ok, prices} | {ok:false, error, input}, markSaved()}
  function render(host, opts) {
    opts = opts || {};
    var catalog = opts.catalog || [], prices = opts.prices || {}, sym = currencySymbol();
    var groups = groupCatalog(catalog), items = [];
    clear(host); host.classList.add("apg");

    // ---- toolbar: search + counts ----
    var bar = el("div", "apg-bar");
    var sWrap = el("div", "apg-search");
    var search = el("input"); search.type = "search"; search.id = "apgSearch"; search.autocomplete = "off"; search.spellcheck = false;
    search.placeholder = "Find an item (e.g. stage, booth, floral)"; search.setAttribute("aria-label", "Find an item");
    search.setAttribute("aria-controls", host.id || ""); search.setAttribute("data-cs-nodirty", "1");
    sWrap.appendChild(search); bar.appendChild(sWrap);
    var count = el("p", "apg-count"); count.setAttribute("role", "status"); count.setAttribute("aria-live", "polite");
    bar.appendChild(count); host.appendChild(bar);
    var none = el("p", "apg-none", "No items match. Clear the search to see every item."); none.hidden = true;

    groups.forEach(function (g) {
      var sec = el("section", "apg-group"); sec.setAttribute("data-cat", g.key);
      var h = el("h4", "apg-gh"); h.id = "apg_h_" + g.key; h.appendChild(el("span", null, g.name)); var gc = el("span", "apg-gc"); h.appendChild(gc);
      sec.setAttribute("aria-labelledby", h.id); sec.appendChild(h);
      var grid = el("div", "apg-grid"); sec.appendChild(grid);
      var gItems = [];
      g.items.forEach(function (it) {
        var id = "ip_" + it.type, box = el("div", "apg-item"); box.setAttribute("data-type", it.type);
        var lab = el("label", "apg-name", it.label); lab.htmlFor = id; lab.title = it.label; box.appendChild(lab);
        var field = el("div", "apg-field");
        var cur = el("span", "apg-cur", sym); cur.setAttribute("aria-hidden", "true"); field.appendChild(cur);
        var inp = el("input"); inp.id = id; inp.type = "number"; inp.min = "0"; inp.step = "0.01";
        // no max= attribute: the number hardener silently clamps a value above max= on blur, so 2,50,00,000
        // would quietly be saved as 1,00,00,000. Without it the validator blocks the save with "Too large".
        inp.setAttribute("inputmode", "decimal"); inp.setAttribute("data-type", it.type); inp.placeholder = "Default"; inp.autocomplete = "off";
        inp.value = shownValue(prices[it.type]);
        var helpId = "apg_d_" + it.type; inp.setAttribute("aria-describedby", helpId);
        field.appendChild(inp); box.appendChild(field);
        var help = el("div", "apg-help"); help.id = helpId;
        var def = el("span", "apg-def"); def.appendChild(document.createTextNode("Default "));
        var amt = el("span", "apg-amt", moneyText(it.def)); amt.setAttribute("data-money", "1"); def.appendChild(amt); help.appendChild(def);
        var err = el("span", "apg-err"); err.hidden = true; help.appendChild(err);
        var rs = el("button", "apg-reset", "Reset"); rs.type = "button"; rs.title = "Clear this price and use the default";
        rs.setAttribute("aria-label", "Reset " + it.label + " to the default price"); help.appendChild(rs);
        box.appendChild(help); grid.appendChild(box);
        var rec = { it: it, box: box, inp: inp, err: err, def: def, rs: rs, sec: sec, saved: inp.value };
        items.push(rec); gItems.push(rec);
        inp.addEventListener("input", function () { setTimeout(function () { paint(rec); counts(); }, 0); });
        inp.addEventListener("blur", function () { setTimeout(function () { paint(rec); counts(); }, 0); });
        rs.addEventListener("click", function () {
          inp.value = ""; inp.removeAttribute("data-rejected");
          try { inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) {}
          paint(rec); counts(); try { inp.focus({ preventScroll: true }); } catch (e) {}
        });
        paint(rec);
      });
      sec.__items = gItems; sec.__gc = gc;
      host.appendChild(sec);
    });
    host.appendChild(none);

    // an item the user has not touched keeps its stored price exactly (e.g. a legacy 1500.555 or a price
    // above today's cap) - only values the user typed are re-validated. A stored negative / junk is still blocked.
    function legacy(rec) {
      if (rec.inp.value !== rec.saved || rec.saved === "") return null;
      var v = prices[rec.it.type], n = typeof v === "string" ? (v.trim() === "" ? NaN : Number(v)) : (typeof v === "number" ? v : NaN);
      return isFinite(n) && n >= 0 ? { ok: true, value: n } : null;
    }
    function check(rec) { return legacy(rec) || checkRate(rec.inp.value, rec.it.label, state(rec)); }
    function state(rec) { return { badInput: !!(rec.inp.validity && rec.inp.validity.badInput), rejected: rec.inp.getAttribute("data-rejected") }; }
    function paint(rec) {
      var r = check(rec), custom = String(rec.inp.value).trim() !== "";
      rec.box.classList.toggle("is-custom", custom && r.ok);
      rec.box.classList.toggle("is-changed", rec.inp.value !== rec.saved);
      rec.box.classList.toggle("is-bad", !r.ok);
      rec.inp.setAttribute("aria-invalid", r.ok ? "false" : "true");
      rec.err.hidden = r.ok; rec.def.hidden = !r.ok; rec.err.textContent = r.ok ? "" : r.short; rec.err.title = r.ok ? "" : r.error;
      rec.rs.classList.toggle("is-off", !custom && !(state(rec).badInput) && rec.inp.getAttribute("data-rejected") !== "negative");
      return r;
    }
    function counts() {
      var q = search.value, shown = 0, custom = 0, changed = 0, keep = filterTypes(items.map(function (r) { return r.it; }), q);
      Array.prototype.forEach.call(host.querySelectorAll(".apg-group"), function (sec) {
        var n = 0;
        sec.__items.forEach(function (rec) { var ok = !!keep[rec.it.type]; rec.box.hidden = !ok; if (ok) n++; });
        sec.hidden = !n; sec.__gc.textContent = String(n); shown += n;
      });
      items.forEach(function (rec) { if (rec.box.classList.contains("is-custom")) custom++; if (rec.inp.value !== rec.saved) changed++; });
      none.hidden = shown > 0;
      var parts = [(q.trim() ? shown + " of " + items.length : items.length) + " items", custom + " with your own price"];
      if (changed) parts.push(changed + " not saved yet");
      count.textContent = parts.join(" · ");
      count.classList.toggle("has-changed", !!changed);
    }
    // the search box is not a setting: keep it away from the unsaved-changes tracker
    ["input", "change"].forEach(function (t) { search.addEventListener(t, function (e) { e.stopPropagation(); if (t === "input") counts(); }); });
    search.addEventListener("keydown", function (e) { if (e.key === "Escape" && search.value) { e.preventDefault(); search.value = ""; counts(); } });
    counts();

    return {
      read: function () {
        var entries = [];
        for (var i = 0; i < items.length; i++) {
          var rec = items[i], r = paint(rec);
          if (!r.ok) {
            if (rec.box.hidden) { search.value = ""; counts(); }
            return { ok: false, error: r.error, input: rec.inp };
          }
          entries.push({ type: rec.it.type, value: r.value });
        }
        return { ok: true, prices: mergePrices(prices, entries, catalog.map(function (c) { return c[0]; })) };
      },
      // after a successful save: the current values become the "saved" baseline
      markSaved: function (next) {
        if (next) prices = next;
        items.forEach(function (rec) { rec.saved = rec.inp.value; paint(rec); }); counts();
      }
    };
  }

  var API = { CATS: CATS, MAX: MAX, categoryOf: categoryOf, groupCatalog: groupCatalog, matches: matches, filterTypes: filterTypes, shownValue: shownValue,
    checkRate: checkRate, mergePrices: mergePrices, render: render };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  global.HelmAssetPriceGrid = API;
})(typeof window !== "undefined" ? window : globalThis);
