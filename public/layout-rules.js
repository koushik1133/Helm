/* layout-rules.js - Settings > Layout rules (R97).
 *
 * One editor for the layout_rules rows (one per event type): a list of event types on the left (chips on a phone)
 * and one editor on the right, with -/+ steppers, plain-English labels, a live "For N guests" preview, one sticky
 * Save for every changed event type, "Reset to Helm default", "Copy from another event type" and "Add event type".
 *
 * What the layout generator really does with a rule (builder.js, ?gen=1 flow): it pre-fills the Custom event
 * builder - chairs = guests x seatsPerGuest, bars, the buffet line is ticked once guests reach buffetPer, stage,
 * dance floor (+ DJ booth). R97 adds keys that fill the builder's existing fields: seatsPerTable (c_spt),
 * aisleFt (c_aisle), exits (c_exits), headTable (c_head), canopy (c_canopy), lounge (c_lounge). A new key is
 * stored ONLY when it differs from the generator's built-in value, so an untouched rule produces exactly the same
 * layouts as before. walkway + dj are kept as planner notes (the generator does not draw them on their own).
 *
 * Limits match the database check (0313). DOM built with createElement + textContent only.
 * HelmLayoutRules.core (pure) also runs in Node for the unit tests.
 */
(function (global) {
  "use strict";

  /* ------------------------------------------------------------------ pure core */
  var FIELDS = [
    { key: "seatsPerGuest", group: "seat", label: "Seats for each guest", min: 0, gt: true, max: 10, step: 0.1, dp: 2,
      hint: "1 = a seat for everyone. 0.4 = seats for 40% (a standing crowd)." },
    { key: "seatsPerTable", group: "seat", label: "Guests per round table", min: 2, max: 20, step: 1, builtin: 8, unit: "guests",
      hint: "Used when the layout seats guests at round tables." },
    { key: "aisleFt", group: "seat", label: "Main aisle width", min: 3, max: 30, step: 1, builtin: 8, unit: "ft",
      hint: "The walkway down the middle of theatre and classroom seating." },
    { key: "buffetPer", group: "food", label: "Add a buffet line from", min: 10, max: 500, step: 5, unit: "guests",
      hint: "Smaller events get no buffet line." },
    { key: "bars", group: "food", label: "Bars", min: 0, max: 20, step: 1, unit: "bars" },
    { key: "exits", group: "floor", label: "Marked exits", min: 0, max: 20, step: 1, builtin: 2, unit: "exits" }
  ];
  var TOGGLES = [
    { key: "stage", group: "floor", label: "Stage and podium" },
    { key: "canopy", group: "floor", label: "Ceremony canopy", hint: "Takes the stage's place at the front.", builtin: false },
    { key: "dancefloor", group: "floor", label: "Dance floor with DJ booth" },
    { key: "headTable", group: "floor", label: "Head table", builtin: false },
    { key: "lounge", group: "floor", label: "Lounge area", builtin: false },
    { key: "walkway", group: "note", label: "Walkway / entry aisle" },
    { key: "dj", group: "note", label: "DJ" }
  ];
  var LEGACY = ["seatsPerGuest", "buffetPer", "bars", "stage", "dancefloor", "walkway", "dj"];
  // phase75 seed values = "Helm default" per event type
  var HELM = {
    wedding:    { seatsPerGuest: 1,   buffetPer: 75,  bars: 1, stage: true, dancefloor: true,  walkway: true,  dj: true },
    conference: { seatsPerGuest: 1,   buffetPer: 100, bars: 0, stage: true, dancefloor: false, walkway: false, dj: false },
    concert:    { seatsPerGuest: 0.4, buffetPer: 150, bars: 2, stage: true, dancefloor: true,  walkway: false, dj: true },
    festival:   { seatsPerGuest: 0.3, buffetPer: 120, bars: 2, stage: true, dancefloor: true,  walkway: false, dj: true },
    political:  { seatsPerGuest: 1,   buffetPer: 200, bars: 0, stage: true, dancefloor: false, walkway: true,  dj: false }
  };
  var FALLBACK = { seatsPerGuest: 1, buffetPer: 100, bars: 0, stage: true, dancefloor: false, walkway: false, dj: false };

  function fieldOf(k) { for (var i = 0; i < FIELDS.length; i++) if (FIELDS[i].key === k) return FIELDS[i]; return null; }
  function toggleOf(k) { for (var i = 0; i < TOGGLES.length; i++) if (TOGGLES[i].key === k) return TOGGLES[i]; return null; }
  function helmDefault(type) {
    var d = HELM[String(type || "").toLowerCase().trim()] || FALLBACK, o = {};
    for (var k in d) o[k] = d[k];
    return o;
  }
  // the value shown in the editor: stored value, else the generator's built-in, else the Helm default
  function shown(rules, k, type) {
    var r = rules && typeof rules === "object" ? rules : {};
    if (r[k] != null) return r[k];
    var f = fieldOf(k) || toggleOf(k);
    if (f && f.builtin != null) return f.builtin;
    // a missing switch shows what the builder does without it (stage ticked, the rest not), so a save never changes it
    if (toggleOf(k)) return k === "stage";
    return helmDefault(type)[k];
  }
  // a number as typed -> {ok, value, error}; the same limits as the database check (0313)
  function checkNumber(f, raw) {
    var s = String(raw == null ? "" : raw).trim();
    if (s === "") return { ok: false, error: "Enter " + f.label.toLowerCase() + "." };
    if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: f.label + " must be a number." };
    var n = Number(s);
    var whole = !f.dp;
    if (whole && n !== Math.floor(n)) return { ok: false, error: f.label + " must be a whole number (no decimals)." };
    if (f.dp && Math.round(n * 100) !== n * 100) return { ok: false, error: f.label + " can have 2 decimals at most." };
    if ((f.gt ? n <= f.min : n < f.min) || n > f.max)
      return { ok: false, error: f.gt ? f.label + " must be more than " + f.min + " and up to " + f.max + "."
                                      : f.label + " must be from " + f.min + " to " + f.max + "." };
    return { ok: true, value: n };
  }
  // the editor's values ({key: raw}) -> {ok, errors, value: full rules object to save}
  // original keys are kept (merged, never dropped); an R97 key equal to the built-in value is left out, so the
  // generator behaves exactly as before for it.
  function build(original, raw) {
    var out = {}, errors = {}, o = original && typeof original === "object" ? original : {};
    for (var k in o) out[k] = o[k];
    FIELDS.forEach(function (f) {
      var c = checkNumber(f, raw[f.key]);
      if (!c.ok) { errors[f.key] = c.error; return; }
      if (f.builtin != null && c.value === f.builtin) delete out[f.key]; else out[f.key] = c.value;
    });
    TOGGLES.forEach(function (t) {
      var v = !!raw[t.key];
      if (t.builtin != null && v === t.builtin) delete out[t.key]; else out[t.key] = v;
    });
    var ok = !Object.keys(errors).length;
    return { ok: ok, errors: errors, value: ok ? out : null };
  }
  // two editor states equal? (typed "1.0" equals stored 1; untouched missing keys never count as a change)
  function rawSame(a, b) {
    for (var i = 0; i < FIELDS.length; i++) {
      var k = FIELDS[i].key; if (String(a[k]) === String(b[k])) continue;
      var c = checkNumber(FIELDS[i], a[k]); if (!c.ok || c.value !== +b[k]) return false;
    }
    for (var j = 0; j < TOGGLES.length; j++) if (!!a[TOGGLES[j].key] !== !!b[TOGGLES[j].key]) return false;
    return true;
  }
  function same(a, b) {
    var ka = Object.keys(a || {}).sort(), kb = Object.keys(b || {}).sort();
    if (ka.join("|") !== kb.join("|")) return false;
    for (var i = 0; i < ka.length; i++) if (a[ka[i]] !== b[ka[i]]) return false;
    return true;
  }
  // what the generator will pre-fill for G guests (honest: one buffet line, tables only for round-table seating)
  function preview(rules, type, guests) {
    var g = Math.max(0, Math.floor(+guests || 0)), v = function (k) { return shown(rules, k, type); };
    var seats = Math.round(g * (+v("seatsPerGuest") || 0)), spt = +v("seatsPerTable") || 8, parts = [];
    parts.push(seats + (seats === 1 ? " seat" : " seats"));
    // the generator seats at round tables for weddings / receptions, or whenever a studio set its own table size
    var t = String(type || "").toLowerCase();
    if (t === "wedding" || t === "reception" || spt !== 8) parts.push("about " + Math.ceil(seats / spt) + " round tables of " + spt);
    parts.push(g >= +v("buffetPer") ? "a buffet line" : "no buffet line (under " + v("buffetPer") + " guests)");
    var b = +v("bars") || 0; parts.push(b ? b + (b === 1 ? " bar" : " bars") : "no bar");
    if (v("canopy")) parts.push("ceremony canopy"); else if (v("stage")) parts.push("stage");
    if (v("dancefloor")) parts.push("dance floor with DJ");
    if (v("headTable")) parts.push("head table");
    if (v("lounge")) parts.push("lounge");
    var ex = +v("exits"); parts.push(ex + (ex === 1 ? " exit" : " exits"));
    return "For " + g + " guests: " + parts.join(", ") + ".";
  }
  function cleanType(s) { return String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().toLowerCase(); }
  function checkType(name, existing) {
    var t = cleanType(name);
    if (t.length < 2) return { ok: false, error: "Give the event type a name (2 to 40 characters)." };
    if (t.length > 40) return { ok: false, error: "Keep the name to 40 characters." };
    if ((existing || []).some(function (x) { return cleanType(x) === t; })) return { ok: false, error: "“" + t + "” already has a rule." };
    return { ok: true, value: t };
  }
  function title(t) { return String(t || "").replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }); }

  var core = { FIELDS: FIELDS, TOGGLES: TOGGLES, LEGACY: LEGACY, HELM: HELM, FALLBACK: FALLBACK, helmDefault: helmDefault,
    shown: shown, checkNumber: checkNumber, build: build, same: same, rawSame: rawSame, preview: preview, checkType: checkType, title: title };

  /* ------------------------------------------------------------------ DOM */
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function round(n, dp) { var p = Math.pow(10, dp || 0); return Math.round(n * p) / p; }

  function mount(host, opts) {
    opts = opts || {};
    var store = opts.store, canEdit = !!opts.canEdit, errMsg = opts.errMsg || function (e) { return (e && e.message) || "Something went wrong."; };
    var rows = (opts.rows || []).slice(), drafts = {}, errs = {}, cur = rows.length ? String(rows[0].id) : null, sample = 300;
    try { var hs = sessionStorage.getItem("helm_lr_type"); if (hs && rows.some(function (r) { return String(r.id) === hs; })) cur = hs; } catch (_) {}

    function rowOf(id) { for (var i = 0; i < rows.length; i++) if (String(rows[i].id) === String(id)) return rows[i]; return null; }
    function rawFrom(rules, type) { var o = {}; FIELDS.concat(TOGGLES).forEach(function (f) { o[f.key] = shown(rules, f.key, type); }); return o; }
    function draftOf(r) { var id = String(r.id); if (!drafts[id]) drafts[id] = rawFrom(r.rules, r.event_type); return drafts[id]; }
    function isDirty(r) { var d = drafts[String(r.id)]; return !!d && !rawSame(d, rawFrom(r.rules, r.event_type)); }
    function dirtyRows() { return rows.filter(isDirty); }

    host.textContent = "";
    var root = el("div", "lrx" + (canEdit ? "" : " lrx-ro"));
    var intro = el("p", "lrx-intro",
      "These fill in the Custom event builder when a layout is made from a quote. A rule you don't change keeps working exactly as before; floors you already made are never changed.");
    root.appendChild(intro);
    if (!canEdit) root.appendChild(el("p", "lrx-note", "Read only - your role can view these rules but not change them."));

    var body = el("div", "lrx-body");
    var list = el("div", "lrx-list"); list.setAttribute("role", "tablist"); list.setAttribute("aria-label", "Event types");
    var ed = el("section", "lrx-ed"); ed.setAttribute("role", "tabpanel"); ed.id = "lrx_panel";
    body.appendChild(list); body.appendChild(ed); root.appendChild(body);

    var bar = el("div", "lrx-bar"); bar.hidden = true;
    var barMsg = el("span", "lrx-bar-msg"); barMsg.setAttribute("role", "status"); barMsg.setAttribute("aria-live", "polite");
    var discard = el("button", "btn lrx-discard", "Discard"); discard.type = "button";
    var save = el("button", "btn primary lrx-save", "Save changes"); save.type = "button";
    bar.appendChild(barMsg); bar.appendChild(discard); bar.appendChild(save);
    if (canEdit) root.appendChild(bar);
    var status = el("p", "lrx-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    root.appendChild(status);
    host.appendChild(root);

    function say(kind, t) { status.textContent = t || ""; status.dataset.kind = kind || ""; }

    function renderList() {
      list.textContent = "";
      rows.forEach(function (r) {
        var b = el("button", "lrx-tab"); b.type = "button"; b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(String(r.id) === cur)); b.setAttribute("aria-controls", "lrx_panel");
        b.dataset.id = r.id; b.tabIndex = String(r.id) === cur ? 0 : -1;
        b.appendChild(el("span", "lrx-tab-name", title(r.event_type)));
        var d = isDirty(r); var dot = el("span", "lrx-dot"); dot.hidden = !d; dot.setAttribute("aria-label", "unsaved"); b.appendChild(dot);
        b.addEventListener("click", function () { select(r.id); });
        b.addEventListener("keydown", function (e) {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault(); var i = rows.indexOf(r), n = rows[(i + ((e.key === "ArrowDown" || e.key === "ArrowRight") ? 1 : rows.length - 1)) % rows.length];
          select(n.id); var t = list.querySelector('[data-id="' + n.id + '"]'); if (t) t.focus();
        });
        list.appendChild(b);
      });
      if (canEdit) {
        var add = el("button", "lrx-add", "+ Add event type"); add.type = "button";
        add.addEventListener("click", openAdd); list.appendChild(add);
      }
    }
    function syncBar() {
      var d = dirtyRows();
      bar.hidden = !d.length;
      barMsg.textContent = d.length ? "Unsaved changes: " + d.map(function (r) { return title(r.event_type); }).join(", ") : "";
      Array.prototype.forEach.call(list.querySelectorAll(".lrx-tab"), function (t) { var r = rowOf(t.dataset.id); t.querySelector(".lrx-dot").hidden = !(r && isDirty(r)); });
    }
    function select(id) {
      cur = String(id); try { sessionStorage.setItem("helm_lr_type", cur); } catch (_) {}
      Array.prototype.forEach.call(list.querySelectorAll(".lrx-tab"), function (t) {
        var on = t.dataset.id === cur; t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1; });
      renderEditor();
    }

    function stepper(f, r, d, pv) {
      var wrap = el("div", "lrx-fld"); var id = "lrx_" + r.id + "_" + f.key;
      var lab = el("label", "lrx-lab", f.label); lab.htmlFor = id; wrap.appendChild(lab);
      var row = el("div", "lrx-step");
      var minus = el("button", "lrx-sb", "−"); minus.type = "button"; minus.setAttribute("aria-label", "Less " + f.label.toLowerCase());
      var inp = el("input", "lrx-in"); inp.id = id; inp.type = "text"; inp.inputMode = f.dp ? "decimal" : "numeric"; inp.autocomplete = "off";
      inp.value = String(d[f.key]); inp.dataset.key = f.key;
      var plus = el("button", "lrx-sb", "+"); plus.type = "button"; plus.setAttribute("aria-label", "More " + f.label.toLowerCase());
      row.appendChild(minus); row.appendChild(inp); row.appendChild(plus);
      if (f.unit) row.appendChild(el("span", "lrx-unit", f.unit));
      wrap.appendChild(row);
      var hint = f.hint || "";
      var lim = f.gt ? "More than " + f.min + ", up to " + f.max + "." : "From " + f.min + " to " + f.max + ".";
      if (f.builtin != null) lim += " Helm's built-in value is " + f.builtin + ".";
      var h = el("p", "lrx-hint", (hint ? hint + " " : "") + lim); h.id = id + "_h"; wrap.appendChild(h);
      var er = el("p", "lrx-err"); er.id = id + "_e"; er.setAttribute("role", "alert"); er.hidden = !errs[f.key]; er.textContent = errs[f.key] || ""; wrap.appendChild(er);
      inp.setAttribute("aria-describedby", h.id + " " + er.id);
      if (errs[f.key]) inp.setAttribute("aria-invalid", "true");
      [minus, inp, plus].forEach(function (x) { x.disabled = !canEdit; });
      function commit(v) {
        d[f.key] = v; inp.value = String(v);
        var c = checkNumber(f, v);
        errs[f.key] = c.ok ? "" : c.error; er.textContent = errs[f.key]; er.hidden = c.ok;
        if (c.ok) inp.removeAttribute("aria-invalid"); else inp.setAttribute("aria-invalid", "true");
        minus.disabled = !canEdit || (c.ok && (f.gt ? c.value - f.step <= f.min : c.value <= f.min));
        plus.disabled = !canEdit || (c.ok && c.value >= f.max);
        pv(); syncBar(); say("", "");
      }
      function bump(dir) {
        var c = checkNumber(f, inp.value), n = c.ok ? c.value : (f.builtin != null ? f.builtin : f.min);
        n = round(n + dir * f.step, f.dp ? 2 : 0);
        if (f.gt && n <= f.min) n = round(f.step, 2);
        n = Math.min(f.max, Math.max(f.gt ? n : f.min, n));
        commit(n);
      }
      minus.addEventListener("click", function () { bump(-1); });
      plus.addEventListener("click", function () { bump(1); });
      inp.addEventListener("input", function () { commit(inp.value.trim()); });
      inp.addEventListener("keydown", function (e) { if (e.key === "ArrowUp") { e.preventDefault(); bump(1); } else if (e.key === "ArrowDown") { e.preventDefault(); bump(-1); } });
      var c0 = checkNumber(f, inp.value);
      if (c0.ok) { minus.disabled = !canEdit || (f.gt ? c0.value - f.step <= f.min : c0.value <= f.min); plus.disabled = !canEdit || c0.value >= f.max; }
      return wrap;
    }
    function toggle(t, r, d, pv) {
      var lab = el("label", "lrx-tg"); var cb = el("input"); cb.type = "checkbox"; cb.checked = !!d[t.key]; cb.disabled = !canEdit; cb.dataset.key = t.key;
      var sw = el("span", "lrx-sw"); sw.setAttribute("aria-hidden", "true");
      var tx = el("span", "lrx-tg-text"); tx.appendChild(el("span", "lrx-tg-l", t.label)); if (t.hint) tx.appendChild(el("span", "lrx-tg-h", t.hint));
      lab.appendChild(cb); lab.appendChild(sw); lab.appendChild(tx);
      cb.addEventListener("change", function () { d[t.key] = cb.checked; pv(); syncBar(); say("", ""); });
      return lab;
    }

    function renderEditor() {
      ed.textContent = "";
      var r = rowOf(cur); if (!r) { ed.appendChild(el("p", "lrx-note", "No layout rules yet.")); return; }
      var d = draftOf(r);
      var head = el("div", "lrx-head");
      head.appendChild(el("h4", "lrx-title", title(r.event_type)));
      if (canEdit) {
        var acts = el("div", "lrx-acts");
        var cp = el("select", "lrx-copy"); cp.setAttribute("aria-label", "Copy settings from another event type");
        var o0 = el("option", null, "Copy from…"); o0.value = ""; cp.appendChild(o0);
        rows.forEach(function (x) { if (String(x.id) === cur) return; var o = el("option", null, title(x.event_type)); o.value = x.id; cp.appendChild(o); });
        cp.addEventListener("change", function () {
          var src = rowOf(cp.value); if (!src) return;
          drafts[cur] = rawFrom(null, null); var sd = draftOf(src); for (var k in sd) drafts[cur][k] = sd[k];
          errs = {}; renderEditor(); syncBar(); say("ok", "Copied from " + title(src.event_type) + " - press Save changes to keep it.");
        });
        var rs = el("button", "btn sm lrx-reset", "Reset to Helm default"); rs.type = "button";
        rs.addEventListener("click", function () {
          drafts[cur] = rawFrom(helmDefault(r.event_type), r.event_type); errs = {}; renderEditor(); syncBar();
          say("ok", "Reset to Helm's defaults for " + title(r.event_type) + " - press Save changes to keep it.");
        });
        acts.appendChild(cp); acts.appendChild(rs); head.appendChild(acts);
      }
      ed.appendChild(head);

      // live preview for a sample guest count
      var pvBox = el("div", "lrx-pv"); var pvTop = el("div", "lrx-pv-top");
      var pl = el("label", "lrx-pv-l", "Preview for"); pl.htmlFor = "lrx_sample";
      var sIn = el("input", "lrx-in lrx-sample"); sIn.id = "lrx_sample"; sIn.type = "text"; sIn.inputMode = "numeric"; sIn.value = String(sample);
      pvTop.appendChild(pl); pvTop.appendChild(sIn); pvTop.appendChild(el("span", "lrx-unit", "guests"));
      var pvText = el("p", "lrx-pv-text"); pvText.setAttribute("aria-live", "polite");
      pvBox.appendChild(pvTop); pvBox.appendChild(pvText);
      function pv() { pvText.textContent = preview(d, r.event_type, sample); }
      sIn.addEventListener("input", function () { var n = parseInt(sIn.value, 10); sample = n >= 0 && n <= 20000 ? n : 0; pv(); });

      function group(name, kind) {
        var g = el("fieldset", "lrx-grp"); g.appendChild(el("legend", null, name));
        var grid = el("div", kind === "t" ? "lrx-tgs" : "lrx-grid"); g.appendChild(grid); ed.appendChild(g); return grid;
      }
      var gs = group("Seating"), gf = group("Food and drink"), gfl = group("On the floor", "t");
      FIELDS.forEach(function (f) { (f.group === "seat" ? gs : f.group === "food" ? gf : gfl).appendChild(stepper(f, r, d, pv)); });
      TOGGLES.forEach(function (t) { if (t.group === "floor") gfl.appendChild(toggle(t, r, d, pv)); });
      var gn = group("Planner notes", "t");
      gn.parentNode.appendChild(el("p", "lrx-hint", "Kept with the rule for your team; the generator does not place these on its own."));
      TOGGLES.forEach(function (t) { if (t.group === "note") gn.appendChild(toggle(t, r, d, pv)); });
      ed.appendChild(pvBox); pv();
    }

    function openAdd() {
      var existing = list.querySelector(".lrx-addform"); if (existing) { existing.querySelector("input").focus(); return; }
      var f = el("form", "lrx-addform"); f.noValidate = true;
      var id = "lrx_newtype"; var l = el("label", "lrx-lab", "New event type"); l.htmlFor = id;
      var i = el("input", "lrx-in lrx-newname"); i.id = id; i.maxLength = 40; i.placeholder = "e.g. Mehendi"; i.autocomplete = "off";
      var er = el("p", "lrx-err"); er.setAttribute("role", "alert"); er.hidden = true;
      var row = el("div", "lrx-addrow");
      var ok = el("button", "btn primary sm", "Add"); ok.type = "submit";
      var no = el("button", "btn sm", "Cancel"); no.type = "button";
      row.appendChild(ok); row.appendChild(no);
      f.appendChild(l); f.appendChild(i); f.appendChild(er); f.appendChild(row);
      list.appendChild(f); i.focus();
      no.addEventListener("click", function () { f.remove(); });
      f.addEventListener("submit", function (e) {
        e.preventDefault();
        var c = checkType(i.value, rows.map(function (x) { return x.event_type; }));
        if (!c.ok) { er.textContent = c.error; er.hidden = false; i.setAttribute("aria-invalid", "true"); return; }
        var src = rowOf(cur), rules = src ? build(src.rules, rawFrom(src.rules, src.event_type)).value : helmDefault(c.value);
        var seq = rows.reduce(function (m, x) { return Math.max(m, +x.seq || 0); }, 0) + 1;
        ok.disabled = true;
        Promise.resolve(store.create({ event_type: c.value, rules: rules, seq: seq })).then(function (row) {
          rows.push(row); f.remove(); renderList(); select(row.id); say("ok", "Added " + title(c.value) + " (a copy of the type you had open). Adjust it and save.");
        }).catch(function (e2) { ok.disabled = false; er.textContent = errMsg(e2, "add the event type"); er.hidden = false; });
      });
    }

    discard.addEventListener("click", function () { drafts = {}; errs = {}; renderList(); renderEditor(); syncBar(); say("", "Changes discarded."); });
    save.addEventListener("click", function () {
      var d = dirtyRows(), bad = null, plan = [];
      d.forEach(function (r) { var b = build(r.rules, drafts[String(r.id)]); if (!b.ok) { if (!bad) bad = r; } else plan.push([r, b.value]); });
      if (bad) { select(bad.id); errs = build(bad.rules, drafts[String(bad.id)]).errors; renderEditor(); say("err", "Fix the highlighted values in " + title(bad.event_type) + " first."); return; }
      save.disabled = true; say("", "Saving…");
      var failed = [];
      plan.reduce(function (p, it) {
        return p.then(function () {
          return Promise.resolve(store.update(it[0].id, { rules: it[1] })).then(function () { it[0].rules = it[1]; delete drafts[String(it[0].id)]; })
            .catch(function (e) { failed.push(title(it[0].event_type) + ": " + errMsg(e, "save")); });
        });
      }, Promise.resolve()).then(function () {
        save.disabled = false; syncBar(); renderEditor();
        if (failed.length) say("err", "Not saved - " + failed.join(" "));
        else say("ok", "Saved. New layouts use these rules.");
      });
    });
    global.addEventListener("beforeunload", function (e) { if (canEdit && dirtyRows().length) { e.preventDefault(); e.returnValue = ""; } });

    renderList(); renderEditor(); syncBar();
    return { dirty: function () { return dirtyRows().length; }, select: select };
  }

  global.HelmLayoutRules = { core: core, mount: mount };
  if (typeof module !== "undefined" && module.exports) module.exports = global.HelmLayoutRules;
})(typeof window !== "undefined" ? window : globalThis);
