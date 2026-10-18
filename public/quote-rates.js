/* quote-rates.js - qmodal-1018: the EFFECTIVE per-chair / per-plate rates a quote is priced at, and the client
   details the Confirm / Re-price dialog (quotes.html) opens with. Pure helpers, unit-tested in
   test/quote-modal-pricing.test.mjs. No DOM, no network.

   Rules (same as the event workspace, flow.html):
     plate  the applied menu package's CURRENT price wins (looked up by the package name on the event plan);
            only when that package can't be found any more, the price it was applied at (event_plan.menu_plate_price);
            with no package: the quote's own price when the quote keeps its own currency, else the studio default.
     chair  the studio default; the quote's own price only when the quote keeps its own currency / tax
            snapshot (shown as "locked at quote time").
   Studio default = Control Center > Pricing. A pricing config without chairPrice / platePrice (a free-trial studio's
   config only carries tax + terms keys) falls back to 200 / 500 - the same numbers Control Center shows for it. */
(function (global) {
  "use strict";
  var DEFAULTS = { chairPrice: 200, platePrice: 500 };   // = store-api.js PRICING_DEFAULTS / Control Center's fallback

  // a usable money value (0 is a real price), else null
  function num(v) {
    if (v === null || v === undefined || typeof v === "boolean" || String(v).trim() === "") return null;
    var n = Number(v); return isFinite(n) && n >= 0 ? n : null;
  }
  function studioRates(cfg) {
    cfg = cfg && typeof cfg === "object" ? cfg : {};
    var c = num(cfg.chairPrice), p = num(cfg.platePrice);
    return { chairPrice: c != null ? c : DEFAULTS.chairPrice, platePrice: p != null ? p : DEFAULTS.platePrice,
      chairDefaulted: c == null, plateDefaulted: p == null };
  }
  function norm(s) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase(); }
  // the package the event plan names (an active one first; an inactive one still prices an event it is applied to)
  function findPackage(plan, packages) {
    if (!plan || !plan.menu_template || !Array.isArray(packages)) return null;
    var want = norm(plan.menu_template); if (!want) return null;
    var hits = packages.filter(function (p) { return p && norm(p.name) === want; });
    if (!hits.length) return null;
    return hits.filter(function (p) { return p.active !== false; })[0] || hits[0];
  }
  // o: { cfg, pricing (the quote's stored pricing), plan (event_plan row), packages (menu templates), keep }
  function effective(o) {
    o = o || {};
    var s = studioRates(o.cfg), pr = o.pricing && typeof o.pricing === "object" ? o.pricing : {}, plan = o.plan || null, keep = !!o.keep;
    var r = { chairPrice: s.chairPrice, chairSrc: "studio", platePrice: s.platePrice, plateSrc: "studio", pkgName: "", pkgStale: false, saved: null };
    var prC = num(pr.chairPrice), prP = num(pr.platePrice);
    if (keep && prC != null) { r.chairPrice = prC; r.chairSrc = "locked"; }
    var pkg = findPackage(plan, o.packages), pkgPrice = pkg ? num(pkg.price_per_plate) : null;
    var snap = plan ? num(plan.menu_plate_price) : null;
    if (pkgPrice != null) {
      r.platePrice = pkgPrice; r.plateSrc = "package"; r.pkgName = String(pkg.name);
      r.pkgStale = snap != null && snap !== pkgPrice;   // the plan still carries the price the package had when applied
    } else if (snap != null && plan && plan.menu_template) {
      r.platePrice = snap; r.plateSrc = "package"; r.pkgName = String(plan.menu_template);
    } else if (keep && prP != null) { r.platePrice = prP; r.plateSrc = "locked"; }
    // what this quote was last saved at, when that differs from the rates above (a save re-prices it)
    var priced = ("total" in pr) || ("gstPct" in pr);
    if (priced && ((prC != null && prC !== r.chairPrice) || (prP != null && prP !== r.platePrice)))
      r.saved = { chairPrice: prC, platePrice: prP };
    return r;
  }
  function chairLabel(r) { return r && r.chairSrc === "locked" ? "locked at quote time" : "studio rate"; }
  function plateLabel(r) {
    if (!r) return "";
    if (r.plateSrc === "package") return "package: " + r.pkgName;
    return r.plateSrc === "locked" ? "locked at quote time" : "studio rate";
  }
  // the header line of the dialog; money(n) formats an amount in the quote's currency
  function note(r, money, tax) {
    money = typeof money === "function" ? money : function (n) { return String(n); };
    var s = "· " + money(r.chairPrice) + "/chair (" + chairLabel(r) + ") · " + money(r.platePrice) + "/plate (" + plateLabel(r) + ")";
    if (tax && tax.name) s += " · " + tax.name + " " + tax.rate + "%" + (tax.inclusive ? " (included in prices)" : "");
    return s + "  (edit in Control Center)";
  }
  // "Saved on this quote: ..." - only when a save would change the stored rates
  function savedNote(r, money) {
    if (!r || !r.saved) return "";
    money = typeof money === "function" ? money : function (n) { return String(n); };
    var parts = [];
    if (r.saved.chairPrice != null) parts.push(money(r.saved.chairPrice) + "/chair");
    if (r.saved.platePrice != null) parts.push(money(r.saved.platePrice) + "/plate");
    return parts.length ? "Saved on this quote: " + parts.join(" · ") + ". Saving prices it at the rates above." : "";
  }

  // ---- client prefill: the quote's client record, then the client copy inside its pricing, then the list row ----
  var CLIENT_KEYS = ["name", "company", "email", "phone", "eventDate", "venue", "address", "notes", "state", "trn"];
  function blank(v) { return v === null || v === undefined || String(v).trim() === ""; }
  function clientFor(full, row, plan) {
    full = full || {};
    var srcs = [full.client, full.pricing && full.pricing.client, row && row.client, row && row.pricing && row.pricing.client]
      .filter(function (c) { return c && typeof c === "object"; });
    var out = {};
    CLIENT_KEYS.forEach(function (k) { for (var i = 0; i < srcs.length; i++) { if (!blank(srcs[i][k])) { out[k] = srcs[i][k]; return; } } out[k] = ""; });
    if (blank(out.eventDate) && !blank(full.eventDate)) out.eventDate = String(full.eventDate).slice(0, 10);
    if (blank(out.venue) && plan && !blank(plan.venue_name)) out.venue = plan.venue_name;
    if (blank(out.address) && plan && !blank(plan.venue_address)) out.address = plan.venue_address;
    return out;
  }

  global.HelmQuoteRates = { DEFAULTS: DEFAULTS, num: num, studioRates: studioRates, findPackage: findPackage, effective: effective,
    chairLabel: chairLabel, plateLabel: plateLabel, note: note, savedNote: savedNote, clientFor: clientFor, CLIENT_KEYS: CLIENT_KEYS };
})(typeof window !== "undefined" ? window : globalThis);
