/* studio-templates.js (0096) - a studio's OWN floor-layout templates.
 *   Builder:  "My studio templates" listed FIRST in the Template dropdown + template picker,
 *             "Save as template" (name, event type, description, preview from the 2D floor),
 *             "My templates" manager (use, rename, duplicate, archive / restore, default per event type),
 *             template-edit mode (?tplEdit=new | <id>): blank hall + name field + "Save template".
 *             Applying a template scales / clamps it to the CURRENT hall and re-applies the exact
 *             seat count (exactSeats) when a quote is open.
 *   Layout wizard: "Start from my template" opens the picker (studio templates first).
 *   Control Center: "Layout templates" tab (#pane-ltemplates) with the same manager.
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

  var perm = { view: false, edit: false, ready: null };
  function loadPerm() {
    if (perm.ready) return perm.ready;
    perm.ready = (async function () {
      var st = S(); if (!st || !st.auth) return perm;
      var role = null; try { role = await st.auth.role(); } catch (_) {}
      if (role === "admin") { perm.view = perm.edit = true; return perm; }
      var ce = function (a) { return st.auth.canEditArea ? st.auth.canEditArea(a).catch(function () { return false; }) : false; };
      var cv = function (a) { return st.auth.canView ? st.auth.canView(a).catch(function () { return false; }) : false; };
      perm.edit = !!((await ce("layouts")) || (await ce("controls")));
      perm.view = perm.edit || !!((await cv("layouts")) || (await cv("controls")));
      return perm;
    })();
    return perm.ready;
  }
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
      lfUseSize: typeof lfUseSize !== "undefined" ? lfUseSize : null, lfNote: typeof lfNote !== "undefined" ? lfNote : null, fitView: typeof fitView !== "undefined" ? fitView : null }[n] || null; } catch (_) { return null; } },
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
    var row; try { row = await S().layoutTemplates.get(id); } catch (e) { toast(friendly(e, "load the template"), true); return; }
    if (!row || !row.data) { toast("That template could not be found.", true); return; }
    // load-fit.js: bigger than this hall → Fit to my hall / Use the layout's size / Cancel
    var lfSz = G.HelmLoadFit ? G.HelmLoadFit.size(row.data) : null, ask = B.fn("lfAsk");
    var fitChoice = ask && lfSz ? await ask(lfSz) : "ok";
    if (fitChoice === "cancel") return;
    if (fitChoice === "size") { var us = B.fn("lfUseSize"); if (us) us(lfSz); }
    var W = B.world() || { w: 200, h: 140 }, caps = B.caps() || {};
    var fit = C.fitToHall(row.data, { w: W.w, h: W.h }, caps.hall || 1000);
    var items = fit.items, N = 0;
    try { var qc = B.fn("quoteChairsNow"); if (B.quoteId() && qc) N = +qc() || 0; } catch (_) {}
    var ex = B.fn("exactSeats"), ss = B.fn("sumSeats");
    if (N > 0 && ex) {
      var nat = ss ? ss(items) : 0; ex(items, N);
      var sw = B.fn("seatFitWarning"), pr = B.pricing() || {};
      var w = sw ? sw(N, nat, null, pr.eventType) : null; if (w) setTimeout(function () { toast("⚠ " + w, true); }, 50);
    }
    var li = B.fn("loadItems"); if (!li) return;
    li(items, row.name);
    if (fitChoice === "fit") { var nt = B.fn("lfNote"); if (nt) nt(row.data.items || []); }
    var es = $("emptyState"); if (es) es.hidden = true;
    toast(row.name + " loaded" + (fit.scaled ? " · fitted to your " + fit.hall.w + "×" + fit.hall.h + " ft hall" : ""));
  }

  // "My studio templates" as the FIRST optgroup of #preset (the template picker is built from it)
  async function fillPreset() {
    var sel = $("preset"); if (!sel) return;
    var old = $("st_optgroup"); if (old) old.remove();
    var pr = B.pricing() || {};
    var list = C.order(rows, pr.eventType);
    if (!list.length) return;
    var og = h("optgroup", { id: "st_optgroup", label: "My studio templates" },
      list.map(function (r) { return h("option", { value: "st:" + r.id, text: (r.is_default ? "★ " : "") + r.name + (r.event_type ? " · " + C.label(r.event_type) : "") }); }));
    var first = sel.querySelector("optgroup"); sel.insertBefore(og, first || null);
  }

  /* ---------------- manager (builder modal + Control Center pane) ---------------- */
  function thumbEl(r) {
    return r.thumbnail && C.thumbOk(r.thumbnail) ? h("img", { cls: "st-thumb", src: r.thumbnail, alt: "Preview of " + r.name, loading: "lazy" })
      : h("div", { cls: "st-thumb st-nothumb", "aria-hidden": "true", text: "📐" });
  }
  function renderManager(root, opts) {
    opts = opts || {};
    var state = { showArchived: false, renaming: null, err: "", msg: "" };
    async function refresh() { try { await reload(true); state.err = ""; } catch (e) { state.err = friendly(e, "load templates"); } paint(); if (isBuilder) fillPreset(); }
    async function act(p, msg) { try { await p; state.msg = msg; state.err = ""; } catch (e) { state.err = friendly(e); state.msg = ""; } await refresh(); }
    function paint() {
      root.textContent = "";
      var tools = h("div", { cls: "st-tools" }, [
        perm.edit && opts.newHref ? h("a", { cls: "btn primary sm", href: opts.newHref, text: "+ New template" }) : null,
        h("label", { cls: "st-chk" }, [h("input", { type: "checkbox", checked: state.showArchived, onchange: function (e) { state.showArchived = e.target.checked; paint(); } }), " Show archived"])]);
      root.appendChild(tools);
      if (state.msg) root.appendChild(h("p", { cls: "st-ok", role: "status", text: state.msg }));
      if (state.err) root.appendChild(h("p", { cls: "st-err", role: "alert", text: state.err }));
      var list = rows.filter(function (r) { return state.showArchived || !r.archived; });
      if (!list.length) { root.appendChild(h("p", { cls: "mnote", text: rows.length ? "No live templates - tick Show archived to see archived ones." : "No studio templates yet. Arrange a floor in the builder, then use Save as template." })); return; }
      var grid = h("div", { cls: "st-grid" });
      list.forEach(function (r) {
        var nameNode;
        if (state.renaming === r.id) {
          var inp = h("input", { type: "text", value: r.name, maxlength: String(C.LIMITS.name), "aria-label": "New template name", cls: "st-rename" });
          var tsel = h("select", { "aria-label": "Event type" }, typeOpts(r.event_type || ""));
          nameNode = h("div", { cls: "st-renbox" }, [inp, tsel,
            h("button", { type: "button", cls: "btn sm primary", text: "Save", onclick: function () {
              var v = C.validate({ name: inp.value, event_type: tsel.value, description: r.description }); if (!v.ok) { state.err = v.errors[0].msg; paint(); return; }
              state.renaming = null; act(S().layoutTemplates.save(r.id, v.value), "Template renamed."); } }),
            h("button", { type: "button", cls: "btn sm", text: "Cancel", onclick: function () { state.renaming = null; paint(); } })]);
          setTimeout(function () { try { inp.focus(); } catch (_) {} }, 0);
        } else nameNode = h("b", { cls: "st-name", text: r.name });
        var badges = h("div", { cls: "st-badges" }, [h("span", { cls: "st-badge", text: C.label(r.event_type) }),
          r.is_default ? h("span", { cls: "st-badge st-def", text: "★ Default" }) : null, r.archived ? h("span", { cls: "st-badge st-arc", text: "Archived" }) : null]);
        var acts = h("div", { cls: "st-acts" }, [
          opts.onUse && !r.archived ? h("button", { type: "button", cls: "btn sm primary", text: "Use", onclick: function () { opts.onUse(r); } }) : null,
          perm.edit && opts.editHref ? h("a", { cls: "btn sm", href: opts.editHref(r), text: "Edit layout" }) : null,
          perm.edit ? h("button", { type: "button", cls: "btn sm", text: "Rename", onclick: function () { state.renaming = r.id; paint(); } }) : null,
          perm.edit ? h("button", { type: "button", cls: "btn sm", text: "Duplicate", onclick: function () { act(S().layoutTemplates.duplicate(r.id), "Template duplicated."); } }) : null,
          perm.edit && !r.archived ? h("button", { type: "button", cls: "btn sm", text: r.is_default ? "Unset default" : "Set default",
            title: "Default template for " + C.label(r.event_type), onclick: function () { act(S().layoutTemplates.setDefault(r.id, !r.is_default), r.is_default ? "Default removed." : "Default set for " + C.label(r.event_type) + "."); } }) : null,
          perm.edit ? h("button", { type: "button", cls: "btn sm", text: r.archived ? "Restore" : "Archive", onclick: function () { act(S().layoutTemplates.setArchived(r.id, !r.archived), r.archived ? "Template restored." : "Template archived (it can be restored)."); } }) : null]);
        grid.appendChild(h("div", { cls: "st-card" + (r.archived ? " st-archived" : "") }, [thumbEl(r), nameNode, badges,
          r.description ? h("p", { cls: "st-desc", text: r.description }) : null, acts]));
      });
      root.appendChild(grid);
    }
    refresh();
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
  function metaForm(init) {
    init = init || {};
    var name = h("input", { id: "st_f_name", type: "text", maxlength: String(C.LIMITS.name), required: true, value: init.name || "" });
    var type = h("select", { id: "st_f_type" }, typeOpts(init.event_type || ""));
    var desc = h("textarea", { id: "st_f_desc", maxlength: String(C.LIMITS.description), rows: "3" }, [init.description || ""]);
    var box = h("div", { cls: "st-form" }, [
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
    if (!perm.edit) { toast("You don't have access to create templates - ask an admin.", true); return; }
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

  // template-edit mode: ?tplEdit=new (blank hall) or ?tplEdit=<id>
  async function tplEditMode(param) {
    var editing = null;
    if (param && param !== "new") {
      try { editing = await S().layoutTemplates.get(param); } catch (_) {}
      if (!editing) { toast("That template could not be found - starting a new one.", true); param = "new"; }
    }
    var f = metaForm(editing || {});
    var err = h("p", { cls: "st-err", role: "alert", hidden: true });
    var btn = h("button", { type: "button", cls: "tbtn primary", id: "st_edit_save", text: "Save template" });
    var bar = h("div", { cls: "st-editbar", id: "st_editbar", role: "region", "aria-label": "Template editing" }, [
      h("b", { text: editing ? "Editing studio template" : "New studio template" }),
      h("span", { cls: "mnote", text: " - arrange the floor, name it, then Save template." }), f.box, btn,
      h("a", { cls: "tbtn", href: "control.html#ltemplates", text: "Done" }), err]);
    doc.body.insertBefore(bar, doc.body.firstChild);
    // start from a blank hall (or the template's own layout + hall size)
    var tries = 0;
    (function boot() {
      var li = B.fn("loadItems"), W = B.world(), st = B.store();
      if (!li || !W || !st || !G.BPStore) { if (tries++ < 40) setTimeout(boot, 250); return; }
      if (editing && editing.data) {
        var room = editing.data.room || {}, cap = (B.caps() || {}).hall || 1000;
        if (+room.w > 0) W.w = Math.max(20, Math.min(cap, Math.round(+room.w))); if (+room.h > 0) W.h = Math.max(20, Math.min(cap, Math.round(+room.h)));
        st.venue = st.venue || {}; st.venue.room = { w: W.w, h: W.h };
        var u = B.fn("updateDimsLabel"), sc = B.fn("sizeCanvas"); if (u) u(); if (sc) sc();
        li(C.fitToHall(editing.data, W, cap).items, editing.name);
      } else li([], "New template");
      var es = $("emptyState"); if (es) es.hidden = true;
    })();
    btn.addEventListener("click", async function () {
      var r = await saveCurrent(editing ? editing.id : null, f.read(), btn, err);
      if (r) { editing = r; toast("Template saved"); try { G.history.replaceState(null, "", "builder.html?new=1&tplEdit=" + encodeURIComponent(r.id)); } catch (_) {} }
    });
  }

  function mountBuilder() {
    var sel = $("preset"); if (!sel) return;
    var field = sel.closest(".field") || sel.parentNode;
    var bSave = h("button", { type: "button", cls: "tbtn", id: "st_saveBtn", role: "menuitem", hidden: true, title: "Save the current floor as your studio's own template", text: "💾 Save as template" });
    var bMgr = h("button", { type: "button", cls: "tbtn", id: "st_mgrBtn", role: "menuitem", hidden: true, title: "Your studio's own layout templates", text: "📐 My templates" });
    bSave.addEventListener("click", openSaveModal); bMgr.addEventListener("click", openManager);
    field.parentNode.insertBefore(bMgr, field.nextSibling); field.parentNode.insertBefore(bSave, field.nextSibling);
    var tries = 0;
    (async function wait() {
      var st = S();
      if (!st || !st.auth || !st.auth.user || !st.auth.user() || !st.layoutTemplates) { if (tries++ < 40) setTimeout(wait, 500); return; }
      await loadPerm();
      if (!perm.view) return;
      bMgr.hidden = false; bSave.hidden = !perm.edit || B.ro();
      try { await reload(false); } catch (_) { bMgr.hidden = true; bSave.hidden = true; return; }
      fillPreset();
      var tp = null; try { tp = new URLSearchParams(G.location.search).get("tplEdit"); } catch (_) {}
      if (tp && perm.edit) tplEditMode(/^(new|[0-9a-f-]{36})$/i.test(tp) ? tp : "new");
    })();
  }

  function mountControl() {
    var tab = $("tab-ltemplates"), pane = $("pane-ltemplates"), root = $("st_root");
    if (!tab || !pane || !root) return;
    var mgr = null;
    doc.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function () {
        var on = t.dataset.pane === "ltemplates"; pane.hidden = !on;
        if (on && !mgr) mgr = renderManager(root, { newHref: "builder.html?new=1&tplEdit=new", editHref: function (r) { return "builder.html?new=1&tplEdit=" + encodeURIComponent(r.id); } });
      });
    });
    var tries = 0;
    (async function wait() {
      var st = S();
      if (!st || !st.auth || !st.auth.user || !st.auth.user() || !st.layoutTemplates) { if (tries++ < 40) setTimeout(wait, 500); return; }
      await loadPerm(); if (!perm.view) return;
      tab.hidden = false; if (G.location.hash === "#ltemplates") tab.click();
    })();
  }

  // layout wizard / anyone: open the template picker (studio templates first)
  function openPicker() { var f = B.fn("openTemplatePicker"); if (f) f(); }

  if (isBuilder) { if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mountBuilder); else mountBuilder(); }
  else { if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mountControl); else mountControl(); }
  G.HelmStudioTemplates = { apply: apply, openPicker: openPicker, openManager: openManager, openSave: openSaveModal, renderManager: renderManager,
    hasAny: function () { return rowsLoaded && C.order(rows).length > 0; }, captureThumb: captureThumb };
})(typeof window !== "undefined" ? window : globalThis);
