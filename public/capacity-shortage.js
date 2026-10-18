/* capacity-shortage.js (0197, owner 2026-10)
 * 1) HelmCapacity - a quote with more guests than its linked venue holds (seated + floating, e.g.
 *    40,000 + 10,000 = 50,000) needs a decision before it is sent, its PDF is made or the booking is
 *    confirmed: change venue (venues sorted by capacity), reduce guests, extend the space (an
 *    overflow tent / extra seating line from inventory or a vendor) or proceed anyway with a note.
 *    The decision is kept on the quote (set_quote_capacity_decision). The event workspace shows the
 *    over-capacity as an open issue until it is resolved, plus any open stock shortages.
 * 2) HelmShortage - "Reserve for this event" asking for more than is free: "Only 20 free - short by
 *    10", reserve the 20 and source the 10 (rent from a vendor -> vendor booking on the event, or
 *    outsource / buy, or leave it unsourced). Never over-commits stock.
 * Builds DOM nodes only (no HTML strings). Needs store-api.js (BPStore / BPUI). */
(function (global) {
  "use strict";
  var doc = global.document;
  var fmt = function (n) { return Math.round(Number(n) || 0).toLocaleString("en-IN"); };
  var money = function (n) { try { return global.BPStore && BPStore.studioMoney ? BPStore.studioMoney(n) : "₹" + fmt(n); } catch (e) { return "₹" + fmt(n); } };
  function h(tag, attrs, kids) {
    var el = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v === null || v === undefined || v === false) return;
      if (k === "text") el.textContent = String(v); else if (k === "cls") el.className = v; else el.setAttribute(k, v === true ? "" : String(v));
    });
    (kids || []).forEach(function (c) { if (c === null || c === undefined || c === false) return; el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return el;
  }
  function css() {
    if (!doc || doc.getElementById("capShortCss")) return;
    var l = doc.createElement("link"); l.id = "capShortCss"; l.rel = "stylesheet"; l.href = "/capacity-shortage.css?v=1";
    (doc.head || doc.documentElement).appendChild(l);
  }
  function toast(msg, type) { try { global.BPUI.toast(msg, { type: type || "info", timeout: 7000 }); } catch (e) {} }
  function friendly(e, action) { try { return global.BPUI.friendlyError(e, { action: action }); } catch (x) { return (e && e.message) || "Something went wrong."; } }
  function rpcMissing(e) { try { return !!(global.BPUI && BPUI.isRpcMissing && BPUI.isRpcMissing(e)); } catch (x) { return false; } }
  var $ = function (id) { return doc ? doc.getElementById(id) : null; };

  /* ------------------------------------------------------------------ pure helpers (unit-tested) */
  function capText(st) {
    if (!st) return "";
    if (st.seated && st.floating) return fmt(st.seated) + " seated + " + fmt(st.floating) + " floating = " + fmt(st.total);
    return fmt(st.total) + (st.seated ? " seated" : " floating");
  }
  function venueTotal(v) { return Math.max(0, Math.round(Number(v && v.seated_capacity) || 0)) + Math.max(0, Math.round(Number(v && v.floating_capacity) || 0)); }
  // active venues with a capacity, biggest first; fits = holds the guests
  function sortVenues(list, guests, exceptId) {
    var g = Number(guests) || 0;
    return (list || []).filter(function (v) { return v && v.active !== false && venueTotal(v) > 0 && v.id !== exceptId; })
      .map(function (v) { var t = venueTotal(v); return { venue: v, total: t, fits: t >= g }; })
      .sort(function (a, b) { return b.total - a.total || String(a.venue.name || "").localeCompare(String(b.venue.name || "")); });
  }
  var WHY = { send: "send the quote", pdf: "make the quote PDF", confirm: "confirm the booking", resolve: "go ahead" };
  function whyText(w) { return WHY[w] || WHY.resolve; }
  function headline(st) { return fmt(st.short) + " guest" + (st.short === 1 ? "" : "s") + " won't fit"; }
  function decisionPayload(choice, st, extra) {
    extra = extra || {};
    var p = { choice: choice, guests: Math.round(Number(extra.guests != null ? extra.guests : st.guests) || 0), capacity: st.total,
      venue_id: (extra.venue && extra.venue.id) || (st.venue && st.venue.id) || null, venue_name: (extra.venue && extra.venue.name) || (st.venue && st.venue.name) || null };
    if (extra.note) p.note = String(extra.note).trim().slice(0, 1000);
    if (choice === "venue" && extra.venue) p.capacity = venueTotal(extra.venue);
    if (choice === "extend") { p.extra_capacity = Math.round(Number(extra.extra) || 0); p.line = extra.line; }
    return p;
  }
  function split(qty, free) { var q = Math.max(0, Math.round(Number(qty) || 0)), f = Math.max(0, Math.floor(Number(free) || 0)); var take = Math.min(q, f); return { take: take, short: q - take }; }
  // vendors whose category / services match the item's category first, then the rest
  function vendorsFor(vendors, item) {
    var cat = String((item && item.category) || "").trim().toLowerCase();
    var act = (vendors || []).filter(function (v) { return v && v.active !== false; });
    if (!cat) return { matched: [], others: act };
    var hit = function (v) {
      var vc = String(v.category || "").toLowerCase();
      var sv = Array.isArray(v.services) ? v.services.map(function (s) { return String(s || "").toLowerCase(); }) : [];
      return (vc && (vc.indexOf(cat) >= 0 || cat.indexOf(vc) >= 0)) || sv.some(function (s) { return s && (s.indexOf(cat) >= 0 || cat.indexOf(s) >= 0); });
    };
    return { matched: act.filter(hit), others: act.filter(function (v) { return !hit(v); }) };
  }
  function shortHeadline(item, free, short, dateText) {
    var u = (item && item.unit) ? " " + item.unit : "";
    var on = dateText ? " on " + dateText : "";
    return (free > 0 ? "Only " + fmt(free) + u + " free" + on : "Nothing free" + on) + " — short by " + fmt(short);
  }

  /* ------------------------------------------------------------------ data */
  var _venues = null, _venuesAt = 0;
  function venuesAll() {
    var S = global.BPStore;
    if (!S || !S.venues) return Promise.resolve([]);
    if (_venues && Date.now() - _venuesAt < 60000) return _venues;
    _venuesAt = Date.now();
    _venues = S.venues.list({ all: true }).catch(function (e) { _venues = null; throw e; });
    return _venues;
  }
  function isFlow() { return !!($("v_venue_id") && $("c_guests") && $("q_other")); }
  function flowGuests() { var g = $("c_guests"); var n = g && g.value !== "" ? Math.round(Number(g.value)) : null; return n > 0 ? n : null; }
  function setField(id, v) { var el = $(id); if (!el) return false; el.value = String(v); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); return true; }

  // current over-capacity status of a quote (flow: the page's guests + linked venue)
  async function statusFor(o) {
    var S = global.BPStore; o = o || {};
    if (!S || !S.capacityStatus) return { over: false };
    var q = o.quote || {}, flow = o.flow != null ? o.flow : isFlow();
    var vid = flow ? (($("v_venue_id") || {}).value || null) : ((q.client || {}).venueId || null);
    if (!vid) return { over: false };
    var list = await venuesAll();
    var venue = (list || []).filter(function (v) { return v.id === vid; })[0];
    if (!venue) return { over: false };
    var st = S.capacityStatus(q, venue, flow ? flowGuests() : null);
    st.venues = list; return st;
  }

  /* ------------------------------------------------------------------ the decision dialog */
  function openDialog(o) {
    css();
    var st = o.st, q = o.quote || {}, qid = o.quoteId || q.id, S = global.BPStore, flow = !!o.flow;
    return new Promise(function (resolve) {
      var done = false;
      var err = h("p", { cls: "capd-err", role: "alert", hidden: true });
      function fail(m) { err.textContent = m; err.hidden = false; }
      function close(v) { if (done) return; done = true; if (ov.parentNode) ov.parentNode.removeChild(ov); resolve(v); }
      var opt = function (val, title, sub, more) {
        var r = h("input", { type: "radio", name: "capd_choice", value: val, id: "capd_r_" + val });
        var lab = h("label", { cls: "capd-opt", "for": "capd_r_" + val }, [r, h("span", { cls: "capd-ot" }, [h("b", { text: title }), h("span", { cls: "capd-os", text: sub })])]);
        var box = h("div", { cls: "capd-more", "data-for": val, hidden: true }, more || []);
        return h("div", { cls: "capd-row" }, [lab, box]);
      };
      // (a) change venue
      var sorted = sortVenues(st.venues, st.guests, st.venue && st.venue.id);
      var vsel = h("select", { id: "capd_venue", "aria-label": "Venue to move to" }, [h("option", { value: "", text: sorted.length ? "Pick a venue (largest first)" : "No other saved venues" })]
        .concat(sorted.map(function (x) { return h("option", { value: x.venue.id, text: x.venue.name + " — " + fmt(x.total) + (x.fits ? " (fits)" : " (short by " + fmt(st.guests - x.total) + ")") }); })));
      var openFlow = function (hash) { return h("a", { cls: "capd-link", href: "flow.html?id=" + encodeURIComponent(qid || "") + hash, text: "Open the quote to change it →" }); };
      var aMore = flow ? [h("label", { "for": "capd_venue", cls: "capd-lbl", text: "Move to" }), vsel] : [openFlow("#sec-venue")];
      // (b) reduce guests
      var gIn = h("input", { id: "capd_guests", type: "number", min: "1", max: String(st.total), step: "1", value: String(st.total) });
      var bMore = flow ? [h("label", { "for": "capd_guests", cls: "capd-lbl", text: "Guests (this venue holds " + fmt(st.total) + ")" }), gIn] : [openFlow("#sec-client")];
      // (c) extend the space
      var what = h("select", { id: "capd_what", "aria-label": "Kind of extra space" }, [["Overflow tent", "Tent / canopy"], ["Extra seating area", "Extra seating"], ["Overflow hall / area", "Overflow hall / area"], ["", "Other"]]
        .map(function (x) { return h("option", { value: x[0], text: x[1] }); }));
      var lbl = h("input", { id: "capd_label", maxlength: "200", value: "Overflow tent", "aria-label": "Name on the quote" });
      what.addEventListener("change", function () { if (what.value) lbl.value = what.value; else { lbl.value = ""; lbl.focus(); } });
      var extra = h("input", { id: "capd_extra", type: "number", min: "1", step: "1", value: String(st.short) });
      var qty = h("input", { id: "capd_qty", type: "number", min: "1", step: "1", value: "1" });
      var rate = h("input", { id: "capd_rate", type: "number", min: "0", step: "1", value: "", placeholder: "0" });
      var src = h("select", { id: "capd_src" }, [["later", "Decide later"], ["inventory", "From our inventory"], ["vendor", "From a vendor"]].map(function (x) { return h("option", { value: x[0], text: x[1] }); }));
      var itemSel = h("select", { id: "capd_item", "aria-label": "Inventory item", hidden: true }, [h("option", { value: "", text: "Loading items…" })]);
      var vendSel = h("select", { id: "capd_vendor", "aria-label": "Vendor", hidden: true }, [h("option", { value: "", text: "Loading vendors…" })]);
      var amt = h("p", { cls: "capd-hint", "aria-live": "polite" });
      var items = [], vendors = [];
      function paintAmt() {
        var a = Math.max(0, Math.round(Number(qty.value) || 0)) * Math.max(0, Number(rate.value) || 0);
        amt.textContent = (a > 0 ? "Adds " + money(a) + (flow ? " to Décor / equipment & setup on this quote" : " (add it to the quotation)") : "No charge added")
          + (src.value === "vendor" ? " · a vendor booking is added to this event (Budget & margin)." : src.value === "inventory" ? " · the items are reserved for this event." : ".");
      }
      [qty, rate].forEach(function (x) { x.addEventListener("input", paintAmt); });
      src.addEventListener("change", function () { itemSel.hidden = src.value !== "inventory"; vendSel.hidden = src.value !== "vendor"; paintAmt(); });
      var cGrid = h("div", { cls: "capd-grid" }, [
        h("div", { cls: "capd-f" }, [h("label", { "for": "capd_what", cls: "capd-lbl", text: "What" }), what]),
        h("div", { cls: "capd-f" }, [h("label", { "for": "capd_label", cls: "capd-lbl", text: "Name on the quote" }), lbl]),
        h("div", { cls: "capd-f" }, [h("label", { "for": "capd_extra", cls: "capd-lbl", text: "Extra guests it holds" }), extra]),
        h("div", { cls: "capd-f" }, [h("label", { "for": "capd_qty", cls: "capd-lbl", text: "Quantity" }), qty]),
        h("div", { cls: "capd-f" }, [h("label", { "for": "capd_rate", cls: "capd-lbl", text: "Rate per unit" }), rate]),
        h("div", { cls: "capd-f" }, [h("label", { "for": "capd_src", cls: "capd-lbl", text: "Comes from" }), src, itemSel, vendSel])]);
      // (d) proceed anyway
      var note = h("textarea", { id: "capd_note", rows: "3", maxlength: "1000", placeholder: "e.g. Client accepts standing room for the extra guests" });
      var form = h("form", { cls: "capd-sheet", novalidate: true }, [
        h("div", { cls: "capd-hd" }, [h("h3", { id: "capd_t", text: headline(st) }), h("button", { type: "button", cls: "capd-x", "data-close": true, "aria-label": "Close", text: "×" })]),
        h("p", { cls: "capd-sub", id: "capd_d", text: (st.venue && st.venue.name ? st.venue.name : "This venue") + " holds " + capText(st) + ". This quote has " + fmt(st.guests)
          + " guests. Choose how to resolve it" + (o.why && o.why !== "resolve" ? " before you " + whyText(o.why) : "") + ":" }),
        h("div", { cls: "capd-opts", role: "radiogroup", "aria-labelledby": "capd_t" }, [
          opt("venue", "Change venue", "Pick another saved venue that fits", aMore),
          opt("reduce", "Reduce guest count", "Bring the guests down to what the venue holds", bMore),
          opt("extend", "Extend the space", "Add an overflow area, tent or extra seating as a line item", [cGrid, amt]),
          opt("proceed", "Proceed anyway with a note", "The note is recorded on the quote", [h("label", { "for": "capd_note", cls: "capd-lbl", text: "Note (why it is fine)" }), note])]),
        err,
        h("div", { cls: "capd-foot" }, [h("button", { type: "button", cls: "btn", "data-close": true, text: "Cancel" }), h("button", { type: "submit", cls: "btn primary", id: "capd_go", text: "Apply" })])]);
      var ov = h("div", { cls: "capd-ov", role: "dialog", "aria-modal": "true", "aria-labelledby": "capd_t", "aria-describedby": "capd_d" }, [form]);
      function choice() { var r = form.querySelector('input[name="capd_choice"]:checked'); return r ? r.value : ""; }
      form.addEventListener("change", function (e) {
        if (!e.target || e.target.name !== "capd_choice") return;
        err.hidden = true;
        Array.prototype.forEach.call(form.querySelectorAll(".capd-more"), function (b) { b.hidden = b.getAttribute("data-for") !== choice(); });
        if (choice() === "extend") paintAmt();
      });
      Array.prototype.forEach.call(form.querySelectorAll("[data-close]"), function (b) { b.addEventListener("click", function () { close(false); }); });
      ov.addEventListener("mousedown", function (e) { if (e.target === ov) close(false); });

      // inventory items + vendors for "Extend the space" (best-effort)
      Promise.all([S.inventory.items(false).catch(function () { return []; }), (S.vendors && S.vendors.listAll ? S.vendors.listAll(false) : Promise.resolve([])).catch(function () { return []; })]).then(function (r) {
        items = r[0] || []; vendors = r[1] || [];
        var tents = items.filter(function (i) { return /tent|canopy|shamiana|pandal|seating|chair/i.test(String(i.category || "") + " " + String(i.name || "")); });
        var rest = items.filter(function (i) { return tents.indexOf(i) < 0; });
        itemSel.textContent = "";
        itemSel.appendChild(h("option", { value: "", text: items.length ? "Pick an item" : "No inventory items yet" }));
        [[tents, "Tents & seating"], [rest, "Other items"]].forEach(function (g) { if (!g[0].length) return;
          itemSel.appendChild(h("optgroup", { label: g[1] }, g[0].map(function (i) { return h("option", { value: i.id, text: i.name + (i.unit ? " (" + i.unit + ")" : "") }); }))); });
        vendSel.textContent = "";
        vendSel.appendChild(h("option", { value: "", text: vendors.length ? "Pick a vendor" : "No vendors yet - add one under Partners" }));
        vendors.forEach(function (v) { vendSel.appendChild(h("option", { value: v.id, text: v.name + (v.category ? " · " + v.category : "") })); });
      });
      itemSel.addEventListener("change", function () { var it = items.filter(function (i) { return i.id === itemSel.value; })[0]; if (it && !lbl.value) lbl.value = it.name; });

      form.addEventListener("submit", function (e) {
        e.preventDefault(); err.hidden = true;
        var c = choice(); if (!c) return fail("Choose one of the four options.");
        var go = $("capd_go"); if (go.disabled) return; go.disabled = true;
        apply(c).then(function (v) { if (v !== undefined) close(v); }, function (x) { fail(friendly(x, "save the decision")); }).then(function () { go.disabled = false; });
      });

      async function record(payload) {
        try { var d = await S.quotes.setCapacityDecision(qid, payload); q.capacityDecision = d || payload; return true; }
        catch (x) {
          if (rpcMissing(x)) { q.capacityDecision = payload; toast("Kept for this session only - the database update 0197 is not installed yet.", "info"); return true; }
          throw x;
        }
      }
      async function apply(c) {
        if (c === "venue") {
          if (!flow) { global.location.href = "flow.html?id=" + encodeURIComponent(qid || "") + "#sec-venue"; return false; }
          var pick = sorted.filter(function (x) { return x.venue.id === vsel.value; })[0];
          if (!pick) { fail("Pick the venue to move to."); vsel.focus(); return undefined; }
          var ps = $("vp_pick"), has = ps && Array.prototype.some.call(ps.options, function (op) { return op.value === pick.venue.id; });
          if (!has) { fail("That venue is not in the venue list of this quote - pick it in step 4 (Venue)."); return undefined; }
          ps.value = pick.venue.id; ps.dispatchEvent(new Event("change", { bubbles: true }));
          try { await record(decisionPayload("venue", st, { venue: pick.venue })); } catch (x) { /* the venue change itself is what matters */ }
          toast("Venue changed to " + pick.venue.name + " (holds " + fmt(pick.total) + ")" + (pick.fits ? "" : " - still " + fmt(st.guests - pick.total) + " short") + ". Check step 4, then " + whyText(o.why) + " again.", pick.fits ? "ok" : "info");
          return false;
        }
        if (c === "reduce") {
          if (!flow) { global.location.href = "flow.html?id=" + encodeURIComponent(qid || "") + "#sec-client"; return false; }
          var n = Math.round(Number(gIn.value));
          if (!(n >= 1) || n !== Number(gIn.value)) { fail("Enter the new guest count as a whole number."); gIn.focus(); return undefined; }
          if (n > st.total) { fail("That is still more than the " + fmt(st.total) + " this venue holds."); gIn.focus(); return undefined; }
          setField("c_guests", n);
          try { await record(decisionPayload("reduce", st, { guests: n })); } catch (x) { /* the guest change itself is what matters */ }
          toast("Guests reduced to " + fmt(n) + ". Check the quotation (plates / chairs), then " + whyText(o.why) + " again.", "ok");
          return false;
        }
        if (c === "proceed") {
          var t = String(note.value || "").trim();
          if (t.length < 5) { fail("Add a short note (at least 5 characters) - it is recorded on the quote."); note.focus(); return undefined; }
          await record(decisionPayload("proceed", st, { note: t }));
          toast("Recorded: proceeding with " + fmt(st.guests) + " guests at " + (st.venue && st.venue.name || "this venue") + ".", "ok");
          return true;
        }
        // extend
        var ex = Math.round(Number(extra.value)), qn = Math.round(Number(qty.value)), rt = rate.value === "" ? 0 : Number(rate.value);
        var label = String(lbl.value || "").trim();
        if (!label) { fail("Name the extra space (e.g. Overflow tent)."); lbl.focus(); return undefined; }
        if (!(ex >= 1) || ex !== Number(extra.value)) { fail("Enter how many extra guests the space holds (a whole number)."); extra.focus(); return undefined; }
        if (ex < st.short) { fail("It must hold at least " + fmt(st.short) + " more guests, or choose another option."); extra.focus(); return undefined; }
        if (!(qn >= 1) || qn !== Number(qty.value)) { fail("Quantity must be a whole number."); qty.focus(); return undefined; }
        if (!(rt >= 0) || !isFinite(rt)) { fail("Rate must be 0 or more."); rate.focus(); return undefined; }
        var line = { label: label, qty: qn, rate: Math.round(rt * 100) / 100, source: src.value };
        if (src.value === "inventory") {
          if (!itemSel.value) { fail("Pick the inventory item."); itemSel.focus(); return undefined; }
          var av = {}; try { av = await S.inventory.availability(qid); } catch (x) { av = {}; }
          var a = av[itemSel.value] || {}, free = Math.floor(Number(a.availableOnEvent != null ? a.availableOnEvent : a.available) || 0);
          if (qn > free) { fail("Only " + fmt(Math.max(free, 0)) + " " + (a.name || "of this item") + " free on this date - pick a vendor for the rest."); return undefined; }
          line.item_id = itemSel.value;
        }
        if (src.value === "vendor") { if (!vendSel.value) { fail("Pick the vendor."); vendSel.focus(); return undefined; } line.vendor_id = vendSel.value; }
        await record(decisionPayload("extend", st, { extra: ex, line: line }));
        var amount = Math.round(qn * line.rate * 100) / 100, bits = [];
        if (src.value === "inventory") {
          try { await S.inventory.reserve(line.item_id, qid, qn, "Over-capacity: " + label); bits.push("reserved " + fmt(qn) + " from inventory"); }
          catch (x) { toast(friendly(x, "reserve the item"), "err"); }
        }
        if (src.value === "vendor") {
          var vv = vendors.filter(function (v) { return v.id === line.vendor_id; })[0] || {};
          try { await S.bookings.add(qid, { vendor_id: line.vendor_id, kind: vv.kind || null, label: (label + " - overflow space (+" + ex + " guests)").slice(0, 500), qty: qn,
              cost: amount > 0 ? amount : null, status: "enquiry", note: ("Over-capacity: " + st.guests + " guests vs " + st.total + " at " + (st.venue && st.venue.name || "the venue") + ".").slice(0, 2000) });
            bits.push("vendor booking added for " + (vv.name || "the vendor")); }
          catch (x) { toast(friendly(x, "add the vendor booking"), "err"); }
        }
        if (flow && amount > 0) {
          var oth = $("q_other"); setField("q_other", Math.round(((Number(oth && oth.value) || 0) + amount) * 100) / 100);
          bits.push("added " + money(amount) + " to Décor / equipment & setup");
          toast("Space extended by " + fmt(ex) + " guests (" + label + ")" + (bits.length ? ": " + bits.join(", ") : "") + ". Save the quotation (new version), then " + whyText(o.why) + " again.", "ok");
          return false;
        }
        toast("Space extended by " + fmt(ex) + " guests (" + label + ")" + (bits.length ? ": " + bits.join(", ") : "") + "."
          + (amount > 0 && !flow ? " Add " + money(amount) + " for it to the quotation." : ""), "ok");
        return !(amount > 0 && !flow) || o.why === "resolve";
      }

      doc.body.appendChild(ov);
      setTimeout(function () { var f = form.querySelector('input[name="capd_choice"]'); if (f) f.focus(); }, 0);
    });
  }

  // gate({ quoteId, quote, why: "send" | "pdf" | "confirm" }) -> Promise<boolean> (true = go ahead)
  async function gate(o) {
    o = o || {};
    var st;
    try { st = await statusFor({ quote: o.quote, flow: o.flow }); } catch (e) { return true; }   // venues unreadable: the venue warning still shows; never block on a read failure
    if (!st || !st.over || st.resolved) return true;
    return openDialog({ st: st, quote: o.quote, quoteId: o.quoteId, why: o.why, flow: o.flow != null ? o.flow : isFlow() });
  }

  /* ------------------------------------------------------------------ event workspace: open issues */
  async function mountIssues(host, o) {
    if (!host) return; o = o || {}; css();
    var S = global.BPStore, q = o.quote || {}, qid = o.quoteId || q.id;
    var st = { over: false }, shorts = [], items = [], vend = [], bks = [];
    try { st = await statusFor({ quote: q, flow: false }); } catch (e) { st = { over: false }; }
    try {
      var r = await Promise.all([S.inventory.shortages(qid), S.inventory.items(true).catch(function () { return []; }), S.bookings.list(qid).catch(function () { return []; })]);
      shorts = r[0] || []; items = r[1] || []; bks = r[2] || [];
      if (shorts.some(function (x) { return x.vendor_id; }) && S.vendors && S.vendors.listAll) vend = await S.vendors.listAll(true).catch(function () { return []; });
    } catch (e) { shorts = []; }
    host.textContent = "";
    if (st.over) {
      if (!st.resolved) {
        var acts = [];
        if (o.canEdit) { var b = h("button", { type: "button", cls: "btn sm", text: "Resolve…" });
          b.addEventListener("click", function () { openDialog({ st: st, quote: q, quoteId: qid, why: "resolve", flow: false }).then(function () { mountIssues(host, o); }); });
          acts.push(b); }
        host.appendChild(h("div", { cls: "capi capi-bad", role: "status" }, [h("b", { text: "⚠ " + headline(st) + " at " + (st.venue.name || "the venue") }),
          h("span", { cls: "capi-d", text: "It holds " + capText(st) + "; this event has " + fmt(st.guests) + " guests. Change venue, reduce guests, extend the space or proceed with a note." }), h("span", { cls: "capi-a" }, acts)]));
      } else {
        var d = st.decision || {};
        var when = d.decided_at ? new Date(d.decided_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "";
        host.appendChild(h("div", { cls: "capi capi-ok", role: "status" }, [h("b", { text: "Over capacity, resolved" }),
          h("span", { cls: "capi-d", text: d.choice === "extend"
            ? "Extended: " + ((d.line && d.line.label) || "extra space") + " for +" + fmt(d.extra_capacity) + " guests (" + fmt(st.guests) + " vs " + fmt(st.total) + ")" + (when ? " · " + when : "")
            : "Proceeding with " + fmt(st.guests) + " guests (venue holds " + fmt(st.total) + ")" + (d.note ? ": “" + d.note + "”" : "") + (when ? " · " + when : "") })]));
      }
    }
    if (shorts.length) {
      var lines = shorts.map(function (x) {
        var it = items.filter(function (i) { return i.id === x.item_id; })[0], v = vend.filter(function (w) { return w.id === x.vendor_id; })[0], bk = bks.filter(function (w) { return w.id === x.booking_id; })[0];
        return h("li", { cls: x.source === "vendor" || x.source === "buy" ? "" : "capi-uns", text: S.shortageText(x, { itemName: it && it.name, vendorName: v && v.name, bookingStatus: bk && bk.status }) });
      });
      var uns = shorts.filter(function (x) { return x.source !== "vendor" && x.source !== "buy"; }).length;
      host.appendChild(h("div", { cls: "capi " + (uns ? "capi-bad" : "capi-warn"), role: "status" }, [h("b", { text: "📦 Stock shortages (" + shorts.length + ")" + (uns ? " · " + uns + " unsourced" : "") }),
        h("ul", { cls: "capi-l" }, lines), h("a", { cls: "capi-a btn sm", href: "inventory.html?quote=" + encodeURIComponent(qid || ""), text: "Open inventory →" })]));
    }
  }

  /* ------------------------------------------------------------------ inventory: shortage panel */
  // showPanel(host, { item, qty, free, quoteId, dateText, note, onDone }) - renders in host (inline, not a modal)
  function showPanel(host, o) {
    if (!host) return; css();
    var S = global.BPStore, it = o.item || {}, sp = split(o.qty, o.free);
    host.textContent = ""; host.hidden = false;
    var vendors = [];
    var rName = "rvs_" + Math.random().toString(36).slice(2, 7);
    var radio = function (val, txt, checked) { var r = h("input", { type: "radio", name: rName, value: val, id: rName + val, checked: checked });
      return h("label", { cls: "rvs-opt", "for": rName + val }, [r, h("span", { text: txt })]); };
    var vSel = h("select", { id: "rvs_vendor", "aria-label": "Vendor to rent from" }, [h("option", { value: "", text: "Loading vendors…" })]);
    var rate = h("input", { id: "rvs_rate", type: "number", min: "0", step: "1", placeholder: "Rate per unit", "aria-label": "Vendor rate per unit" });
    var vNote = h("input", { id: "rvs_vnote", maxlength: "300", placeholder: "Note for the vendor (optional)", "aria-label": "Note for the vendor" });
    var bNote = h("input", { id: "rvs_bnote", maxlength: "300", placeholder: "Where / how (optional)", "aria-label": "Outsource or buy note" });
    var cost = h("span", { cls: "rvs-hint", "aria-live": "polite" });
    rate.addEventListener("input", function () { var r = Number(rate.value); cost.textContent = r > 0 ? "Vendor cost " + money(sp.short * r) + " (" + fmt(sp.short) + " × " + money(r) + ")" : ""; });
    var vBox = h("div", { cls: "rvs-more", "data-for": "vendor" }, [vSel, rate, vNote, cost,
      h("p", { cls: "rvs-hint", text: "Adds a vendor booking (enquiry) on this event" + (o.dateText ? " for " + o.dateText : "") + " - it shows in Budget & margin and the vendor's history." })]);
    var bBox = h("div", { cls: "rvs-more", "data-for": "buy", hidden: true }, [bNote]);
    var err = h("p", { cls: "rvs-err", role: "alert", hidden: true });
    var go = h("button", { type: "button", cls: "btn primary", text: sp.take > 0 ? "Reserve " + fmt(sp.take) + " + source " + fmt(sp.short) : "Record the shortage of " + fmt(sp.short) });
    var cancel = h("button", { type: "button", cls: "btn", text: "Cancel" });
    host.appendChild(h("h3", { text: shortHeadline(it, sp.take, sp.short, o.dateText) }));
    host.appendChild(h("p", { cls: "rvs-sub", text: (sp.take > 0 ? "Reserve the " + fmt(sp.take) + " free " + (it.name || "") + " and source the other " + fmt(sp.short) + ":" : "Source all " + fmt(sp.short) + " " + (it.name || "") + ":") }));
    var opts = h("div", { cls: "rvs-opts", role: "radiogroup", "aria-label": "How to source the shortfall" }, [
      radio("vendor", "Rent " + fmt(sp.short) + " from a vendor", true), vBox,
      radio("buy", "Outsource / buy " + fmt(sp.short)), bBox,
      radio("none", sp.take > 0 ? "Reserve the " + fmt(sp.take) + " only - mark " + fmt(sp.short) + " as unsourced" : "Mark " + fmt(sp.short) + " as unsourced for now")]);
    host.appendChild(opts); host.appendChild(err);
    host.appendChild(h("div", { cls: "rvs-acts" }, [go, cancel]));
    function choice() { var r = opts.querySelector('input[name="' + rName + '"]:checked'); return r ? r.value : "none"; }
    opts.addEventListener("change", function () { vBox.hidden = choice() !== "vendor"; bBox.hidden = choice() !== "buy"; err.hidden = true; });
    function hide() { host.hidden = true; host.textContent = ""; }
    cancel.addEventListener("click", function () { hide(); if (o.onCancel) o.onCancel(); });
    (S.vendors && S.vendors.listAll ? S.vendors.listAll(false) : Promise.resolve([])).catch(function () { return []; }).then(function (list) {
      vendors = list || []; var g = vendorsFor(vendors, it);
      vSel.textContent = "";
      vSel.appendChild(h("option", { value: "", text: vendors.length ? "Pick a vendor" : "No vendors yet - add one under Partners" }));
      if (g.matched.length) vSel.appendChild(h("optgroup", { label: "Matches " + (it.category || "this item") }, g.matched.map(function (v) { return h("option", { value: v.id, text: v.name + (v.category ? " · " + v.category : "") }); })));
      if (g.others.length) vSel.appendChild(h("optgroup", { label: g.matched.length ? "Other vendors" : "Vendors" }, g.others.map(function (v) { return h("option", { value: v.id, text: v.name + (v.category ? " · " + v.category : "") }); })));
      if (g.matched.length === 1) vSel.value = g.matched[0].id;
    });
    go.addEventListener("click", function () {
      var c = choice(), args = { source: c };
      if (c === "vendor") {
        if (!vSel.value) { err.textContent = "Pick the vendor to rent from (or choose another option)."; err.hidden = false; vSel.focus(); return; }
        if (rate.value !== "" && !(Number(rate.value) >= 0)) { err.textContent = "Rate must be 0 or more."; err.hidden = false; rate.focus(); return; }
        var v = vendors.filter(function (x) { return x.id === vSel.value; })[0] || {};
        args.vendorId = vSel.value; args.vendorName = v.name; args.rate = rate.value === "" ? null : Number(rate.value); args.sourceNote = vNote.value.trim() || null;
      } else if (c === "buy") args.sourceNote = bNote.value.trim() || null;
      var run = function () {
        return S.inventory.reserveWithSourcing(it.id, o.quoteId, o.qty, o.note || null, args).then(function (r) {
          r = r || {};
          var msg = (Number(r.reserved) > 0 ? "Reserved " + fmt(r.reserved) + ". " : "") + (Number(r.short) > 0
            ? "Short " + fmt(r.short) + " - " + (r.source === "vendor" ? "sourcing from " + (args.vendorName || "the vendor") + " (vendor booking added)" : r.source === "buy" ? "outsource / buy" : "unsourced") + "."
            : "Everything fitted after all.");
          toast(msg, "ok"); hide(); if (o.onDone) return o.onDone(r);
        }, function (e) { err.textContent = friendly(e, "reserve and source the item"); err.hidden = false; });
      };
      if (global.BPUI && BPUI.guard) BPUI.guard(go, run); else run();
    });
    setTimeout(function () { try { host.scrollIntoView({ block: "nearest" }); } catch (e) {} var f = opts.querySelector("input"); if (f) f.focus(); }, 0);
  }

  // open shortages of one event under the reservations table, with a status per row
  async function renderList(host, o) {
    if (!host) return; o = o || {}; css();
    var S = global.BPStore, rows = [], vend = [], bks = [];
    try { rows = await S.inventory.shortages(o.quoteId); } catch (e) { rows = []; }
    host.textContent = "";
    if (!rows.length) { host.hidden = true; return; }
    try { var r = await Promise.all([S.vendors && S.vendors.listAll ? S.vendors.listAll(true).catch(function () { return []; }) : [], S.bookings.list(o.quoteId).catch(function () { return []; })]); vend = r[0] || []; bks = r[1] || []; } catch (e) {}
    host.hidden = false;
    host.appendChild(h("h3", { text: "Shortages on this event (" + rows.length + ")" }));
    var ul = h("ul", { cls: "rvs-list" });
    rows.forEach(function (x) {
      var it = (o.items || []).filter(function (i) { return i.id === x.item_id; })[0], v = vend.filter(function (w) { return w.id === x.vendor_id; })[0], bk = bks.filter(function (w) { return w.id === x.booking_id; })[0];
      var li = h("li", { cls: x.source === "vendor" || x.source === "buy" ? "" : "rvs-uns" }, [h("span", { text: S.shortageText(x, { itemName: it && it.name, vendorName: v && v.name, bookingStatus: bk && bk.status }) })]);
      if (o.canEdit) {
        var sel = h("select", { "aria-label": "Shortage status" }, [["requested", "Open"], ["issued", "Sourced / arrived"], ["cancelled", "Not needed"]].map(function (s) { return h("option", { value: s[0], text: s[1] }); }));
        sel.addEventListener("change", function () {
          var nv = sel.value; sel.disabled = true;
          S.stockreq.setStatus(x.id, nv).then(function () { toast(nv === "issued" ? "Marked sourced." : "Marked not needed.", "ok"); return renderList(host, o); },
            function (e) { sel.value = "requested"; sel.disabled = false; toast(friendly(e, "update the shortage"), "err"); });
        });
        li.appendChild(sel);
      }
      ul.appendChild(li);
    });
    host.appendChild(ul);
  }

  global.HelmCapacity = { capText: capText, venueTotal: venueTotal, sortVenues: sortVenues, whyText: whyText, headline: headline, decisionPayload: decisionPayload,
    statusFor: statusFor, gate: gate, openDialog: openDialog, mountIssues: mountIssues, _resetCache: function () { _venues = null; } };
  global.HelmShortage = { split: split, vendorsFor: vendorsFor, headline: shortHeadline, showPanel: showPanel, renderList: renderList };
  // the quote flow: read the venues early so the first "Send for approval" / PDF click answers at once
  try { if (doc && isFlow()) setTimeout(function () { var S = global.BPStore; if (S && S.auth && S.auth.user && S.auth.user()) venuesAll().catch(function () {}); }, 1500); } catch (e) {}
})(typeof window !== "undefined" ? window : globalThis);
