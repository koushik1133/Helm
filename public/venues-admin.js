/* venues-admin.js (0085) - Control Center -> Venues tab. List + search / filters, add / edit,
 * deactivate / re-activate (never delete), m / ft toggle, admin "Load sample venues" (adds only missing samples).
 * DOM nodes only (no HTML strings). Server enforces everything again (venue_save etc.). */
(function () {
  "use strict";
  var V = window.HelmVenues, S = window.BPStore;
  var tab = document.getElementById("tab-venues"), pane = document.getElementById("pane-venues"), root = document.getElementById("vn_root");
  if (!V || !S || !tab || !pane || !root) return;

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v === undefined || v === null || v === false) return;
      if (k === "text") el.textContent = v; else if (k === "cls") el.className = v;
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return el;
  }
  function opts(list, cur, blank) {
    var o = blank ? [h("option", { value: "", text: blank })] : [];
    return o.concat(list.map(function (x) { return h("option", { value: x[0], text: x[1], selected: x[0] === cur }); }));
  }
  function friendly(e) { try { return (window.BPUI && BPUI.friendlyError) ? BPUI.friendlyError(e, { action: "save the venue" }) : String(e && e.message || e); } catch (_) { return String(e && e.message || e); } }

  var state = { rows: [], canEdit: false, isAdmin: false, unit: "m", q: "", type: "", city: "", ac: "", ev: "", inactive: false, editing: null, msg: "", err: "" };
  try { state.unit = localStorage.getItem("helm.venues.unit") === "ft" ? "ft" : "m"; } catch (_) {}

  async function init() {
    var role = await S.auth.role();
    state.isAdmin = role === "admin";
    var canView = state.isAdmin || await S.auth.canView("venues");
    if (!canView) return;
    state.canEdit = state.isAdmin || (S.auth.canEditArea ? await S.auth.canEditArea("venues") : false);
    tab.hidden = false;
  }
  var loaded = false;
  // 1018: every visit starts with the filters on "Any" - a filter left over from an earlier visit (or put back by the
  // browser's form restore / autofill) silently hid venues (owner saw 1 of 4 with Banquet hall / Hyderabad / AC / Wedding set)
  function resetFilters() { state.q = ""; state.type = ""; state.city = ""; state.ac = ""; state.ev = ""; state.inactive = false; }
  function filtersOn() { return !!(state.q.trim() || state.type || state.city || state.ac || state.ev); }
  async function open() {
    resetFilters();
    if (loaded) { if (!state.editing) render(); return; }
    loaded = true;
    await reload();
  }
  async function reload() {
    try { state.rows = await S.venues.list({ all: true }); state.err = ""; }
    catch (e) { state.rows = []; state.err = friendly(e); }
    render();
  }

  // Filters (sweep B): spaces / case never matter ("  Hyderabad " = "hyderabad"); a search of several words
  // finds venues that contain EVERY word, in any field and any order; a city that no longer exists (venue
  // edited or deactivated) stops filtering instead of silently hiding every venue. Search capped at 100 chars.
  function ckey(s) { return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().toLowerCase(); }
  function filtered() {
    var toks = ckey(state.q).slice(0, 100).split(" ").filter(Boolean);
    var ck = ckey(state.city);
    if (ck && !state.rows.some(function (v) { return ckey(v.city) === ck; })) { state.city = ""; ck = ""; }
    return state.rows.filter(function (v) {
      if (!state.inactive && !v.active) return false;
      if (state.type && v.venue_type !== state.type) return false;
      if (state.ac && v.ac_type !== state.ac) return false;
      if (ck && ckey(v.city) !== ck) return false;
      if (state.ev && (v.event_types || []).indexOf(state.ev) < 0) return false;
      if (toks.length) {
        var hay = ckey([v.name, v.city, v.address, v.notes].join(" "));
        for (var i = 0; i < toks.length; i++) if (hay.indexOf(toks[i]) < 0) return false;
      }
      return true;
    });
  }
  // one entry per city whatever its spacing / case (first spelling seen wins), sorted A-Z
  function cities() {
    var seen = {}; state.rows.forEach(function (v) { var k = ckey(v.city); if (k && !seen[k]) seen[k] = String(v.city).replace(/\s+/g, " ").trim(); });
    return Object.keys(seen).map(function (k) { return seen[k]; }).sort(function (a, b) { return a.localeCompare(b); }).map(function (c) { return [c, c]; });
  }

  function render() {
    root.textContent = "";
    if (state.err) root.appendChild(h("div", { cls: "msg err", role: "alert", text: state.err }));
    if (state.msg) root.appendChild(h("div", { cls: "msg ok", role: "status", text: state.msg }));
    if (state.editing) { root.appendChild(form(state.editing)); return; }
    var bar = h("div", { cls: "vn-tools" }, [
      h("input", { type: "search", id: "vn_q", placeholder: "Search venues", "aria-label": "Search venues", value: state.q, autocomplete: "off",
        oninput: function (e) { state.q = e.target.value; paintList(); } }),
      sel("vn_f_type", "Type", V.VENUE_TYPES, state.type, "Any type", function (v) { state.type = v; }),
      sel("vn_f_city", "City", cities(), state.city, "Any city", function (v) { state.city = v; }),
      sel("vn_f_ac", "AC", V.AC_TYPES, state.ac, "AC / non-AC", function (v) { state.ac = v; }),
      sel("vn_f_ev", "Event type", V.EVENT_TYPES, state.ev, "Any event", function (v) { state.ev = v; }),
      h("label", { cls: "vn-chk" }, [h("input", { type: "checkbox", id: "vn_inactive", checked: state.inactive,
        onchange: function (e) { state.inactive = e.target.checked; paintList(); } }), " Show inactive"]),
      unitToggle(function () { paintList(); }),
      state.canEdit ? h("button", { type: "button", cls: "btn primary", id: "vn_add", text: "+ Add venue",
        onclick: function () { state.msg = ""; state.editing = { active: true, dim_unit: state.unit, event_types: [], restrictions: [] }; render(); } }) : null,
      (state.isAdmin && (!state.rows.length || state.rows.some(function (r) { return r.is_sample; }))) ? h("button", { type: "button", cls: "btn", id: "vn_samples", text: "Load sample venues", onclick: loadSamples }) : null
    ]);
    root.appendChild(bar);
    root.appendChild(h("div", { id: "vn_count", cls: "vn-count", role: "status", "aria-live": "polite", hidden: true }));
    root.appendChild(h("div", { id: "vn_list", cls: "vn-list" }));
    paintList();
  }
  function sel(id, label, list, cur, blank, set) {
    return h("select", { id: id, "aria-label": label, autocomplete: "off", onchange: function (e) { set(e.target.value); paintList(); } }, opts(list, cur, blank));
  }
  function unitToggle(after) {
    return h("div", { cls: "vn-unit", role: "group", "aria-label": "Length unit" }, ["m", "ft"].map(function (u) {
      return h("button", { type: "button", cls: "btn sm" + (state.unit === u ? " on" : ""), "aria-pressed": String(state.unit === u), text: u === "m" ? "Metres" : "Feet",
        onclick: function () { state.unit = u; try { localStorage.setItem("helm.venues.unit", u); } catch (_) {} after(u); } });
    }));
  }
  function paintList() {
    var box = document.getElementById("vn_list"); if (!box) return;
    // keep the unit buttons in sync
    root.querySelectorAll(".vn-tools .vn-unit .btn").forEach(function (b) { var on = (b.textContent === "Feet") === (state.unit === "ft"); b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
    box.textContent = "";
    var rows = filtered();
    paintCount(rows.length);
    if (!state.rows.length) { box.appendChild(h("p", { cls: "mnote", text: state.isAdmin ? "No venues yet. Add one, or load 4 sample venues to try it out." : "No venues yet." })); return; }
    if (!rows.length) { box.appendChild(h("p", { cls: "mnote", text: "No venues match these filters." })); return; }
    rows.forEach(function (v) { box.appendChild(card(v)); });
  }
  // "Showing 1 of 4 venues · Clear filters" whenever a filter / search is narrowing the list
  function paintCount(shown) {
    var c = document.getElementById("vn_count"); if (!c) return;
    c.textContent = "";
    var total = state.rows.filter(function (v) { return state.inactive || v.active; }).length;
    if (!state.rows.length || !filtersOn()) { c.hidden = true; return; }
    c.hidden = false;
    c.appendChild(h("span", { text: "Showing " + shown + " of " + total + " venue" + (total === 1 ? "" : "s") + " \u00b7 " }));
    c.appendChild(h("button", { type: "button", cls: "vn-clear", id: "vn_clear", text: "Clear filters",
      onclick: function () { resetFilters(); render(); var q = document.getElementById("vn_q"); if (q && q.focus) q.focus(); } }));
  }
  function dims(v) {
    if (!v.length_m || !v.width_m) return "";
    return V.fromMeters(v.length_m, state.unit) + " × " + V.fromMeters(v.width_m, state.unit) + " " + state.unit;
  }
  function card(v) {
    var bits = [V.label(V.VENUE_TYPES, v.venue_type), V.label(V.AC_TYPES, v.ac_type), V.label(V.SETTINGS, v.setting), dims(v),
      v.seated_capacity ? Number(v.seated_capacity).toLocaleString("en-IN") + " seated" : "",
      v.floating_capacity ? Number(v.floating_capacity).toLocaleString("en-IN") + " floating" : "", V.costText(v)].filter(Boolean);
    var chips = (v.restrictions || []).map(function (r) {
      var t = V.label(V.RESTRICTIONS, r); if (r === "sound_curfew" && v.sound_curfew) t += " " + String(v.sound_curfew).slice(0, 5);
      return h("span", { cls: "vn-chip", text: t });
    });
    var evs = (v.event_types || []).map(function (e) { return V.label(V.EVENT_TYPES, e); }).join(", ");
    return h("div", { cls: "vn-card" + (v.active ? "" : " off"), "data-id": v.id }, [
      h("div", { cls: "vn-head" }, [h("b", { text: v.name }), v.is_sample ? h("span", { cls: "vn-tag", text: "Sample" }) : null,
        v.active ? null : h("span", { cls: "vn-tag off", text: "Inactive" }), v.city ? h("span", { cls: "vn-city", text: v.city }) : null]),
      h("div", { cls: "vn-meta", text: bits.join(" · ") }),
      evs ? h("div", { cls: "vn-meta", text: "Events: " + evs }) : null,
      chips.length ? h("div", { cls: "vn-chips" }, chips) : null,
      state.canEdit ? h("div", { cls: "vn-acts" }, [
        h("button", { type: "button", cls: "btn sm", text: "Edit", onclick: function () { state.msg = ""; state.editing = Object.assign({}, v); render(); } }),
        h("button", { type: "button", cls: "btn sm", text: v.active ? "Deactivate" : "Re-activate", onclick: function () { toggle(v); } })]) : null
    ]);
  }
  async function toggle(v) {
    try { await S.venues.setActive(v.id, !v.active); state.msg = v.active ? "Venue deactivated (kept - re-activate any time)." : "Venue re-activated."; state.err = ""; }
    catch (e) { state.err = friendly(e); }
    await reload();
  }
  async function loadSamples() {
    var b = document.getElementById("vn_samples"); if (b) b.disabled = true;
    try { var r = await S.venues.loadSamples(); state.msg = (r && r.added) ? "Added " + r.added + " sample venue" + (r.added === 1 ? "" : "s") + " (marked SAMPLE - edit or deactivate them)." : (r && r.reason ? "This studio already has venues - no samples added." : "All sample venues are already loaded - nothing added."); state.err = ""; }
    catch (e) { state.err = friendly(e); }
    await reload();
  }

  // ---- add / edit form ---------------------------------------------------------------
  // inline message under one field (msg "" clears it); it goes in the field's .fld box (the input may sit in a ₹ wrapper)
  function fldOf(input) { for (var n = input.parentNode; n; n = n.parentNode) if (/(^|\s)fld(\s|$)/.test(n.className || "")) return n; return input.parentNode; }
  function fieldErr(input, msg) {
    if (!input) return;
    var box = fldOf(input), id = input.id + "_err", e = document.getElementById(id);
    if (!e && msg && box) { e = h("div", { id: id, cls: "vn-ferr" }); box.appendChild(e); }
    if (e) { e.textContent = msg || ""; e.hidden = !msg; }
    if (msg) { input.setAttribute("aria-invalid", "true"); input.setAttribute("aria-describedby", id); }
    else { input.removeAttribute("aria-invalid"); input.removeAttribute("aria-describedby"); }
  }
  function form(v) {
    var unit = state.unit;
    var f = function (id, label, input, full) { return h("div", { cls: "fld" + (full ? " full" : "") }, [h("label", { "for": id, text: label }), input]); };
    var inp = function (id, val, type, extra) { return h("input", Object.assign({ id: id, type: type || "text", value: val === null || val === undefined ? "" : String(val) }, extra || {})); };
    var lenIn = inp("vf_len", v.length_m ? V.fromMeters(v.length_m, unit) : "", "number", { min: "0", step: "any" });
    var widIn = inp("vf_wid", v.width_m ? V.fromMeters(v.width_m, unit) : "", "number", { min: "0", step: "any" });
    var lenLbl = h("label", { "for": "vf_len", text: "Length (" + unit + ") *" }), widLbl = h("label", { "for": "vf_wid", text: "Breadth (" + unit + ") *" });
    function setUnit(u) {
      if (u === unit) return;
      [lenIn, widIn].forEach(function (el) { var n = el.value === "" ? null : V.toMeters(el.value, unit); if (n !== null && !isNaN(n)) el.value = V.fromMeters(n, u); });
      unit = u; state.unit = u; lenLbl.textContent = "Length (" + u + ") *"; widLbl.textContent = "Breadth (" + u + ") *";
      tog.querySelectorAll(".btn").forEach(function (b) { var on = (b.textContent === "Feet") === (u === "ft"); b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
    }
    var tog = unitToggle(setUnit);
    // 1018b (owner: "form looks congested"): section cards + even grids. Ids / names / behaviour unchanged.
    var multi = function (name, list, cur, refs, onchg, cls, after) {
      return h("div", { cls: "vn-multi " + (cls || "vn-pills"), role: "group", "aria-label": name }, list.map(function (x) {
        var cb = h("input", { type: "checkbox", name: name, value: x[0], checked: (cur || []).indexOf(x[0]) >= 0, onchange: onchg ? function () { onchg(x[0]); } : null });
        if (refs) refs[x[0]] = cb;
        var lbl = h("label", { cls: "vn-chk" }, [cb, h("span", { text: x[1] })]);
        // a restriction with its own detail field (curfew time / setup window) shows that field right under its tick
        return after ? h("div", { cls: "vn-opt" + (after[x[0]] ? " has-dep" : "") }, [lbl, after[x[0]] || null]) : lbl;
      }));
    };
    var grid = function (cols, kids) { return h("div", { cls: "vn-g c" + cols }, kids); };
    var sec = function (key, title, kids, head) {
      return h("section", { cls: "vn-sec", "aria-labelledby": "vn_sec_" + key }, [
        h("div", { cls: "vn-sec-head" }, [h("h5", { cls: "vn-sec-h", id: "vn_sec_" + key, text: title }), head || null])].concat(kids));
    };
    var group = function (title, kids) { return h("fieldset", { cls: "vn-sec" }, [h("legend", { cls: "vn-sec-h", text: title })].concat(kids)); };
    var money = function (id, label, val) {
      return h("div", { cls: "fld" }, [h("label", { "for": id, text: label }),
        h("div", { cls: "vn-pre" }, [h("span", { cls: "vn-pre-sym", "aria-hidden": "true", text: "₹" }), inp(id, val, "number", { min: "0", step: "1" })])]);
    };
    // 1018: "Sound curfew time" / "Setup time window" only show while their restriction is ticked; unticking clears
    // the value (it is not saved). A venue saved earlier with a value but no tick keeps showing it, so nothing is lost.
    var rsRefs = {};
    var curfewIn = inp("vf_curfew", v.sound_curfew ? String(v.sound_curfew).slice(0, 5) : "", "time");
    var setupIn = inp("vf_setup", v.setup_window, "text", { maxlength: "200", placeholder: "e.g. 06:00-11:00 on event day" });
    var curfewFld = f("vf_curfew", "Sound curfew time", curfewIn), setupFld = f("vf_setup", "Setup time window", setupIn);
    curfewFld.className += " vn-dep"; setupFld.className += " vn-dep";
    var deps = { sound_curfew: [curfewFld, curfewIn], setup_window: [setupFld, setupIn] };
    function syncDeps(changed) {
      Object.keys(deps).forEach(function (k) {
        var cb = rsRefs[k], on = !!(cb && cb.checked), d = deps[k];
        if (changed === k && !on) { d[1].value = ""; fieldErr(d[1], ""); }
        d[0].hidden = !on && !d[1].value;
        if (changed === k && on && d[1].focus) d[1].focus();
      });
    }
    var rsBox = multi("vf_rs", V.RESTRICTIONS, v.restrictions, rsRefs, syncDeps, "vn-rs", { sound_curfew: curfewFld, setup_window: setupFld });
    var errBox = h("div", { id: "vf_err", cls: "msg err vn-sum", role: "alert", hidden: true });
    var el = h("form", { id: "vn_form", cls: "vn-form", novalidate: true }, [
      h("div", { cls: "vn-fhead" }, [h("h4", { text: v.id ? "Edit venue" : "Add venue" }), h("p", { cls: "vn-hint", text: "Fields marked * are required." })]),
      sec("basics", "Basics", [grid(3, [
        f("vf_name", "Venue name *", inp("vf_name", v.name, "text", { maxlength: "200", required: true }), true),
        f("vf_type", "Venue type", h("select", { id: "vf_type" }, opts(V.VENUE_TYPES, v.venue_type || "banquet_hall"))),
        f("vf_ac", "AC", h("select", { id: "vf_ac" }, opts(V.AC_TYPES, v.ac_type || "ac"))),
        f("vf_setting", "Indoor / outdoor", h("select", { id: "vf_setting" }, opts(V.SETTINGS, v.setting || "indoor")))])]),
      sec("size", "Size & capacity", [
        grid(2, [
          f("vf_seat", "Seated capacity", inp("vf_seat", v.seated_capacity, "number", { min: "1", step: "1" })),
          f("vf_float", "Floating / standing capacity", inp("vf_float", v.floating_capacity, "number", { min: "1", step: "1" }))]),
        grid(2, [h("div", { cls: "fld" }, [lenLbl, lenIn]), h("div", { cls: "fld" }, [widLbl, widIn])])
      ], h("div", { cls: "vn-unit-row" }, [h("span", { cls: "vn-lbl", text: "Hall size unit" }), tog])),
      group("Event types available", [multi("vf_ev", V.EVENT_TYPES, v.event_types)]),
      group("Restrictions", [rsBox,
        h("div", { cls: "vn-g c1 vn-gap-top" }, [f("vf_rnote", "Other restrictions", h("textarea", { id: "vf_rnote", maxlength: "2000", rows: "3" }, [v.restrictions_note || ""]), true)])]),
      group("Approximate cost", [grid(3, [
        money("vf_cmin", "Minimum", v.cost_min),
        money("vf_cmax", "Maximum", v.cost_max),
        f("vf_basis", "Basis", h("select", { id: "vf_basis" }, opts(V.COST_BASIS, v.cost_basis || "per_day")))])]),
      group("Amenities", [grid(3, [
        f("vf_park", "Parking spaces", inp("vf_park", v.parking_spaces, "number", { min: "0", step: "1" })),
        f("vf_rooms", "Rooms", inp("vf_rooms", v.rooms, "number", { min: "0", step: "1" })),
        f("vf_kw", "Power backup (kW)", inp("vf_kw", v.power_backup_kw, "number", { min: "0", step: "any" })),
        f("vf_green", "Green rooms", inp("vf_green", v.green_rooms, "number", { min: "0", step: "1" })),
        f("vf_wash", "Washrooms", inp("vf_wash", v.washrooms, "number", { min: "0", step: "1" }))])]),
      sec("contact", "Address & contact", [grid(3, [
        f("vf_addr", "Address", inp("vf_addr", v.address, "text", { maxlength: "1000" }), true),
        f("vf_city", "City", inp("vf_city", v.city, "text", { maxlength: "120" })),
        h("div", { cls: "fld span2" }, [h("label", { "for": "vf_map", text: "Map link (https://)" }), inp("vf_map", v.map_url, "url", { maxlength: "1000", placeholder: "https://maps.google.com/..." })]),
        f("vf_cname", "Contact name", inp("vf_cname", v.contact_name, "text", { maxlength: "200" })),
        f("vf_cphone", "Contact phone", inp("vf_cphone", v.contact_phone, "tel", { maxlength: "40" })),
        f("vf_cemail", "Contact email", inp("vf_cemail", v.contact_email, "email", { maxlength: "254" }))])]),
      sec("notes", "Notes", [grid(1, [
        h("div", { cls: "fld full" }, [h("label", { "for": "vf_notes", cls: "vn-sr", text: "Notes" }), h("textarea", { id: "vf_notes", maxlength: "4000", rows: "4", placeholder: "Anything the team should know about this venue" }, [v.notes || ""])])])]),
      // sticky footer: the summary (if any) sits 12px above the buttons, never flush against the last field
      h("div", { cls: "vn-foot" }, [errBox,
        h("div", { cls: "vn-foot-btns" }, [
          h("button", { type: "button", cls: "btn", text: "Cancel", onclick: function () { state.editing = null; render(); } }),
          h("button", { type: "submit", cls: "btn primary", id: "vf_save", text: "Save venue" })])])
    ]);
    syncDeps(null);
    // typing in a flagged field clears its inline message
    var clearMine = function (e) { var t = e.target; if (t && t.getAttribute && t.getAttribute("aria-invalid") === "true") fieldErr(t, ""); };
    el.addEventListener("input", clearMine); el.addEventListener("change", clearMine);
    el.addEventListener("submit", async function (e) {
      e.preventDefault();
      var val = function (id) { var x = document.getElementById(id); return x ? x.value : ""; };
      var checked = function (name) { return Array.prototype.map.call(el.querySelectorAll('input[name="' + name + '"]:checked'), function (x) { return x.value; }); };
      var r = V.validate({ name: val("vf_name"), venue_type: val("vf_type"), ac_type: val("vf_ac"), setting: val("vf_setting"),
        seated_capacity: val("vf_seat"), floating_capacity: val("vf_float"), length: val("vf_len"), width: val("vf_wid"),
        event_types: checked("vf_ev"), restrictions: checked("vf_rs"), sound_curfew: val("vf_curfew"), setup_window: val("vf_setup"),
        restrictions_note: val("vf_rnote"), cost_min: val("vf_cmin"), cost_max: val("vf_cmax"), cost_basis: val("vf_basis"),
        parking_spaces: val("vf_park"), rooms: val("vf_rooms"), power_backup_kw: val("vf_kw"), green_rooms: val("vf_green"),
        washrooms: val("vf_wash"), address: val("vf_addr"), city: val("vf_city"), map_url: val("vf_map"),
        contact_name: val("vf_cname"), contact_phone: val("vf_cphone"), contact_email: val("vf_cemail"), notes: val("vf_notes") }, unit, { existing: !!v.id });
      el.querySelectorAll("[aria-invalid]").forEach(function (x) { fieldErr(x, ""); });
      errBox.hidden = true; errBox.textContent = "";
      if (!r.ok) {
        // 1018: each message sits under its own field (was one line at the bottom, near Notes); scroll to + focus the first
        var ids = { name: "vf_name", seated_capacity: "vf_seat", floating_capacity: "vf_float", length: "vf_len", width: "vf_wid", cost_min: "vf_cmin", cost_max: "vf_cmax",
          map_url: "vf_map", sound_curfew: "vf_curfew", parking_spaces: "vf_park", rooms: "vf_rooms", power_backup_kw: "vf_kw", green_rooms: "vf_green", washrooms: "vf_wash" };
        var per = {}, loose = [];
        r.errors.forEach(function (x) { var id = ids[x.field]; if (id && document.getElementById(id)) (per[id] = per[id] || []).push(x.msg); else loose.push(x.msg); });
        Object.keys(per).forEach(function (id) { fieldErr(document.getElementById(id), per[id].join(" ")); });
        var n = r.errors.length - loose.length;
        errBox.hidden = false;
        errBox.textContent = (n ? (n === 1 ? "Fix the highlighted field above." : "Fix the " + n + " highlighted fields above.") : "") + (loose.length ? (n ? " " : "") + loose.join(" ") : "");
        var first = el.querySelector('[aria-invalid="true"]');
        if (first) {
          try { first.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) { try { first.scrollIntoView(); } catch (__) {} }
          try { first.focus({ preventScroll: true }); } catch (_) { first.focus(); }
        }
        return;
      }
      r.value.active = v.active !== false;
      var btn = document.getElementById("vf_save"); btn.disabled = true;
      try { await S.venues.save(v.id || null, r.value); state.editing = null; state.msg = "Venue saved." + (r.warnings && r.warnings.length ? " " + r.warnings[0].msg : ""); state.err = ""; await reload(); }
      catch (err) { btn.disabled = false; errBox.hidden = false; errBox.textContent = friendly(err); }
    });
    return el;
  }

  document.querySelectorAll(".tab").forEach(function (t) {
    t.addEventListener("click", function () {
      var on = t.dataset.pane === "venues";
      pane.hidden = !on;
      if (on) open();
    });
  });
  var tries = 0;
  (function wait() {
    if (S.auth && S.auth.user && S.auth.user()) { init().then(function () { if (location.hash === "#venues" && !tab.hidden) tab.click(); }).catch(function () {}); return; }
    if (tries++ < 40) setTimeout(wait, 500);
  })();
  // onboarding opens the manager through reload(): start it on "Any" filters too
  window.HelmVenuesAdmin = { reload: function () { resetFilters(); return reload(); } };
})();
