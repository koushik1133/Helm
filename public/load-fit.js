/* load-fit.js — warn before loading a layout that is bigger than the current hall.
 * Pure helpers (testable in Node) + a small accessible 3-choice dialog and a post-fit overlap note.
 *   HelmLoadFit.size(data|items)            {w,h} ft: max of the saved hall size and the objects' extent
 *   HelmLoadFit.compare(size, hall)         {longer, wider, any}
 *   HelmLoadFit.message(size, hall, unit)   plain-words warning ("ft" | "m")
 *   HelmLoadFit.overlapIds(before, after)   ids of items that overlap (or were pushed by the walls) only after fitting
 *   HelmLoadFit.ask(size, hall, unit, cap)  Promise<'fit'|'size'|'cancel'>  ('fit' straight away when it already fits)
 *   HelmLoadFit.note(before, after, select) non-blocking "N items overlap after fitting" toast with Show */
(function (G) {
  "use strict";
  var FT_PER_M = 3.280839895;
  function num(v) { v = +v; return isFinite(v) ? v : 0; }

  function extent(items) {
    var w = 0, h = 0;
    (Array.isArray(items) ? items : []).forEach(function (it) {
      if (!it || typeof it !== "object") return;
      w = Math.max(w, num(it.x) + num(it.width)); h = Math.max(h, num(it.y) + num(it.height));
    });
    return { w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10 };
  }
  function savedRoom(d) {
    if (!d || typeof d !== "object" || Array.isArray(d)) return null;
    var r = (d.scale && d.scale.worldFt) || (d.venue && d.venue.room) || d.room;
    return r && num(r.w) > 0 && num(r.h) > 0 ? { w: num(r.w), h: num(r.h) } : null;
  }
  function size(data) {
    var items = Array.isArray(data) ? data : (data && data.items) || [];
    var e = extent(items), r = savedRoom(data);
    return { w: Math.max(e.w, r ? r.w : 0), h: Math.max(e.h, r ? r.h : 0) };
  }
  var TOL = 0.5;   // half a foot of slack — rounding never triggers the warning
  function compare(s, hall) {
    var longer = num(s && s.w) > num(hall && hall.w) + TOL, wider = num(s && s.h) > num(hall && hall.h) + TOL;
    return { longer: longer, wider: wider, any: longer || wider };
  }
  function fmt(ft, unit) {
    if (unit === "m") { var m = ft / FT_PER_M; return String(Math.round(m * 10) / 10); }
    return String(Math.round(ft));
  }
  function dims(s, unit) { var u = unit === "m" ? "m" : "ft"; return fmt(s.w, unit) + " × " + fmt(s.h, unit) + " " + u; }
  function message(s, hall, unit) {
    var c = compare(s, hall); if (!c.any) return "";
    var how = c.longer && c.wider ? "longer and wider" : c.longer ? "longer" : "wider";
    return "This layout is " + dims(s, unit) + " but your hall is " + dims(hall, unit) + ". It's " + how +
      " than your hall, so items may overlap or be squeezed to fit.";
  }
  // the hall size "Use the layout's size" gives: never bigger than the plan cap, never under 20 ft
  function targetHall(s, cap) {
    var c = num(cap) > 0 ? num(cap) : 1000;
    var f = function (v) { return Math.max(20, Math.min(c, Math.ceil(num(v)))); };
    return { w: f(s.w), h: f(s.h), capped: Math.ceil(num(s.w)) > c || Math.ceil(num(s.h)) > c };
  }

  function box(it) { return { x: num(it.x), y: num(it.y), r: num(it.x) + num(it.width), b: num(it.y) + num(it.height) }; }
  function hit(a, b) { return a.x < b.r - 0.01 && b.x < a.r - 0.01 && a.y < b.b - 0.01 && b.y < a.b - 0.01; }
  function overlapping(items) {   // Set of indexes that overlap any other item (sweep on x)
    var bx = items.map(function (it, i) { return { i: i, k: box(it || {}) }; }).sort(function (p, q) { return p.k.x - q.k.x; });
    var out = new Set();
    for (var a = 0; a < bx.length; a++) {
      for (var b = a + 1; b < bx.length && bx[b].k.x < bx[a].k.r - 0.01; b++) {
        if (hit(bx[a].k, bx[b].k)) { out.add(bx[a].i); out.add(bx[b].i); }
      }
    }
    return out;
  }
  // items that overlap after fitting but did not before, plus (opts.clamp) items the walls moved/shrank.
  // before/after are matched by position in the list (loading keeps the order).
  function overlapIds(before, after, opts) {
    before = Array.isArray(before) ? before : []; after = Array.isArray(after) ? after : [];
    var pre = overlapping(before), post = overlapping(after), ids = [];
    after.forEach(function (it, i) {
      if (!it) return;
      var newly = post.has(i) && !pre.has(i), moved = false;
      if (opts && opts.clamp && before[i]) {
        var p = before[i];
        moved = Math.abs(num(p.x) - num(it.x)) > 0.05 || Math.abs(num(p.y) - num(it.y)) > 0.05 ||
          Math.abs(num(p.width) - num(it.width)) > 0.05 || Math.abs(num(p.height) - num(it.height)) > 0.05;
      }
      if (newly || moved) ids.push(it.id);
    });
    return ids;
  }
  function noteText(n) { return n === 1 ? "1 item overlaps after fitting — check the layout" : n + " items overlap after fitting — check the layout"; }

  /* ---------------- browser UI ---------------- */
  var doc = G.document;
  function el(tag, attrs, text) {
    var n = doc.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }
  function ask(s, hall, unit, cap) {
    if (!compare(s, hall).any) return Promise.resolve("fit");
    var t = targetHall(s, cap);
    return new Promise(function (resolve) {
      var prev = doc.activeElement;
      var ov = el("div", { class: "bpui-overlay lf-overlay", "data-bpui-keep": "" });
      var dlg = el("div", { class: "bpui-dialog lf-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": "lfTitle", "aria-describedby": "lfMsg lfSize" });
      dlg.appendChild(el("h2", { id: "lfTitle" }, "This layout is bigger than your hall"));
      dlg.appendChild(el("p", { id: "lfMsg" }, message(s, hall, unit)));
      dlg.appendChild(el("p", { id: "lfSize", class: "lf-sub" }, "“Use the layout's size” changes your venue size to " + dims(t, unit) +
        (t.capped ? " (the most your plan allows)" : "") + "."));
      var acts = el("div", { class: "bpui-actions" });
      var bCancel = el("button", { type: "button", class: "bpui-btn", "data-lf": "cancel" }, "Cancel");
      var bSize = el("button", { type: "button", class: "bpui-btn", "data-lf": "size" }, "Use the layout's size");
      var bFit = el("button", { type: "button", class: "bpui-btn bpui-primary", "data-lf": "fit" }, "Fit to my hall");
      acts.appendChild(bCancel); acts.appendChild(bSize); acts.appendChild(bFit); dlg.appendChild(acts); ov.appendChild(dlg);
      // own look (set via CSSOM, CSP-safe) so it renders even before the shared BPUI dialog CSS is injected
      {
        ov.style.cssText = "position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(15,23,42,.45);padding:16px";
        dlg.style.cssText = "max-width:460px;width:100%;background:var(--panel,#fff);color:var(--text,#0f172a);border-radius:12px;padding:20px;box-shadow:0 20px 50px rgba(0,0,0,.3)";
        acts.style.cssText = "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px";
      }
      var done = false;
      function close(v) {
        if (done) return; done = true;
        doc.removeEventListener("keydown", onKey, true);
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        try { if (prev && prev.focus) prev.focus(); } catch (_) {}
        resolve(v);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close("cancel"); return; }
        if (e.key === "Tab") {   // keep focus inside the dialog
          var f = [bCancel, bSize, bFit], i = f.indexOf(doc.activeElement);
          e.preventDefault(); f[(i + (e.shiftKey ? f.length - 1 : 1) + f.length) % f.length].focus();
        }
      }
      [bCancel, bSize, bFit].forEach(function (b) { b.addEventListener("click", function () { close(b.getAttribute("data-lf")); }); });
      ov.addEventListener("click", function (e) { if (e.target === ov) close("cancel"); });
      doc.addEventListener("keydown", onKey, true);
      doc.body.appendChild(ov);
      bFit.focus();
    });
  }
  function note(before, after, select, opts) {
    var ids = overlapIds(before, after, opts);
    if (!ids.length) return 0;
    try {
      if (G.BPUI && G.BPUI.toast) G.BPUI.toast(noteText(ids.length), { type: "info", timeout: 9000,
        action: { label: "Show", onClick: function () { if (typeof select === "function") select(ids); } } });
    } catch (_) {}
    return ids.length;
  }

  G.HelmLoadFit = { extent: extent, size: size, compare: compare, message: message, targetHall: targetHall,
    overlapIds: overlapIds, noteText: noteText, ask: ask, note: note };
})(typeof window !== "undefined" ? window : globalThis);
