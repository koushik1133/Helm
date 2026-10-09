/* venues-admin.js (0085) - Control Center -> Venues tab. List + search / filters, add / edit,
 * deactivate / re-activate (never delete), m / ft toggle, admin "Load 3 sample venues".
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
  async function open() {
    if (loaded) return; loaded = true;
    await reload();
  }
  async function reload() {
    try { state.rows = await S.venues.list({ all: true }); state.err = ""; }
    catch (e) { state.rows = []; state.err = friendly(e); }
    render();
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    return state.rows.filter(function (v) {
      if (!state.inactive && !v.active) return false;
      if (state.type && v.venue_type !== state.type) return false;
      if (state.ac && v.ac_type !== state.ac) return false;
      if (state.city && String(v.city || "").toLowerCase() !== state.city.toLowerCase()) return false;
      if (state.ev && (v.event_types || []).indexOf(state.ev) < 0) return false;
      if (q && [v.name, v.city, v.address, v.notes].join(" ").toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }
  function cities() {
    var seen = {}; state.rows.forEach(function (v) { if (v.city) seen[v.city] = 1; });
    return Object.keys(seen).sort().map(function (c) { return [c, c]; });
  }

  function render() {
    root.textContent = "";
    if (state.err) root.appendChild(h("div", { cls: "msg err", role: "alert", text: state.err }));
    if (state.msg) root.appendChild(h("div", { cls: "msg ok", role: "status", text: state.msg }));
    if (state.editing) { root.appendChild(form(state.editing)); return; }
    var bar = h("div", { cls: "vn-tools" }, [
      h("input", { type: "search", id: "vn_q", placeholder: "Search venues", "aria-label": "Search venues", value: state.q,
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
      (state.isAdmin && !state.rows.length) ? h("button", { type: "button", cls: "btn", id: "vn_samples", text: "Load 3 sample venues", onclick: loadSamples }) : null
    ]);
    root.appendChild(bar);
    root.appendChild(h("div", { id: "vn_list", cls: "vn-list" }));
    paintList();
  }
  function sel(id, label, list, cur, blank, set) {
    return h("select", { id: id, "aria-label": label, onchange: function (e) { set(e.target.value); paintList(); } }, opts(list, cur, blank));
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
    if (!state.rows.length) { box.appendChild(h("p", { cls: "mnote", text: state.isAdmin ? "No venues yet. Add one, or load 3 sample venues to try it out." : "No venues yet." })); return; }
    if (!rows.length) { box.appendChild(h("p", { cls: "mnote", text: "No venues match these filters." })); return; }
    rows.forEach(function (v) { box.appendChild(card(v)); });
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
    try { var r = await S.venues.loadSamples(); state.msg = (r && r.added) ? "Added " + r.added + " sample venues (marked SAMPLE - edit or deactivate them)." : "This studio already has venues - no samples added."; state.err = ""; }
    catch (e) { state.err = friendly(e); }
    await reload();
  }

  // ---- add / edit form ---------------------------------------------------------------
  function form(v) {
    var unit = state.unit;
    var f = function (id, label, input, full) { return h("div", { cls: "fld" + (full ? " full" : "") }, [h("label", { "for": id, text: label }), input]); };
    var inp = function (id, val, type, extra) { return h("input", Object.assign({ id: id, type: type || "text", value: val === null || val === undefined ? "" : String(val) }, extra || {})); };
    var lenIn = inp("vf_len", v.length_m ? V.fromMeters(v.length_m, unit) : "", "number", { min: "0", step: "any" });
    var widIn = inp("vf_wid", v.width_m ? V.fromMeters(v.width_m, unit) : "", "number", { min: "0", step: "any" });
    var lenLbl = h("label", { "for": "vf_len", text: "Length (" + unit + ")" }), widLbl = h("label", { "for": "vf_wid", text: "Width (" + unit + ")" });
    function setUnit(u) {
      if (u === unit) return;
      [lenIn, widIn].forEach(function (el) { var n = el.value === "" ? null : V.toMeters(el.value, unit); if (n !== null && !isNaN(n)) el.value = V.fromMeters(n, u); });
      unit = u; state.unit = u; lenLbl.textContent = "Length (" + u + ")"; widLbl.textContent = "Width (" + u + ")";
      tog.querySelectorAll(".btn").forEach(function (b) { var on = (b.textContent === "Feet") === (u === "ft"); b.classList.toggle("on", on); b.setAttribute("aria-pressed", String(on)); });
    }
    var tog = unitToggle(setUnit);
    var multi = function (name, list, cur) {
      return h("div", { cls: "vn-multi", role: "group", "aria-label": name }, list.map(function (x) {
        return h("label", { cls: "vn-chk" }, [h("input", { type: "checkbox", name: name, value: x[0], checked: (cur || []).indexOf(x[0]) >= 0 }), " " + x[1]]);
      }));
    };
    var errBox = h("div", { id: "vf_err", cls: "msg err", role: "alert", hidden: true });
    var el = h("form", { id: "vn_form", cls: "vn-form", novalidate: true }, [
      h("h4", { text: v.id ? "Edit venue" : "Add venue" }),
      h("div", { cls: "grid" }, [
        f("vf_name", "Venue name *", inp("vf_name", v.name, "text", { maxlength: "200", required: true }), true),
        f("vf_type", "Venue type", h("select", { id: "vf_type" }, opts(V.VENUE_TYPES, v.venue_type || "banquet_hall"))),
        f("vf_ac", "AC", h("select", { id: "vf_ac" }, opts(V.AC_TYPES, v.ac_type || "ac"))),
        f("vf_setting", "Indoor / outdoor", h("select", { id: "vf_setting" }, opts(V.SETTINGS, v.setting || "indoor"))),
        f("vf_seat", "Seated capacity", inp("vf_seat", v.seated_capacity, "number", { min: "1", step: "1" })),
        f("vf_float", "Floating / standing capacity", inp("vf_float", v.floating_capacity, "number", { min: "1", step: "1" })),
        h("div", { cls: "fld full" }, [h("span", { cls: "vn-lbl", text: "Hall size unit" }), tog]),
        h("div", { cls: "fld" }, [lenLbl, lenIn]), h("div", { cls: "fld" }, [widLbl, widIn])
      ]),
      h("fieldset", { cls: "vn-fs" }, [h("legend", { text: "Event types available" }), multi("vf_ev", V.EVENT_TYPES, v.event_types)]),
      h("fieldset", { cls: "vn-fs" }, [h("legend", { text: "Restrictions" }), multi("vf_rs", V.RESTRICTIONS, v.restrictions),
        h("div", { cls: "grid" }, [
          f("vf_curfew", "Sound curfew time", inp("vf_curfew", v.sound_curfew ? String(v.sound_curfew).slice(0, 5) : "", "time")),
          f("vf_setup", "Setup time window", inp("vf_setup", v.setup_window, "text", { maxlength: "200", placeholder: "e.g. 06:00-11:00 on event day" })),
          f("vf_rnote", "Other restrictions", h("textarea", { id: "vf_rnote", maxlength: "2000" }, [v.restrictions_note || ""]), true)])]),
      h("fieldset", { cls: "vn-fs" }, [h("legend", { text: "Approximate cost (₹)" }), h("div", { cls: "grid" }, [
        f("vf_cmin", "Min ₹", inp("vf_cmin", v.cost_min, "number", { min: "0", step: "1" })),
        f("vf_cmax", "Max ₹", inp("vf_cmax", v.cost_max, "number", { min: "0", step: "1" })),
        f("vf_basis", "Basis", h("select", { id: "vf_basis" }, opts(V.COST_BASIS, v.cost_basis || "per_day")))])]),
      h("fieldset", { cls: "vn-fs" }, [h("legend", { text: "Amenities" }), h("div", { cls: "grid" }, [
        f("vf_park", "Parking spaces", inp("vf_park", v.parking_spaces, "number", { min: "0", step: "1" })),
        f("vf_rooms", "Rooms", inp("vf_rooms", v.rooms, "number", { min: "0", step: "1" })),
        f("vf_kw", "Power backup (kW)", inp("vf_kw", v.power_backup_kw, "number", { min: "0", step: "any" })),
        f("vf_green", "Green rooms", inp("vf_green", v.green_rooms, "number", { min: "0", step: "1" })),
        f("vf_wash", "Washrooms", inp("vf_wash", v.washrooms, "number", { min: "0", step: "1" }))])]),
      h("div", { cls: "grid" }, [
        f("vf_addr", "Address", inp("vf_addr", v.address, "text", { maxlength: "1000" }), true),
        f("vf_city", "City", inp("vf_city", v.city, "text", { maxlength: "120" })),
        f("vf_map", "Map link (https://)", inp("vf_map", v.map_url, "url", { maxlength: "1000", placeholder: "https://maps.google.com/..." })),
        f("vf_cname", "Contact name", inp("vf_cname", v.contact_name, "text", { maxlength: "200" })),
        f("vf_cphone", "Contact phone", inp("vf_cphone", v.contact_phone, "tel", { maxlength: "40" })),
        f("vf_cemail", "Contact email", inp("vf_cemail", v.contact_email, "email", { maxlength: "254" })),
        f("vf_notes", "Notes", h("textarea", { id: "vf_notes", maxlength: "4000" }, [v.notes || ""]), true)]),
      errBox,
      h("div", { cls: "vn-acts" }, [
        h("button", { type: "submit", cls: "btn primary", id: "vf_save", text: "Save venue" }),
        h("button", { type: "button", cls: "btn", text: "Cancel", onclick: function () { state.editing = null; render(); } })])
    ]);
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
        contact_name: val("vf_cname"), contact_phone: val("vf_cphone"), contact_email: val("vf_cemail"), notes: val("vf_notes") }, unit);
      el.querySelectorAll("[aria-invalid]").forEach(function (x) { x.removeAttribute("aria-invalid"); });
      if (!r.ok) {
        errBox.hidden = false; errBox.textContent = r.errors.map(function (x) { return x.msg; }).join(" ");
        var ids = { name: "vf_name", seated_capacity: "vf_seat", floating_capacity: "vf_float", length: "vf_len", width: "vf_wid", cost_min: "vf_cmin", cost_max: "vf_cmax", map_url: "vf_map", sound_curfew: "vf_curfew" };
        r.errors.forEach(function (x) { var t = document.getElementById(ids[x.field]); if (t) t.setAttribute("aria-invalid", "true"); });
        var first = document.getElementById(ids[r.errors[0].field]); if (first) first.focus();
        return;
      }
      r.value.active = v.active !== false;
      var btn = document.getElementById("vf_save"); btn.disabled = true;
      try { await S.venues.save(v.id || null, r.value); state.editing = null; state.msg = "Venue saved."; state.err = ""; await reload(); }
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
  window.HelmVenuesAdmin = { reload: reload };
})();
