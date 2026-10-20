/* =========================================================================
   HelmStockFlow (r24) — ONE stock story per item on an event, the same words
   on Inventory, Teardown & returns, Event-day command and Closure:

     Reserved  held for the event (a reservation)
     Out       given to a person, with who + when (a check-out, status 'out')
     Back      came back OK          Missing  did not come back
     Damaged   came back broken (Missing and Damaged come off what you own)

   A reservation that was never taken out is "Reserved — never taken out,
   nothing to return": it never blocks closing and is released automatically
   (server: release_unused_stock / trigger zz_r24_release_on_back, 0268).
   'allocated' with no check-out = given out before names were recorded: it
   counts as Out (name not recorded) until someone marks it back.
   Pure functions, no DOM. Browser: window.HelmStockFlow; Node: require().
   ========================================================================= */
(function (root) {
  "use strict";

  var LABEL = { reserved: "Reserved", out: "Out", back: "Back", missing: "Missing", damaged: "Damaged", released: "Released" };
  var NEVER_OUT = "Reserved — never taken out, nothing to return";
  function n(x) { var v = Number(x); return isFinite(v) ? v : 0; }

  // one check-out row -> { out, back, missing, damaged, cancelled }
  function coParts(c) {
    c = c || {};
    if (c.status === "cancelled") return { out: 0, back: 0, missing: 0, damaged: 0, cancelled: true };
    if (c.status === "out") return { out: Math.max(n(c.qty_out) - n(c.qty_in), 0), back: 0, missing: 0, damaged: 0, cancelled: false };
    var dmg = Math.max(n(c.qty_damaged), 0), inn = n(c.qty_in);
    return { out: 0, back: Math.max(inn - dmg, 0), missing: Math.max(n(c.qty_out) - inn, 0), damaged: dmg, cancelled: false };
  }
  // the state word of one check-out
  function coState(c) {
    var p = coParts(c);
    if (p.cancelled) return "cancelled";
    if (p.out > 0) return "out";
    if (p.missing > 0) return "missing";
    if (p.damaged > 0) return "damaged";
    return "back";
  }
  // "Back 17 · Damaged 2 · Missing 1" / "Out 20"
  function coSummary(c) {
    var p = coParts(c);
    if (p.cancelled) return "Cancelled (recorded by mistake)";
    if (p.out > 0) return "Out " + p.out;
    var bits = ["Back " + p.back];
    if (p.damaged) bits.push("Damaged " + p.damaged);
    if (p.missing) bits.push("Missing " + p.missing);
    return bits.join(" · ");
  }
  // units still off the shelf AND still in what you own (free-stock maths; mirrors public._r24_not_back)
  function notBack(c) {
    if (!c || (c.status !== "out" && c.status !== "partial")) return 0;
    return Math.max(n(c.qty_out) - n(c.qty_in) - Math.max(n(c.written_off) - n(c.qty_damaged), 0), 0);
  }

  var LIVE_RES = { reserved: 1, allocated: 1 };
  // per item on ONE event: reservations + check-outs of that event -> rows
  //   { item_id, reserved, out, back, missing, damaged, legacyOut, unused, outs[], history[], resIds[], legacyIds[], state, label }
  function eventItems(o) {
    o = o || {};
    var res = o.reservations || [], cos = o.checkouts || [], by = {};
    function slot(id) { return by[id] || (by[id] = { item_id: id, reserved: 0, live: 0, alloc: 0, out: 0, back: 0, missing: 0, damaged: 0,
      outs: [], history: [], resIds: [], liveIds: [], allocIds: [] }); }
    res.forEach(function (r) {
      if (!r || !r.item_id) return; var s = slot(r.item_id);
      if (r.status !== "cancelled") s.reserved += n(r.qty);
      if (LIVE_RES[r.status]) { s.live += n(r.qty); s.liveIds.push(r.id); }
      if (r.status === "allocated") { s.alloc += n(r.qty); s.allocIds.push(r.id); }
      s.resIds.push(r.id);
    });
    cos.forEach(function (c) {
      if (!c || !c.item_id || c.status === "cancelled") return; var s = slot(c.item_id), p = coParts(c);
      s.out += p.out; s.back += p.back; s.missing += p.missing; s.damaged += p.damaged;
      s.history.push(c); if (p.out > 0) s.outs.push(c);
    });
    return Object.keys(by).map(function (k) {
      var s = by[k], went = s.history.length > 0;
      s.legacyOut = went ? 0 : s.alloc;                       // given out before names were recorded
      s.legacyIds = went ? [] : s.allocIds;
      s.unused = went ? 0 : Math.max(s.live - s.alloc, 0);   // reserved, never taken out
      if (s.out > 0 || s.legacyOut > 0) s.state = "out";
      else if (went && s.missing > 0) s.state = "missing";
      else if (went && s.damaged > 0) s.state = "damaged";
      else if (went) s.state = "back";
      else if (s.unused > 0) s.state = "reserved";
      else s.state = "released";
      s.label = LABEL[s.state];
      return s;
    });
  }
  // stock still out for this event (blocks closing): Out + given out with no name recorded
  function stillOut(rows) { return (rows || []).reduce(function (a, r) { return a + n(r.out) + n(r.legacyOut); }, 0); }
  // one line of plain detail under the state word
  function detail(row, o) {
    o = o || {}; var f = o.fmt || function (x) { return x || ""; }, unit = o.unit ? " " + o.unit : "";
    if (!row) return "";
    if (row.state === "out") {
      var bits = row.outs.map(function (c) { return (Math.max(n(c.qty_out) - n(c.qty_in), 0)) + unit + " with " + (c.issued_to || "someone") + (c.checked_out_at ? " since " + f(c.checked_out_at) : ""); });
      if (row.legacyOut) bits.push(row.legacyOut + unit + " given out (name not recorded)");
      return bits.join(" · ");
    }
    if (row.state === "reserved") return o.eventOver ? NEVER_OUT : "Held for this event — give it out when it leaves the store";
    if (row.state === "released") return row.history.length ? "" : NEVER_OUT + " (released automatically)";
    var parts = ["Back " + row.back];
    if (row.damaged) parts.push("Damaged " + row.damaged);
    if (row.missing) parts.push("Missing " + row.missing);
    return parts.join(" · ");
  }

  // event-day stock request -> { key, label, pill }
  function requestState(r, coById) {
    r = r || {};
    if (r.status === "cancelled") return { key: "cancelled", label: "Not needed", pill: "no_show" };
    if (r.status === "replaced") return { key: "replaced", label: "Swapped", pill: "left" };
    if (r.status === "issued") {
      var c = r.checkout_id && coById ? coById[r.checkout_id] : null;
      if (c) { var st = coState(c); return { key: st, label: st === "out" ? "Out" : (LABEL[st] || "Back"), pill: st === "out" ? "pending" : (st === "back" ? "done" : "no_show"), checkout: c }; }
      if (r.source) return { key: "sourced", label: "Sourced", pill: "done" };
      return { key: "given", label: "Given out", pill: "done" };
    }
    return { key: "requested", label: "Requested", pill: "pending" };
  }

  // one item's history: newest first -> { event, eventDate, quoteId, to, qty, outAt, backAt, state, label, summary }
  function history(cos, quotesById) {
    quotesById = quotesById || {};
    return (cos || []).filter(function (c) { return c && c.status !== "cancelled"; })
      .slice().sort(function (a, b) { return String(b.checked_out_at || "").localeCompare(String(a.checked_out_at || "")); })
      .map(function (c) {
        var q = c.quotes || (c.quote_id ? quotesById[c.quote_id] : null) || null, st = coState(c);
        return { id: c.id, quoteId: c.quote_id || null, event: q ? (q.title || q.code || "Event") : (c.quote_id ? "Event" : "No event"),
          eventDate: q ? (q.event_date || q.eventDate || null) : null, to: c.issued_to || "", qty: n(c.qty_out),
          outAt: c.checked_out_at || null, backAt: st === "out" ? null : (c.checked_in_at || null), state: st, label: LABEL[st] || st, summary: coSummary(c) };
      });
  }

  // searchable picker: items whose name / category contain every typed word (case-insensitive), best first
  function search(items, q, limit) {
    var words = String(q || "").toLowerCase().split(/\s+/).filter(Boolean), out = [];
    (items || []).forEach(function (i) {
      var name = String(i.name || "").toLowerCase(), hay = name + " " + String(i.category || "").toLowerCase();
      if (words.every(function (w) { return hay.indexOf(w) >= 0; })) out.push({ i: i, starts: words.length && name.indexOf(words[0]) === 0 ? 0 : 1 });
    });
    out.sort(function (a, b) { return a.starts - b.starts || String(a.i.name || "").localeCompare(String(b.i.name || ""), undefined, { numeric: true, sensitivity: "base" }); });
    return out.slice(0, limit || 200).map(function (x) { return x.i; });
  }

  var api = { LABEL: LABEL, NEVER_OUT: NEVER_OUT, coParts: coParts, coState: coState, coSummary: coSummary, notBack: notBack,
    eventItems: eventItems, stillOut: stillOut, detail: detail, requestState: requestState, history: history, search: search };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HelmStockFlow = api;
})(typeof window !== "undefined" ? window : this);
