/* =========================================================================
   HelmCheckoutShortage — equipment check-out availability + the friendly
   "not enough stock" panel text. Pure functions, no DOM.

   available(item, date, quote) = total
       - everything physically still out (open check-outs on ANY event)
       - other live events' reservations on the same date not yet checked out
       - in repair (not tracked yet: 0)
     never below 0. Mirrors public._checkout_free (0105); the server is the
     authority (checkout_equipment_smart re-checks under a row lock) — this copy
     only drives the UI when the RPC is missing (older DB) and the unit tests.
   Browser: window.HelmCheckoutShortage; Node: require().
   ========================================================================= */
(function (root) {
  "use strict";
  var OPEN = { out: 1, partial: 1 };
  function n(x) { var v = Number(x); return isFinite(v) ? v : 0; }
  function stillOut(c) { return Math.max(n(c.qty_out) - n(c.qty_in), 0); }
  function liveQuote(q) {
    return !!q && !(q.deleted_at || q.archived_at || q.status === "cancelled" || (q.lifecycle_stage === "closed" && q.status === "confirmed"));
  }
  function addDays(iso, d) {
    if (!iso) return null; var t = Date.parse(String(iso).slice(0, 10) + "T00:00:00Z"); if (!isFinite(t)) return null;
    return new Date(t + d * 86400000).toISOString().slice(0, 10);
  }

  // item {id,name,category,unit,total_qty}; checkouts / reservations rows; quotes {id: {title,event_date,status,...}}
  function compute(o) {
    var it = o.item || {}, quotes = o.quotes || {}, today = o.today || new Date().toISOString().slice(0, 10);
    var qid = o.quoteId || null, date = o.eventDate || (qid && quotes[qid] ? quotes[qid].event_date : null) || null;
    var total = n(it.total_qty);
    var open = (o.checkouts || []).filter(function (c) { return c.item_id === it.id && OPEN[c.status] && stillOut(c) > 0; });
    var outNow = open.reduce(function (s, c) { return s + stillOut(c); }, 0);
    var outByQuote = {}; open.forEach(function (c) { var k = c.quote_id || ""; outByQuote[k] = (outByQuote[k] || 0) + stillOut(c); });
    var resByQuote = {};
    (o.reservations || []).forEach(function (r) { if (r.item_id === it.id && (r.status === "reserved" || r.status === "allocated")) resByQuote[r.quote_id] = (resByQuote[r.quote_id] || 0) + n(r.qty); });
    var reservedOther = 0, reservedBy = [];
    if (date) Object.keys(resByQuote).forEach(function (k) {
      var q = quotes[k]; if (k === qid || !liveQuote(q) || q.event_date !== date) return;
      var hold = Math.max(resByQuote[k] - (outByQuote[k] || 0), 0);
      if (hold > 0) { reservedOther += hold; reservedBy.push({ quote_id: k, event: q.title || "Another event", event_date: q.event_date, qty: resByQuote[k] }); }
    });
    var inRepair = n(o.inRepair);
    var available = Math.max(total - outNow - reservedOther - inRepair, 0);
    var blocking = open.map(function (c) {
      var q = c.quote_id ? quotes[c.quote_id] : null, due = q && q.event_date ? addDays(q.event_date, 1) : null;
      return { checkout_id: c.id, quote_id: c.quote_id || null, event: q ? (q.title || "Event") : "No event", event_date: q ? q.event_date : null,
        due_back: due, qty: stillOut(c), issued_to: c.issued_to || "", overdue: !!(due && due < today) };
    }).sort(function (a, b) { return String(a.due_back || "9999").localeCompare(String(b.due_back || "9999")); });
    return { item_id: it.id, item: it.name || "this item", category: it.category || null, unit: it.unit || "", total: total,
      out_now: outNow, reserved_other: reservedOther, in_repair: inRepair, available: available, event_date: date,
      blocking: blocking, overdue: blocking.filter(function (b) { return b.overdue; }), reserved_by: reservedBy, substitutes: [] };
  }

  // same-category items with free stock, most free first (UI fallback; the RPC returns these too)
  function substitutes(items, itemId, freeOf, limit) {
    var me = (items || []).filter(function (i) { return i.id === itemId; })[0]; if (!me || !me.category) return [];
    return (items || []).filter(function (i) { return i.id !== itemId && i.category === me.category && i.active !== false; })
      .map(function (i) { return { item_id: i.id, name: i.name, unit: i.unit || "", available: Math.max(n(freeOf(i)), 0) }; })
      .filter(function (s) { return s.available > 0; })
      .sort(function (a, b) { return b.available - a.available; }).slice(0, limit || 5);
  }

  // headline: "Only 120 of 200 Chiavari chairs are available for 28 Dec"
  function headline(info, requested, fmt) {
    var f = fmt || function (d) { return d; };
    var when = info.event_date ? " for " + f(info.event_date) : " right now";
    if (n(info.available) <= 0) return "None of the " + n(info.total) + " " + info.item + " are available" + when + ".";
    return "Only " + n(info.available) + " of " + n(requested) + " " + info.item + " are available" + when + "." + (n(info.total) !== n(requested) ? " You own " + n(info.total) + "." : "");
  }
  // detail lines: who has the rest, reservations, repair
  function reasons(info, fmt) {
    var f = fmt || function (d) { return d; }, out = [];
    (info.blocking || []).forEach(function (b) {
      out.push(n(b.qty) + " out with " + b.event + (b.due_back ? " (due back " + f(b.due_back) + (b.overdue ? " - overdue" : "") + ")" : "") + (b.issued_to ? " - issued to " + b.issued_to : ""));
    });
    (info.reserved_by || []).forEach(function (r) { out.push(n(r.qty) + " reserved for " + r.event + " on the same day"); });
    if (n(info.in_repair) > 0) out.push(n(info.in_repair) + " in repair");
    return out;
  }
  // which actions to offer
  function actions(info, requested) {
    var a = [], free = n(info.available), req = n(requested);
    if (free > 0 && free < req) a.push({ key: "partial", label: "Check out the " + free + " available" });
    if ((info.overdue || []).length) a.push({ key: "checkin", label: "Check in returned items (" + info.overdue.length + " overdue)" });
    a.push({ key: "subrent", label: "Add from vendor / sub-rent " + Math.max(req - free, 0) });
    if (free > 0) a.push({ key: "reduce", label: "Reduce quantity to " + free });
    (info.substitutes || []).slice(0, 3).forEach(function (s) { a.push({ key: "sub", item_id: s.item_id, label: "Use " + s.name + " instead (" + n(s.available) + " free)" }); });
    return a;
  }
  // message for the shortfall record / vendor note
  function subrentNote(info, requested, fmt) {
    var f = fmt || function (d) { return d; }, short = Math.max(n(requested) - n(info.available), 0);
    return "Sub-rent / vendor: " + short + " " + info.item + (info.event_date ? " for " + f(info.event_date) : "") + " (have " + n(info.available) + " of " + n(requested) + ")";
  }

  var api = { compute: compute, substitutes: substitutes, headline: headline, reasons: reasons, actions: actions, subrentNote: subrentNote, stillOut: stillOut };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HelmCheckoutShortage = api;
})(typeof window !== "undefined" ? window : this);
