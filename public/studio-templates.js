/* studio-templates.js (0096) - a studio's OWN floor-layout templates.
 *   Builder:  "My studio templates" listed FIRST in the Template dropdown + template picker,
 *             "Save as template" (name, event type, description, preview from the 2D floor),
 *             "My templates" manager (use, rename, duplicate, archive / restore, default per event type),
 *             template-edit mode (?tplEdit=new | <id>): blank hall + name field + "Save template".
 *             Applying a template scales / clamps it to the CURRENT hall and re-applies the exact
 *             seat count (exactSeats) when a quote is open.
 *   Layout wizard: "Start from my template" opens the picker (studio templates first).
 *   Settings: "Layout templates" tab (#pane-ltemplates) with the same manager.
 *   Cards without a stored picture draw a preview from the layout itself (core previewShapes).
 *   Free-trial studio (subscription status "trial"): templates can only be USED - no new / edit /
 *   rename / duplicate / archive / default, no "Save as template", archived ones never listed.
 * DOM nodes only (no HTML strings). The server enforces access again (has_area layouts / controls). */
(function (G) {
  "use strict";
  var C = G.HelmStudioTemplatesCore, doc = G.document;
  if (!C || !doc) return;
  var S = function () { return G.BPStore; };
  var $ = function (id) { return doc.getElementById(id); };
  function h(tag, attrs, kids) {
    var el = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      var v = attrs[k]; if (v === undefined || v === null || v === false) return;
      if (k === "text") el.textContent = v; else if (k === "cls") el.className = v;
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v); else el.setAttribute(k, v === true ? "" : v);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(typeof c === "string" ? doc.createTextNode(c) : c); });
    return el;
  }
  function toast(msg, err) { try { if (G.BPUI && G.BPUI.toast) G.BPUI.toast(msg, err ? { type: "err" } : undefined); } catch (_) {} }
  function friendly(e, action) { try { return (G.BPUI && G.BPUI.friendlyError) ? G.BPUI.friendlyError(e, { action: action || "save the template" }) : String(e && e.message || e); } catch (_) { return String(e && e.message || e); } }
  function typeOpts(cur) {
    return [h("option", { value: "", text: "Any event type" })].concat(C.EVENT_TYPES.map(function (t) { return h("option", { value: t[0], text: t[1], selected: t[0] === cur }); }));
  }

  // view / edit come from the access matrix; manage = edit AND not a free-trial studio
  var perm = { view: false, edit: false, manage: false, trial: false, ready: null };
  // free trial = the studio's subscription status is "trial" (the same test as trial-lock.js and the server's 0173 / 0181
  // guards), never trial_ends_at. 0181: waits a little for trial-lock.js (store-api.js loads it) when nothing can answer yet.
  async function isTrial() {
    try { if (G.HelmTrialLock && G.HelmTrialLock.isTrial && G.HelmTrialLock.isTrial()) return true; } catch (_) {}
    var sub = function () { var st = S(); return st && st.subscription && st.subscription.trial ? st : null; };
    for (var i = 0; i < 30 && !(G.HelmTrialLock && G.HelmTrialLock.whenKnown) && !sub(); i++) await new Promise(function (r) { setTimeout(r, 200); });
    try { if (G.HelmTrialLock && G.HelmTrialLock.whenKnown) return !!(await G.HelmTrialLock.whenKnown()); } catch (_) {}
    try {
      var st = sub(); if (st) { var t = await st.subscription.trial(); if (t && t.status === "trial") return true; }
    } catch (_) {}
    try { return !!(doc.documentElement && doc.documentElement.classList.contains("helm-trial")); } catch (_) { return false; }
  }
  function loadPerm() {
    if (perm.ready) return perm.ready;
    perm.ready = (async function () {
      var st = S(); if (!st || !st.auth) return perm;
      perm.trial = await isTrial();
      var role = null; try { role = await st.auth.role(); } catch (_) {}
      if (role === "admin") { perm.view = perm.edit = true; perm.manage = !perm.trial; return perm; }
      var ce = function (a) { return st.auth.canEditArea ? st.auth.canEditArea(a).catch(function () { return false; }) : false; };
      var cv = function (a) { return st.auth.canView ? st.auth.canView(a).catch(function () { return false; }) : false; };
      perm.edit = !!((await ce("layouts")) || (await ce("controls")));
      perm.view = perm.edit || !!((await cv("layouts")) || (await cv("controls")));
      perm.manage = perm.edit && !perm.trial;
      return perm;
    })();
    return perm.ready;
  }
  var TRIAL_MSG = "Not available in the free trial - you can use these sample layouts. Upgrade to make your own templates.";
  var rows = [], rowsLoaded = false;
  async function reload(all) {
    try { rows = await S().layoutTemplates.list({ all: !!all, lite: true }); rowsLoaded = true; }
    catch (e) { rows = []; rowsLoaded = false; throw e; }
    return rows;
  }

  /* ---------------- builder glue (builder.js globals, read defensively) ---------------- */
  /* eslint-disable no-undef */
  var B = {
    store: function () { return typeof store !== "undefined" ? store : null; },
    world: function () { return typeof WORLD !== "undefined" ? WORLD : null; },
    caps: function () { return typeof CAPS !== "undefined" ? CAPS : null; },
    quoteId: function () { return typeof currentQuoteId !== "undefined" ? currentQuoteId : null; },
    ro: function () { return typeof RO !== "undefined" ? !!RO : false; },
    pricing: function () { return typeof PRICING !== "undefined" ? PRICING : null; },
    fn: function (n) { try { return { loadItems: typeof loadItems !== "undefined" ? loadItems : null, exactSeats: typeof exactSeats !== "undefined" ? exactSeats : null,
      sumSeats: typeof sumSeats !== "undefined" ? sumSeats : null, quoteChairsNow: typeof quoteChairsNow !== "undefined" ? quoteChairsNow : null,
      seatFitWarning: typeof seatFitWarning !== "undefined" ? seatFitWarning : null, sizeCanvas: typeof sizeCanvas !== "undefined" ? sizeCanvas : null,
      updateDimsLabel: typeof updateDimsLabel !== "undefined" ? updateDimsLabel : null, openTemplatePicker: typeof openTemplatePicker !== "undefined" ? openTemplatePicker : null,
      renderAll: typeof renderAll !== "undefined" ? renderAll : null, lfAsk: typeof lfAsk !== "undefined" ? lfAsk : null,
      lfUseSize: typeof lfUseSize !== "undefined" ? lfUseSize : null, lfNote: typeof lfNote !== "undefined" ? lfNote : null, fitView: typeof fitView !== "undefined" ? fitView : null,
      updateEmptyState: typeof updateEmptyState !== "undefined" ? updateEmptyState : null, resetHistory: typeof resetHistory !== "undefined" ? resetHistory : null,
      setSavedBaseline: typeof setSavedBaseline !== "undefined" ? setSavedBaseline : null,
      seatsFittedNotice: typeof seatsFittedNotice !== "undefined" ? seatsFittedNotice : null,
      loadTemplate: typeof loadTemplate !== "undefined" ? loadTemplate : null }[n] || null; } catch (_) { return null; } },
    // R89: a fresh copy of a built-in starter layout's items (builder.js TEMPLATES); null when unknown
    builtinItems: function (key) { try { return C.builtin(key) && typeof TEMPLATES !== "undefined" && typeof TEMPLATES[key] === "function" ? TEMPLATES[key]() : null; } catch (_) { return null; } },
  };
  /* eslint-enable no-undef */
  var isBuilder = !!$("preset");

  // a small JPEG of the 2D floor (the same SVG the builder draws); null when the browser can't
  function captureThumb() {
    return new Promise(function (resolve) {
      try {
        var svg = $("svg"); if (!svg || !G.XMLSerializer) return resolve(null);
        var W = B.world() || { w: 200, h: 140 };
        var clone = svg.cloneNode(true);
        var vb = svg.getAttribute("viewBox"); if (!vb) { var bb = svg.getBoundingClientRect(); vb = "0 0 " + Math.max(1, bb.width) + " " + Math.max(1, bb.height); clone.setAttribute("viewBox", vb); }
        clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        var src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new G.XMLSerializer().serializeToString(clone));
        var img = new G.Image();
        img.onload = function () {
          try {
            var tw = 360, th = Math.max(60, Math.min(360, Math.round(tw * (W.h / W.w))));
            var cv = doc.createElement("canvas"); cv.width = tw; cv.height = th;
            var cx = cv.getContext("2d"); cx.fillStyle = "#ffffff"; cx.fillRect(0, 0, tw, th); cx.drawImage(img, 0, 0, tw, th);
            var d = cv.toDataURL("image/jpeg", 0.72); resolve(C.thumbOk(d) ? d : null);
          } catch (_) { resolve(null); }
        };
        img.onerror = function () { resolve(null); };
        img.src = src;
        setTimeout(function () { resolve(null); }, 4000);
      } catch (_) { resolve(null); }
    });
  }

  async function apply(id) {
    if (!isBuilder) return;
    if (B.ro()) { toast("Read-only - cannot load a template here", true); return; }
    // free trial (0181): the "Start blank" card clears the floor (the picker already asked before replacing it)
    if (id === "__blank") {
      var st0 = B.store(), lb = B.fn("loadItems");
      if (st0 && st0.items && st0.items.length && lb) lb([], null);
      var eb = $("emptyState"); if (eb) eb.hidden = true; return;
    }
    // r20 (live QA): one load per pick. A slow template read that finishes after a newer pick (another template, a
    // built-in layout, a past event) is dropped instead of popping a stale "bigger than your hall" window or replacing
    // the newer floor; a slow read says "Loading..." instead of looking like nothing happened.
    var seq = G.__helmTplLoad = (G.__helmTplLoad || 0) + 1;
    var live = function () { return G.__helmTplLoad === seq; };
    var slow = setTimeout(function () { if (live()) toast("Loading the template…"); }, 350);
    var row; try { row = await S().layoutTemplates.get(id); } catch (e) { clearTimeout(slow); if (live()) toast(friendly(e, "load the template"), true); return; }
    clearTimeout(slow);
    if (!live()) return;
    if (!row || !row.data) { toast("That template could not be found.", true); return; }
    // load-fit.js: bigger than this hall → Fit to my hall / Use the layout's size / Cancel
    var lfSz = G.HelmLoadFit ? G.HelmLoadFit.size(row.data) : null, ask = B.fn("lfAsk");
    var fitChoice = ask && lfSz ? await ask(lfSz) : "ok";
    if (fitChoice === "cancel" || !live()) return;
    if (fitChoice === "size") { var us = B.fn("lfUseSize"); if (us) us(lfSz); }
    var W = B.world() || { w: 200, h: 140 }, caps = B.caps() || {};
    var fit = C.fitToHall(row.data, { w: W.w, h: W.h }, caps.hall || 1000);
    var items = fit.items, N = 0;
    try { var qc = B.fn("quoteChairsNow"); if (B.quoteId() && qc) N = +qc() || 0; } catch (_) {}
    var ex = B.fn("exactSeats"), ss = B.fn("sumSeats");
    var natSeats = 0, fullItems = null;
    if (N > 0 && ex) {
      var nat = natSeats = ss ? ss(items) : 0;
      if (nat > N) { try { fullItems = JSON.parse(JSON.stringify(items)); } catch (_) { fullItems = null; } }   // r22: kept for "Use the template's N seats"
      ex(items, N);
      var sw = B.fn("seatFitWarning"), pr = B.pricing() || {};
      var w = sw ? sw(N, nat, null, pr.eventType) : null; if (w) setTimeout(function () { toast("⚠ " + w, true); }, 50);
    }
    var li = B.fn("loadItems"); if (!li) return;
    var nm = trialName(row.name) || row.name;   // QA-B27: "Demo · Corporate — Round tables gala" -> "Corporate — Round tables gala"
    li(items, nm);
    if (fitChoice === "fit") { var nt = B.fn("lfNote"); if (nt) nt(row.data.items || []); }
    var es = $("emptyState"); if (es) es.hidden = true;
    toast(nm + " loaded" + (fit.scaled ? " · fitted to your " + fit.hall.w + "×" + fit.hall.h + " ft hall" : ""));
    // r22: the seating was trimmed to the quote's chairs - say so, with a one-off way to keep the template's full seating
    var sfn = B.fn("seatsFittedNotice"); if (sfn && fullItems) sfn(N, natSeats, fullItems, seq);
  }
  // r22 (live QA): "Political rally — 5,000 seats" read as a fixed 5,000; an open quote fits the seating to its guests,
  // so the list says it scales: "Political rally (up to 5,000 seats)"
  function scaleName(n) { return String(n || "").replace(/\s*[\u2014\u2013-]\s*([\d,]+)\s+seats\s*$/i, " (up to $1 seats)"); }

  // "My studio templates" as the FIRST optgroup of #preset (the template picker is built from it)
  async function fillPreset() {
    var sel = $("preset"); if (!sel) return;
    var pr = B.pricing() || {};
    // free-trial studio: ONLY its sample layouts + "Start blank" + past events, never the built-in presets.
    // 0181: decided BEFORE the empty-list return, so a trial studio with no layout templates left (e.g. after
    // Clear sample data) still gets the trial gallery with "Start blank", not the built-in presets
    var trial = await isTrial();
    var old = $("st_optgroup"); if (old) old.remove();
    var list = C.order(rows.filter(function (r) { return !r.archived; }), pr.eventType);
    if (!trial && !list.length) return;
    var opts = list.map(function (r) { return h("option", { value: "st:" + r.id, text: (r.is_default ? "\u2605 " : "") + scaleName(trial ? trialName(r.name) : r.name) + (r.event_type ? " \u00b7 " + C.label(r.event_type) : "") }); });
    if (trial) opts.unshift(h("option", { value: "st:__blank", text: "Start blank" }));
    var og = h("optgroup", { id: "st_optgroup", label: trial ? "Sample layouts" : "My studio templates" }, opts);
    if (trial) {
      Array.prototype.slice.call(sel.querySelectorAll("optgroup")).forEach(function (g) { if (g.id !== "st_optgroup" && g.id !== "st_pastgroup") g.remove(); });
      fillPast(sel);
      // r19: the trial's past events are listed under "From past events" in this dropdown, so the separate
      // "Reference a past layout" dropdown only repeated them. It stays in the page (it feeds that list and
      // its loader), just out of sight.
      var rf = $("refField"); if (rf) rf.hidden = true;
    }
    var first = sel.querySelector("optgroup"); sel.insertBefore(og, first || null);
  }
  // "Demo · Wedding — Grand Lawn" -> "Wedding — Grand Lawn"
  function trialName(n) { return String(n || "").replace(/^Demo \u00b7 /, ""); }
  // trial: "From past events" = the studio's own earlier events (the builder's #refEvents reference picker)
  function fillPast(sel) {
    var old = $("st_pastgroup"); if (old) old.remove();
    var ref = $("refEvents"); if (!ref) return;
    var opts = Array.prototype.slice.call(ref.querySelectorAll("option")).filter(function (o) { return o.value; });
    if (!opts.length) { if (fillPast.tries == null) fillPast.tries = 0; if (fillPast.tries++ < 20) setTimeout(function () { fillPast(sel); }, 700); return; }
    sel.appendChild(h("optgroup", { id: "st_pastgroup", label: "From past events" },
      opts.map(function (o) { return h("option", { value: "ref:" + o.value, text: o.textContent }); })));
  }

  /* ---------------- manager (builder modal + Settings pane) ---------------- */
  // a card preview drawn from the layout JSON when the template has no stored picture (SQL-seeded samples,
  // or a browser that could not capture one). DOM nodes only; never written back to the template.
  var SVGNS = "http://www.w3.org/2000/svg";
  function svgEl(tag, attrs) {
    var el = doc.createElementNS(SVGNS, tag);
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, String(attrs[k])); });
    return el;
  }
  function r2(v) { return Math.round(v * 100) / 100; }
  function previewSvg(data, name) {
    var P = C.previewShapes(data, 1500); if (!P.rects.length) return null;
    var sw = r2(Math.max(P.w, P.h) / 300);
    var sv = svgEl("svg", { viewBox: "0 0 " + P.w + " " + P.h, preserveAspectRatio: "xMidYMid meet", role: "img",
      "aria-label": "Preview of " + name, "class": "st-thumb st-gen" });
    sv.appendChild(svgEl("rect", { x: 0, y: 0, width: P.w, height: P.h, fill: "#ffffff", stroke: "#c4cbc4", "stroke-width": sw * 1.5 }));
    P.rects.forEach(function (q) {
      var cx = r2(q.x + q.w / 2), cy = r2(q.y + q.h / 2);
      var e = q.round ? svgEl("ellipse", { cx: cx, cy: cy, rx: r2(q.w / 2), ry: r2(q.h / 2) })
        : svgEl("rect", { x: r2(q.x), y: r2(q.y), width: r2(q.w), height: r2(q.h), rx: r2(Math.min(q.w, q.h) * 0.08) });
      e.setAttribute("fill", q.fill); e.setAttribute("fill-opacity", "0.5"); e.setAttribute("stroke", q.fill); e.setAttribute("stroke-width", String(sw));
      if (q.rot) e.setAttribute("transform", "rotate(" + q.rot + " " + cx + " " + cy + ")");
      sv.appendChild(e);
    });
    return sv;
  }
  var dataCache = {}, dataQueue = [], dataBusy = 0;
  function layoutData(r) {
    var key = r.id + "|" + (r.updated_at || "");
    if (dataCache[key]) return dataCache[key];
    dataCache[key] = new Promise(function (resolve) {
      dataQueue.push(function () {
        return Promise.resolve().then(function () { return S().layoutTemplates.get(r.id); })
          .then(function (row) { resolve(row && row.data ? row.data : null); }, function () { delete dataCache[key]; resolve(null); });
      });
      pump();
    });
    return dataCache[key];
  }
  function pump() {   // at most 4 template reads at a time
    while (dataBusy < 4 && dataQueue.length) {
      dataBusy++; dataQueue.shift()().then(function () { dataBusy--; pump(); }, function () { dataBusy--; pump(); });
    }
  }
  function thumbEl(r, label) {
    var name = label || r.name;
    if (r.thumbnail && C.thumbOk(r.thumbnail)) return h("img", { cls: "st-thumb", src: r.thumbnail, alt: "Preview of " + name, loading: "lazy" });
    var ph = h("div", { cls: "st-thumb st-nothumb", "aria-hidden": "true", text: "📐" });
    var draw = function (data) { var sv = data ? previewSvg(data, name) : null; if (sv && ph.parentNode) ph.parentNode.replaceChild(sv, ph); };
    if (r.data) { setTimeout(function () { draw(r.data); }, 0); return ph; }
    if (r.id && S() && S().layoutTemplates && S().layoutTemplates.get) {
      ph.classList.add("st-loading");
      layoutData(r).then(function (d) { ph.classList.remove("st-loading"); draw(d); });
    }
    return ph;
  }
  function renderManager(root, opts) {
    opts = opts || {};
    var state = { showArchived: false, renaming: null, draft: null, err: "", msg: "", ver: null };
    async function refresh() { try { await reload(true); state.err = ""; } catch (e) { state.err = friendly(e, "load templates"); } paint(); if (isBuilder) fillPreset(); }
    async function act(p, msg) { try { await p; state.msg = msg; state.err = ""; } catch (e) { state.err = friendly(e); state.msg = ""; } await refresh(); }
    // the manager's own permission + trial answer arrives before the first paint
    var ready = loadPerm();
    // Rename: name trimmed + inner spaces / control characters collapsed, 1-120 characters, no < >.
    // A bad name or a failed save shows the message under the box and KEEPS what was typed; the Save
    // button is disabled while the save runs (no double submit); an unchanged name just closes the box.
    // -> true when shown inline (Settings); elsewhere the message goes to the manager's error line
    function renameErr(inp, msg) {
      var F = G.HelmCCFields;
      if (F && F.fieldError && inp.parentNode) { F.fieldError(inp, msg || "", inp.parentNode.lastChild); return true; }
      if (msg) { state.err = msg; paint(); }
      return false;
    }
    async function renameSave(r, inp, tsel, btn) {
      if (btn.disabled) return;
      var nm = String(inp.value == null ? "" : inp.value).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
      var v = C.validate({ name: nm, event_type: tsel.value, description: r.description });
      var bad = !v.ok ? v.errors[0].msg : /[<>]/.test(nm) ? "The name can't contain < or >." : "";
      if (bad) { state.draft = { id: r.id, name: inp.value, event_type: tsel.value }; renameErr(inp, bad); try { inp.focus(); } catch (_) {} return; }
      if (v.value.name === r.name && (v.value.event_type || "") === (r.event_type || "")) { state.renaming = null; state.draft = null; paint(); return; }
      inp.value = v.value.name; btn.disabled = true; inp.readOnly = true;
      try {
        await S().layoutTemplates.save(r.id, v.value);
        state.renaming = null; state.draft = null; state.msg = "Template renamed."; state.err = "";
        await refresh();
      } catch (e) {
        btn.disabled = false; inp.readOnly = false; state.msg = "";
        state.draft = { id: r.id, name: inp.value, event_type: tsel.value };
        renameErr(inp, friendly(e)); try { inp.focus(); } catch (_) {}
      }
    }
    // R89 (0310): a studio template's saved versions; "Put back" re-saves that layout through studio_template_save,
    // so it becomes the newest version (nothing is overwritten or removed)
    async function openVersions(r) {
      if (state.ver && state.ver.id === r.id) { state.ver = null; paint(); return; }
      state.ver = { id: r.id, rows: null, err: "" }; paint();
      var v = state.ver;
      try { v.rows = (S().layoutTemplates.versions ? await S().layoutTemplates.versions(r.id) : []) || []; }
      catch (e) { v.err = friendly(e, "load the versions"); v.rows = []; }
      if (state.ver === v) paint();
    }
    async function restoreVersion(r, vr, btn) {
      if (btn.disabled) return;
      if (G.BPUI && G.BPUI.confirm && !(await G.BPUI.confirm("Put back version " + vr.version_no + " of this template? It is saved as a new version - the current layout stays in the history.", { title: "Put back this version?", okLabel: "Put back" }))) return;
      btn.disabled = true;
      try {
        var full = await S().layoutTemplates.getVersion(vr.id);
        if (!full || !full.data) throw new Error("That version could not be found.");
        await S().layoutTemplates.save(r.id, { name: r.name, event_type: r.event_type || "", description: r.description || "", data: full.data, thumbnail: null });
        state.ver = null; state.msg = "Version " + vr.version_no + " put back (saved as the newest version)."; state.err = "";
      } catch (e) { state.err = friendly(e); state.msg = ""; }
      await refresh();
    }
    function versionsBox(r) {
      var v = state.ver, M = perm.manage;
      var kids = [h("b", { cls: "st-ver-h", text: "Versions" })];
      if (!v.rows) kids.push(h("p", { cls: "mnote", text: "Loading versions\u2026" }));
      else if (v.err) kids.push(h("p", { cls: "st-err", role: "alert", text: v.err }));
      else if (!v.rows.length) kids.push(h("p", { cls: "mnote", text: "No saved versions yet - the next save in the builder becomes version 1." }));
      else kids.push(h("ol", { cls: "st-ver-list" }, v.rows.map(function (vr, i) {
        var when = ""; try { when = S().fmtDateTime ? S().fmtDateTime(vr.created_at) : new Date(vr.created_at).toLocaleString(); } catch (_) { when = String(vr.created_at || ""); }
        var pb = M && i > 0 ? h("button", { type: "button", cls: "btn sm", text: "Put back" }) : null;
        if (pb) pb.addEventListener("click", function () { restoreVersion(r, vr, pb); });
        return h("li", { cls: "st-ver-row" }, [h("span", { cls: "st-ver-no", text: "v" + vr.version_no + (i === 0 ? " (current)" : "") }),
          h("span", { cls: "st-ver-when", text: when }), pb]);
      })));
      return h("div", { cls: "st-ver", role: "region", "aria-label": "Versions of " + r.name }, kids);
    }
    // R89: Helm's built-in starter layouts (read-only; "Customise" makes a studio copy). Never in a free trial.
    function builtinSection() {
      var M = perm.manage;
      var grid = h("div", { cls: "st-grid" });
      C.BUILTINS.forEach(function (b) {
        grid.appendChild(h("div", { cls: "st-card st-builtin" }, [
          h("div", { cls: "st-thumb st-nothumb st-bi-thumb", "aria-hidden": "true", text: "\ud83d\udcd0" }),
          h("b", { cls: "st-name", text: b[1], title: b[1] }),
          h("div", { cls: "st-badges" }, [h("span", { cls: "st-badge", text: C.label(b[2]) }), h("span", { cls: "st-badge st-bi", text: "Built-in" })]),
          h("div", { cls: "st-acts" }, [
            h("a", { cls: "btn sm primary", href: "builder.html?new=1&useBuiltin=" + encodeURIComponent(b[0]), text: "Use", title: "Start a new design from this built-in layout" }),
            M ? h("a", { cls: "btn sm", href: "builder.html?new=1&tplEdit=new&fromBuiltin=" + encodeURIComponent(b[0]), text: "Customise", title: "Save your own studio copy of this layout - the built-in original never changes" }) : null])]));
      });
      return h("section", { cls: "st-sec", id: "st_builtins", "aria-labelledby": "st_builtins_h" }, [
        h("h4", { cls: "st-sec-h", id: "st_builtins_h", text: "Built-in starter layouts" }),
        h("p", { cls: "mnote", text: "Ready-made by Helm. Use one as it is, or Customise it to save your own copy (with versions) under Your studio templates." }), grid]);
    }
    function paint() {
      root.textContent = "";
      var M = perm.manage, trial = perm.trial;
      var tools = h("div", { cls: "st-tools" }, [
        M && opts.newHref ? h("a", { cls: "btn primary sm", href: opts.newHref, text: "+ New template" }) : null,
        trial ? null : h("label", { cls: "st-chk" }, [h("input", { type: "checkbox", checked: state.showArchived, onchange: function (e) { state.showArchived = e.target.checked; paint(); } }), " Show archived"])]);
      if (opts.builtins && !trial) root.appendChild(h("h4", { cls: "st-sec-h", text: "Your studio templates" }));
      if (tools.childNodes.length) root.appendChild(tools);
      if (trial) root.appendChild(h("p", { cls: "st-trial", role: "note", text: "Free trial: these sample layouts are ready to use - open one in the builder to start a design. Making, renaming, duplicating or archiving templates opens when you upgrade." }));
      if (state.msg) root.appendChild(h("p", { cls: "st-ok", role: "status", text: state.msg }));
      if (state.err) root.appendChild(h("p", { cls: "st-err", role: "alert", text: state.err }));
      // archived templates are never listed in a free trial (0175 archives the retired sample layout)
      var list = rows.filter(function (r) { return !r.archived || (state.showArchived && !trial); });
      var tail = opts.builtins && !trial ? builtinSection() : null;
      if (!list.length) { root.appendChild(h("p", { cls: "mnote", text: rows.length && !trial ? "No live templates - tick Show archived to see archived ones." : (trial ? "No sample layouts in this trial studio." : "No studio templates yet. Customise a built-in layout below, or arrange a floor in the builder and use Save as template.") })); if (tail) root.appendChild(tail); return; }
      var grid = h("div", { cls: "st-grid" });
      list.forEach(function (r) {
        var nameNode;
        if (state.renaming === r.id) {
          var dr = state.draft && state.draft.id === r.id ? state.draft : null;   // what was typed survives a repaint
          var inp = h("input", { type: "text", value: dr ? dr.name : r.name, maxlength: String(C.LIMITS.name + 40), "aria-label": "New template name", "aria-required": "true", autocomplete: "off", cls: "st-rename" });
          var tsel = h("select", { "aria-label": "Event type" }, typeOpts(dr ? dr.event_type : (r.event_type || "")));
          var svb = h("button", { type: "button", cls: "btn sm primary", text: "Save", onclick: function () { renameSave(r, inp, tsel, svb); } });
          var cnl = function () { state.renaming = null; state.draft = null; paint(); };
          inp.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); svb.click(); } else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cnl(); } });
          inp.addEventListener("input", function () { state.draft = { id: r.id, name: inp.value, event_type: tsel.value }; if (G.HelmCCFields) renameErr(inp, ""); });
          tsel.addEventListener("change", function () { state.draft = { id: r.id, name: inp.value, event_type: tsel.value }; });
          nameNode = h("div", { cls: "st-renbox" }, [inp, tsel, svb,
            h("button", { type: "button", cls: "btn sm", text: "Cancel", onclick: cnl })]);
          setTimeout(function () { try { inp.focus(); } catch (_) {} }, 0);
        } else nameNode = h("b", { cls: "st-name", text: trial ? trialName(r.name) : r.name, title: trial ? trialName(r.name) : r.name });
        var badges = h("div", { cls: "st-badges" }, [h("span", { cls: "st-badge", text: C.label(r.event_type) }),
          r.is_default ? h("span", { cls: "st-badge st-def", text: "★ Default" }) : null, r.archived ? h("span", { cls: "st-badge st-arc", text: "Archived" }) : null]);
        // one primary action per card: Use (builder) / Edit layout (Settings) / Open in builder (trial or no edit)
        var canEdit = !!(M && opts.editHref);
        var acts = h("div", { cls: "st-acts" }, [
          opts.onUse && !r.archived ? h("button", { type: "button", cls: "btn sm primary", text: "Use", onclick: function () { opts.onUse(r); } }) : null,
          canEdit ? h("a", { cls: "btn sm primary", href: opts.editHref(r), text: "Edit layout", title: "Change this template's floor in the builder" }) : null,
          !opts.onUse && opts.useHref && !r.archived ? h("a", { cls: "btn sm" + (canEdit ? "" : " primary"), href: opts.useHref(r), text: "Open in builder", title: "Start a new design from this template" }) : null,
          M ? h("button", { type: "button", cls: "btn sm", text: "Rename", onclick: function () { state.renaming = r.id; paint(); } }) : null,
          M ? h("button", { type: "button", cls: "btn sm", text: "Duplicate", onclick: function () { act(S().layoutTemplates.duplicate(r.id), "Template duplicated."); } }) : null,
          M && !r.archived ? h("button", { type: "button", cls: "btn sm", text: r.is_default ? "Unset default" : "Set default",
            title: "Default template for " + C.label(r.event_type), onclick: function () { act(S().layoutTemplates.setDefault(r.id, !r.is_default), r.is_default ? "Default removed." : "Default set for " + C.label(r.event_type) + "."); } }) : null,
          M ? h("button", { type: "button", cls: "btn sm", text: r.archived ? "Restore" : "Archive", onclick: function () { act(S().layoutTemplates.setArchived(r.id, !r.archived), r.archived ? "Template restored." : "Template archived (it can be restored)."); } }) : null,
          opts.builtins && !trial ? h("button", { type: "button", cls: "btn sm", text: "Versions", "aria-expanded": state.ver && state.ver.id === r.id ? "true" : "false", onclick: function () { openVersions(r); } }) : null]);
        grid.appendChild(h("div", { cls: "st-card" + (r.archived ? " st-archived" : "") }, [thumbEl(r, trial ? trialName(r.name) : r.name), nameNode, badges,
          r.description ? h("p", { cls: "st-desc", text: r.description, title: r.description }) : null, acts,
          state.ver && state.ver.id === r.id ? versionsBox(r) : null]));
      });
      root.appendChild(grid);
      if (tail) root.appendChild(tail);
    }
    ready.then(refresh, refresh);
    return { refresh: refresh };
  }

  /* ---------------- builder modals ---------------- */
  function modal(id, title, bodyKids) {
    var old = $(id); if (old) old.remove();
    var close = function () { m.hidden = true; m.remove(); };
    var m = h("div", { cls: "modal st-modal", id: id, role: "dialog", "aria-modal": "true", "aria-labelledby": id + "_t" }, [
      h("div", { cls: "sheet" }, [h("div", { cls: "sheet-head" }, [h("b", { id: id + "_t", text: title }),
        h("button", { type: "button", cls: "tbtn icon", "aria-label": "Close", title: "Close", text: "✕", onclick: function () { close(); } })]),
        h("div", { cls: "sheet-body pad14" }, bodyKids)])]);
    m.addEventListener("click", function (e) { if (e.target === m) close(); });
    m.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.preventDefault(); close(); } });
    doc.body.appendChild(m); m.hidden = false;
    return { el: m, close: close };
  }
  // inline = the template-edit bar: one row of labelled fields, the description as a single-line input
  function metaForm(init, inline) {
    init = init || {};
    var name = h("input", { id: "st_f_name", type: "text", maxlength: String(C.LIMITS.name), required: true, value: init.name || "", placeholder: inline ? "e.g. Grand lawn wedding - 450 guests" : null });
    var type = h("select", { id: "st_f_type" }, typeOpts(init.event_type || ""));
    var desc = inline ? h("input", { id: "st_f_desc", type: "text", maxlength: String(C.LIMITS.description), value: init.description || "", placeholder: "Optional - what this layout is for" })
      : h("textarea", { id: "st_f_desc", maxlength: String(C.LIMITS.description), rows: "3" }, [init.description || ""]);
    var fld = function (cls, id, text, input) { return h("div", { cls: "st-fld " + cls }, [h("label", { "for": id, text: text }), input]); };
    var box = inline ? h("div", { cls: "st-form" }, [fld("st-fld-name", "st_f_name", "Template name *", name), fld("st-fld-type", "st_f_type", "Event type", type),
      fld("st-fld-desc", "st_f_desc", "Description", desc)])
      : h("div", { cls: "st-form" }, [
      h("label", { "for": "st_f_name", text: "Template name *" }), name,
      h("label", { "for": "st_f_type", text: "Event type" }), type,
      h("label", { "for": "st_f_desc", text: "Description" }), desc]);
    return { box: box, read: function () { return { name: name.value, event_type: type.value, description: desc.value }; }, focus: function () { name.focus(); } };
  }
  async function saveCurrent(id, meta, btn, errBox) {
    var st = B.store(), W = B.world() || { w: 200, h: 140 };
    var items = (st && st.items) || [];
    if (!items.length) { errBox.textContent = "The floor is empty - place some objects first."; errBox.hidden = false; return null; }
    btn.disabled = true; errBox.hidden = true;
    try {
      var thumb = await captureThumb();
      var p = C.payload(meta, items, W, thumb);
      var r = await S().layoutTemplates.save(id || null, p);
      await reload(true).catch(function () {}); fillPreset();
      return r;
    } catch (e) { errBox.textContent = e && e.field ? e.message : friendly(e); errBox.hidden = false; return null; }
    finally { btn.disabled = false; }
  }
  function openSaveModal() {
    if (perm.trial) { toast(TRIAL_MSG, true); return; }
    if (B.ro()) { toast("View only - your role can view layouts but not change them.", true); return; }   // r20-coord
    if (!perm.manage) { toast("You don't have access to create templates - ask an admin.", true); return; }
    var pr = B.pricing() || {}, pn = $("projName");
    var f = metaForm({ name: pn && pn.value && pn.value !== "Untitled event" ? pn.value : "", event_type: pr.eventType || "" });
    var err = h("p", { cls: "st-err", role: "alert", hidden: true });
    var btn = h("button", { type: "button", cls: "tbtn primary", id: "st_save", text: "Save template" });
    var m = modal("stSaveModal", "💾 Save as template", [
      h("p", { cls: "mnote", text: "Saves the current floor as your studio's own template. It is listed first in the template pickers and fits itself to each event's hall size." }),
      f.box, err, h("div", { cls: "st-foot" }, [btn])]);
    btn.addEventListener("click", async function () {
      var r = await saveCurrent(null, f.read(), btn, err);
      if (r) { m.close(); toast("Template “" + (r.name || "") + "” saved"); }
    });
    f.focus();
  }
  function openManager() {
    var root = h("div", { id: "st_mgr" });
    var m = modal("stMgrModal", "📐 My studio templates", [root]);
    renderManager(root, {
      newHref: "builder.html?new=1&tplEdit=new",
      onUse: async function (r) {
        var st = B.store();
        if (st && st.items && st.items.length && G.BPUI && G.BPUI.confirm && !(await G.BPUI.confirm("Load this template? It replaces the current floor (you can Undo).", { title: "Replace the floor?", okLabel: "Load template" }))) return;
        m.close(); apply(r.id);
      },
    });
  }

  // template-edit mode: ?tplEdit=new (blank hall) or ?tplEdit=<id>.
  // G.__helmTplEdit.mode tells builder.js updateEmptyState(): "loading" = show "Loading template..." (never the
  // "This event is a blank floor" prompt), "edit" / "error" = never the blank-floor prompt, "new" = the prompt is
  // offered as a template starter. Set from the URL at mount, before auth / permission / the template read finish.
  function tplState(mode) {
    G.__helmTplEdit = mode ? { mode: mode } : null;
    var ld = $("layoutLoading");
    if (ld) { var tn = ld.lastChild; if (tn && tn.nodeType === 3) { if (ld.dataset.stTxt == null) ld.dataset.stTxt = tn.nodeValue; tn.nodeValue = mode === "loading" ? "Loading template\u2026" : ld.dataset.stTxt; } }
    var es = $("emptyState"), hd = es && es.querySelector("h3"), pp = es && es.querySelector("p");
    if (hd) { if (hd.dataset.stTxt == null) { hd.dataset.stTxt = hd.textContent; if (pp) pp.dataset.stTxt = pp.textContent; }
      hd.textContent = mode === "new" ? "Your new template starts as a blank floor" : hd.dataset.stTxt;
      if (pp) pp.textContent = mode === "new" ? "Start from a layout or build it piece by piece - then name it and press Save template." : pp.dataset.stTxt; }
    var u = B.fn("updateEmptyState"); if (u) { try { u(); } catch (_) {} } else if (es && mode && mode !== "new") es.hidden = true;
  }
  function pause(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function readTemplate(id) {   // null = not found; throws after 3 tries on a network / server error
    var last = null;
    for (var i = 0; i < 3; i++) {
      try { return await S().layoutTemplates.get(id); } catch (e) { last = e; if (i < 2) await pause(700 * (i + 1)); }
    }
    throw last;
  }
  async function tplEditMode(param) {
    var editing = null, loadErr = null;
    if (param && param !== "new") {
      tplState("loading");
      try { editing = await readTemplate(param); } catch (e) { loadErr = e; }
      if (!editing && !loadErr) { toast("That template could not be found - starting a new one.", true); param = "new"; }
    }
    // R89: ?tplEdit=new&fromBuiltin=<key> - a NEW studio template that starts as a copy of a built-in layout
    var fromB = null;
    if (!editing && !loadErr) { try { fromB = C.builtin(new URLSearchParams(G.location.search).get("fromBuiltin")); } catch (_) { fromB = null; } }
    var old = $("st_editbar"); if (old) old.remove();
    var f = metaForm(editing || (fromB ? { name: fromB.name + " (my copy)", event_type: fromB.event_type } : {}), true);
    var err = h("p", { cls: "st-err", role: "alert", hidden: true });
    var btn = h("button", { type: "button", cls: "tbtn primary", id: "st_edit_save", text: "Save template" });
    var done = h("a", { cls: "tbtn", id: "st_edit_done", href: "control.html#layout-templates", text: "Done", title: "Back to Settings - Layout templates" });
    var title = h("b", { text: loadErr ? "Could not open this template" : (editing ? "Editing studio template" : "New studio template") });
    var bar = h("div", { cls: "st-editbar", id: "st_editbar", role: "region", "aria-label": "Template editing" }, [
      h("div", { cls: "st-eb-head" }, [title, h("p", { cls: "mnote", text: loadErr ? "Nothing was changed." : fromB ? "A copy of the built-in \u201c" + fromB.name + "\u201d - change it, then Save template. The built-in original never changes." : "Arrange the floor, name it, then Save template." })]),
      f.box, h("div", { cls: "st-eb-acts" }, [btn, done]), err]);
    doc.body.insertBefore(bar, doc.body.firstChild);
    if (loadErr) {   // never fall back to a blank "new" template on a read error - a Save would make a copy
      tplState("error");
      btn.textContent = "Retry"; btn.classList.remove("primary");
      btn.addEventListener("click", function () { try { G.location.reload(); } catch (_) {} });
      Array.prototype.forEach.call(f.box.querySelectorAll("input,select"), function (el) { el.disabled = true; });
      err.textContent = friendly(loadErr, "open the template"); err.hidden = false;
      return;
    }
    // start from a blank hall (or the template's own layout + hall size)
    var tries = 0;
    (function boot() {
      var li = B.fn("loadItems"), W = B.world(), st = B.store();
      if (!li || !W || !st || !G.BPStore) { if (tries++ < 40) setTimeout(boot, 250); return; }
      if (editing && editing.data) {
        // the template's own hall: data.room, or scale.worldFt / venue.room on the SQL-seeded samples
        var room = C.roomOf(editing.data) || {}, cap = (B.caps() || {}).hall || 1000;
        if (+room.w > 0) W.w = Math.max(20, Math.min(cap, Math.round(+room.w))); if (+room.h > 0) W.h = Math.max(20, Math.min(cap, Math.round(+room.h)));
        st.venue = st.venue || {}; st.venue.room = { w: W.w, h: W.h };
        var u = B.fn("updateDimsLabel"), sc = B.fn("sizeCanvas"); if (u) u(); if (sc) sc();
        tplState("edit");
        li(C.fitToHall(editing.data, W, cap).items, editing.name);
      } else if (fromB && B.builtinItems(fromB.key)) {
        tplState("edit"); li(B.builtinItems(fromB.key), fromB.name + " (my copy)");
      } else { tplState("new"); li([], "New template"); }
      // the opened template is the clean starting point: Undo does not go back to an empty floor, no "Unsaved changes"
      var rh = B.fn("resetHistory"), sb = B.fn("setSavedBaseline");
      try { if (rh) rh(); if (sb) sb(); } catch (_) {}
      var es = $("emptyState"); if (es && editing) es.hidden = true;
    })();
    btn.addEventListener("click", async function () {
      var r = await saveCurrent(editing ? editing.id : null, f.read(), btn, err);
      if (r) {
        editing = r; title.textContent = "Editing studio template"; tplState("edit"); toast("Template saved");
        var sb = B.fn("setSavedBaseline"); try { if (sb) sb(); } catch (_) {}
        try { G.history.replaceState(null, "", "builder.html?new=1&tplEdit=" + encodeURIComponent(r.id)); } catch (_) {}
      }
    });
  }

  function mountBuilder() {
    var sel = $("preset"); if (!sel) return;
    var field = sel.closest(".field") || sel.parentNode;
    var bSave = h("button", { type: "button", cls: "tbtn", id: "st_saveBtn", role: "menuitem", hidden: true, title: "Save the current floor as your studio's own template", text: "💾 Save as template" });
    var bMgr = h("button", { type: "button", cls: "tbtn", id: "st_mgrBtn", role: "menuitem", hidden: true, title: "Your studio's own layout templates", text: "📐 My templates" });
    bSave.addEventListener("click", openSaveModal); bMgr.addEventListener("click", openManager);
    field.parentNode.insertBefore(bMgr, field.nextSibling); field.parentNode.insertBefore(bSave, field.nextSibling);
    var tp0 = null, ub0 = null; try { tp0 = new URLSearchParams(G.location.search).get("tplEdit"); ub0 = new URLSearchParams(G.location.search).get("useBuiltin"); } catch (_) {}
    if (tp0 && tp0 !== "new") tplState("loading");   // no blank-floor flash while sign-in / permissions / the template load
    var tries = 0;
    (async function wait() {
      var st = S();
      if (!st || !st.auth || !st.auth.user || !st.auth.user() || !st.layoutTemplates) { if (tries++ < 80) setTimeout(wait, 250); else if (tp0) tplState(null); return; }
      await loadPerm();
      var trial = perm.trial;
      // R89 Settings "Use" on a built-in starter layout (?useBuiltin=<key>); the trial never gets the built-ins
      if (ub0 && !tp0) { if (trial) toast(TRIAL_MSG, true); else useBuiltinOnArrival(ub0); }
      if (!perm.view) { if (tp0) tplState(null); if (trial) fillPreset(); return; }   // 0181: the trial filter runs even without template access
      // free trial: the manager is use-only (sample layouts), never "Save as template"
      bMgr.hidden = false; bSave.hidden = !perm.manage || B.ro();
      var qs = null; try { qs = new URLSearchParams(G.location.search); } catch (_) {}
      var tp = qs ? qs.get("tplEdit") : null, use = qs ? qs.get("useTpl") : null;
      // template edit opens straight away; the picker list is filled alongside (it is not needed to edit)
      if (tp && perm.manage && !perm.trial) tplEditMode(/^(new|[0-9a-f-]{36})$/i.test(tp) ? tp : "new");
      else if (tp0) tplState(null);
      try { await reload(false); } catch (_) { bMgr.hidden = true; bSave.hidden = true; if (trial) fillPreset(); return; }
      fillPreset();
      // 0181: no template editing in the trial
      if (tp && perm.trial) toast(TRIAL_MSG, true);
      else if (tp && perm.manage) { /* opened above */ }
      else if (use && /^[0-9a-f-]{36}$/i.test(use)) useOnArrival(use);
    })();
    // 0181: trial-lock.js confirmed the free trial after the first fill: rebuild the gallery as the trial one
    if (G.addEventListener) G.addEventListener("helm:trial", function () { perm.trial = true; perm.manage = false; bSave.hidden = true; fillPreset(); });
  }

  // Settings "Open in builder" (?new=1&useTpl=<id>): load the template onto the new floor once the builder is ready
  function useOnArrival(id) {
    var tries = 0;
    (function go() {
      if (!B.fn("loadItems") || !B.world() || !B.store()) { if (tries++ < 40) setTimeout(go, 250); return; }
      apply(id).then(function () { try { var u = new URL(G.location.href); u.searchParams.delete("useTpl"); G.history.replaceState(null, "", u.pathname + u.search + u.hash); } catch (_) {} });
    })();
  }

  function useBuiltinOnArrival(key) {
    if (!C.builtin(key)) return;
    var tries = 0;
    (function go() {
      var lt = B.fn("loadTemplate");
      if (!lt || !B.fn("loadItems") || !B.world() || !B.store()) { if (tries++ < 40) setTimeout(go, 250); return; }
      Promise.resolve(lt(key)).then(function () { try { var u = new URL(G.location.href); u.searchParams.delete("useBuiltin"); G.history.replaceState(null, "", u.pathname + u.search + u.hash); } catch (_) {} });
    })();
  }

  function mountControl() {
    var tab = $("tab-ltemplates"), pane = $("pane-ltemplates"), root = $("st_root");
    if (!tab || !pane || !root) return;
    var mgr = null;
    doc.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function () {
        var on = t.dataset.pane === "ltemplates"; pane.hidden = !on;
        if (on && !mgr) mgr = renderManager(root, { builtins: true, newHref: "builder.html?new=1&tplEdit=new", editHref: function (r) { return "builder.html?new=1&tplEdit=" + encodeURIComponent(r.id); },
          useHref: function (r) { return "builder.html?new=1&useTpl=" + encodeURIComponent(r.id); } });
      });
    });
    var tries = 0;
    (async function wait() {
      var st = S();
      if (!st || !st.auth || !st.auth.user || !st.auth.user() || !st.layoutTemplates) { if (tries++ < 40) setTimeout(wait, 500); return; }
      await loadPerm(); if (!perm.view) return;
      tab.hidden = false; if (G.location.hash === "#ltemplates" || G.location.hash === "#layout-templates") tab.click();
    })();
  }

  // layout wizard / anyone: open the template picker (studio templates first)
  function openPicker() { var f = B.fn("openTemplatePicker"); if (f) f(); }

  if (isBuilder) { if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mountBuilder); else mountBuilder(); }
  else { if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mountControl); else mountControl(); }
  G.HelmStudioTemplates = { apply: apply, openPicker: openPicker, openManager: openManager, openSave: openSaveModal, renderManager: renderManager,
    hasAny: function () { return rowsLoaded && C.order(rows).length > 0; }, captureThumb: captureThumb };
})(typeof window !== "undefined" ? window : globalThis);
