/* event-sizing.js — ONE source of truth for event sizing (guests, chairs, tables, plates, hall L×B).
   Everything lives on the quote's `client` JSON (no new columns):
     client.guests        headcount (existing field)
     client.chairs        chair count; client.chairsManual=true once a person typed it
     client.tables        round tables; client.tablesManual=true once typed
     client.hallLen/hallWid  hall size in ft
   Plates/guests billed stay on pricing.guests (defaults to client.guests).
   Pure helpers (no DOM) so node tests can load them; the flow page and the floor builder
   both use them so every screen derives the same defaults the same way. */
(function (global) {
  "use strict";
  var CHAIR_RATIO = 0.7, SEATS_PER_TABLE = 8;   // 8 = the round-table generator's default seats per table
  function pos(v) { if (v === "" || v == null) return null; var n = +v; return isFinite(n) && n >= 0 ? Math.round(n) : null; }
  // Default chairs = 70% of guests, rounded UP.
  function defaultChairs(guests) { var g = pos(guests); return g == null ? null : Math.ceil((g * 7) / 10); }
  function defaultTables(chairs, spt) { var c = pos(chairs), s = pos(spt) || SEATS_PER_TABLE; return c == null ? null : Math.ceil(c / s); }
  // Resolve the sizing everyone should show from what's stored (client, pricing, layout room).
  function resolve(client, pricing, room) {
    var cl = client || {}, pr = pricing || {}, rm = room || {};
    var guests = pos(cl.guests);
    var chairsManual = !!cl.chairsManual && pos(cl.chairs) != null;
    var chairs = chairsManual ? pos(cl.chairs) : defaultChairs(guests);
    var tablesManual = !!cl.tablesManual && pos(cl.tables) != null;
    var tables = tablesManual ? pos(cl.tables) : defaultTables(chairs);
    var plates = pos(pr.guests) != null ? pos(pr.guests) : guests;
    var len = pos(cl.hallLen) || pos(rm.w) || null, wid = pos(cl.hallWid) || pos(rm.h) || null;
    return { guests: guests, chairs: chairs, chairsManual: chairsManual, tables: tables, tablesManual: tablesManual,
      plates: plates, len: len, wid: wid };
  }
  // Merge a sizing patch from one screen into the stored client. Only defined keys move;
  // an explicit null clears. A chairs value equal to the 70% default is NOT treated as manual
  // unless the caller says so (so "reset to 70%" really resets).
  function merge(client, patch) {
    var out = Object.assign({}, client || {}), p = patch || {};
    ["guests", "chairs", "tables", "hallLen", "hallWid"].forEach(function (k) {
      if (Object.prototype.hasOwnProperty.call(p, k)) out[k] = p[k] == null || p[k] === "" ? null : pos(p[k]);
    });
    if (Object.prototype.hasOwnProperty.call(p, "chairsManual")) out.chairsManual = !!p.chairsManual;
    if (Object.prototype.hasOwnProperty.call(p, "tablesManual")) out.tablesManual = !!p.tablesManual;
    if (!out.chairsManual && Object.prototype.hasOwnProperty.call(p, "guests")) out.chairs = defaultChairs(out.guests);
    if (!out.tablesManual && (Object.prototype.hasOwnProperty.call(p, "guests") || Object.prototype.hasOwnProperty.call(p, "chairs"))) out.tables = defaultTables(out.chairs);
    return out;
  }
  // R8b: the quote's ONE chairs value — the pricing source everywhere (chairs × chair rate).
  // Hand-typed chairs (client first, then pricing) win; otherwise 70% of guests (rounded up);
  // a saved pricing.chairs next; the layout's count only when the quote has nothing at all.
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  // R9: a quote priced before R8 has pricing.chairs but no chairsManual flag on either record. Its
  // saved chairs are what the server billed (D8 helm_quote_total reads pricing.chairs), so they are
  // treated as hand-set — re-deriving 70% of guests would silently change an existing total.
  function legacyChairs(cl, pr) {
    if (has(cl, "chairsManual") || has(pr, "chairsManual") || pos(pr.chairs) == null) return false;
    return pos(pr.chairs) !== defaultChairs(cl.guests != null && cl.guests !== "" ? cl.guests : pr.guests);
  }
  function isChairsManual(client, pricing) {
    var cl = client || {}, pr = pricing || {};
    if (has(cl, "chairsManual")) return !!(cl.chairsManual && pos(cl.chairs) != null);
    return !!((pr.chairsManual && pos(pr.chairs) != null) || legacyChairs(cl, pr));
  }
  // The client record is written first by every screen (flow, builder, quotes) — when it carries the
  // flag it is authoritative, so a "reset to 70%" there is never undone by a stale pricing flag.
  function quoteChairs(client, pricing, fallback) {
    var cl = client || {}, pr = pricing || {};
    if (has(cl, "chairsManual")) { if (cl.chairsManual && pos(cl.chairs) != null) return pos(cl.chairs); }
    else if (pr.chairsManual && pos(pr.chairs) != null) return pos(pr.chairs);
    else if (legacyChairs(cl, pr)) return pos(pr.chairs);
    var d = defaultChairs(cl.guests != null && cl.guests !== "" ? cl.guests : pr.guests);
    if (d != null) return d;
    if (pos(pr.chairs) != null) return pos(pr.chairs);
    return pos(fallback);
  }
  // R9: what the Custom Event dialog shows EVERY time it opens — the quote's current sizing
  // (chairs incl. hand edits from any screen; tables = ceil(chairs / seats-per-table) unless typed).
  function dialogSizing(client, pricing, room, guestsFallback, spt) {
    var cl = Object.assign({}, client || {}), pr = pricing || {};
    if (pos(cl.guests) == null && pos(guestsFallback) != null) cl.guests = pos(guestsFallback);
    var sz = resolve(cl, pr, room);
    var chairs = quoteChairs(cl, pr, null), chairsManual = isChairsManual(cl, pr);
    var tables = sz.tablesManual ? sz.tables : defaultTables(chairs, spt);
    return { guests: sz.guests, chairs: chairs, chairsManual: chairsManual, tables: tables, tablesManual: sz.tablesManual, len: sz.len, wid: sz.wid };
  }
  // R9: "Décor / setup" (pricing.other) is hand-set when it no longer equals the last auto value
  // (objects + layout base) a screen computed. No record of an auto value → hand-set (never clobber).
  // Returns the saved number when hand-set, else null (= follow the layout's objects).
  function handOther(pricing, sessionAuto) {
    var pr = pricing || {};
    if (pr.other == null || pr.other === "" || !isFinite(+pr.other)) return null;
    var prev = pr.otherAuto != null && pr.otherAuto !== "" ? +pr.otherAuto : (sessionAuto != null ? +sessionAuto : null);
    return prev == null || +pr.other !== prev ? Math.max(0, +pr.other) : null;
  }
  // R8b: the layout's real chair count differs from the quote → offer (never force) a one-click switch
  function layoutChairsNote(quoteValue, layoutValue) {
    var q = pos(quoteValue), l = pos(layoutValue);
    if (!l || q === l) return null;
    return { n: l, text: "Layout has " + l + " chairs \u2014 use " + l + " for pricing?" };
  }
  // Template recommendations. `variant` = the generator layout that is built WITH the user's
  // numbers (never the preset's own fixed counts); `sqft` = floor area per seated person.
  var PRESETS = [
    { key: "wedding_banquet", label: "Banquet + dance floor", variant: "Banquet + stage + dance", types: ["wedding", "reception", "gala"], sqft: 12, tag: "Wedding" },
    { key: "wedding_ceremony", label: "Ceremony (canopy + aisle)", variant: "Theatre rows", opts: { canopy: true }, types: ["wedding", "engagement"], sqft: 8, tag: "Ceremony" },
    { key: "wedding_reception", label: "Cocktail reception", variant: "Cocktail reception", types: ["wedding", "reception", "cocktail", "birthday"], sqft: 9, tag: "Reception" },
    { key: "gala_awards", label: "Gala / awards banquet", variant: "Cabaret / crescent rounds", types: ["gala", "wedding", "corporate"], sqft: 12, tag: "Gala" },
    { key: "political_townhall", label: "Town hall (round tables)", variant: "Round tables", types: ["political", "conference", "corporate"], sqft: 11, tag: "Town hall" },
    { key: "political_theatre", label: "Theatre seating", variant: "Theatre rows", types: ["political", "conference", "concert", "corporate"], sqft: 7, tag: "Theatre" },
    { key: "conference_classroom", label: "Classroom / breakout", variant: "Classroom", types: ["conference", "corporate"], sqft: 10, tag: "Conference" },
    { key: "concert_mainstage", label: "Concert (main stage)", variant: "Theatre rows", types: ["concert", "festival"], sqft: 6, tag: "Concert" }
  ];
  var TYPE_ALIAS = { rally: "political", expo: "conference", product_launch: "corporate", party: "birthday" };
  // R10: comfortable floor area per seat for an event type — the smallest sqft of the presets
  // rankTemplates would recommend for it (so "Fits N guests" and the hall-size warning agree).
  function seatSqft(type) {
    var t = String(type || "").toLowerCase(); t = TYPE_ALIAS[t] || t;
    var hit = PRESETS.filter(function (p) { return p.types.indexOf(t) >= 0; });
    var list = hit.length ? hit : PRESETS;
    return Math.min.apply(null, list.map(function (p) { return p.sqft; }));
  }
  function rankTemplates(input, presets, limit) {
    var o = input || {}, list = presets || PRESETS;
    var type = String(o.type || "").toLowerCase(); type = TYPE_ALIAS[type] || type;
    var seats = pos(o.chairs) || defaultChairs(o.guests) || 0, guests = pos(o.guests) || seats;
    var len = pos(o.len), wid = pos(o.wid), area = len && wid ? len * wid : 0;
    var scored = list.map(function (p, i) {
      var typeHit = p.types.indexOf(type) >= 0, score = typeHit ? 50 - p.types.indexOf(type) * 2 : 0, why = [];
      if (typeHit) why.push(p.tag);
      var fits = null;
      if (area && seats) {
        var need = seats * p.sqft; fits = area >= need;
        var ratio = area / need;
        score += fits ? 30 - Math.min(20, Math.abs(ratio - 1.3) * 10) : -20 * (1 - ratio);
        why.push(fits ? "Fits " + guests + " guests in " + len + "×" + wid + " ft"
          : "Tight: ~" + Math.ceil(need).toLocaleString("en-IN") + " sq ft needed, hall is " + area.toLocaleString("en-IN"));
      } else if (seats) { why.push(seats + " chairs"); }
      return { key: p.key, label: p.label, variant: p.variant, opts: p.opts || null, score: Math.round(score * 10) / 10, fits: fits, why: why, i: i };
    });
    scored.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    return scored.slice(0, limit || 3);
  }
  var api = { CHAIR_RATIO: CHAIR_RATIO, SEATS_PER_TABLE: SEATS_PER_TABLE, PRESETS: PRESETS,
    defaultChairs: defaultChairs, quoteChairs: quoteChairs, isChairsManual: isChairsManual, handOther: handOther, dialogSizing: dialogSizing, layoutChairsNote: layoutChairsNote, defaultTables: defaultTables, resolve: resolve, merge: merge, rankTemplates: rankTemplates, seatSqft: seatSqft };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.HelmSizing = api;
})(typeof window !== "undefined" ? window : globalThis);
