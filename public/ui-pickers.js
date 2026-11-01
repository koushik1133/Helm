/* ui-pickers.js — R94 Apple-style pickers (progressive enhancement).
 *
 * Select: a native <select> gets a rounded popover listbox (12px radius, soft shadow,
 *   max-height 320px, flips up/down and clamps inside the viewport, type-ahead filter
 *   when > 8 options, arrows/Enter/Esc/Home/End, ARIA combobox + listbox).
 *   The <select> stays the source of truth: we set its value and dispatch input+change.
 * Date: input[type=date] gets a rounded calendar popover (prev/next month, today ring,
 *   selected filled, Clear/Today, min/max). The value stays YYYY-MM-DD; a DD MMM YYYY
 *   (en-IN) label is shown on the closed control.
 * Touch phones (pointer:coarse and width < 640) keep the native pickers (their wheels
 *   are already Apple-like); only the closed control is styled (ui-pickers.css).
 * Opt out with data-native-picker on the element (or an ancestor). select[multiple],
 *   size>1 and type=time/datetime-local are left native.
 * CSP: no inline style attributes, no HTML sinks; DOM via createElement/textContent;
 *   positioning via CSSOM (style.setProperty), which CSP allows.
 */
(function () {
  "use strict";
  if (window.__helmPickers) return;
  var doc = document;
  var mqTouch = window.matchMedia ? window.matchMedia("(pointer: coarse) and (max-width: 639.98px)") : null;
  function isTouchPhone() { return !!(mqTouch && mqTouch.matches); }
  var GAP = 6, MARGIN = 8, MAXH = 320;
  var uid = 0;
  var open = null; // { close: fn }

  function el(tag, cls, text) { var e = doc.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function optedOut(node) { return !!(node.closest && node.closest("[data-native-picker]")); }
  function fire(node, type) { node.dispatchEvent(new Event(type, { bubbles: true })); }

  /* ---- positioning: below the anchor, flip above if no room, clamp in viewport ---- */
  function place(pop, anchor) {
    var r = anchor.getBoundingClientRect();
    var vw = doc.documentElement.clientWidth, vh = window.innerHeight;
    var w = Math.min(Math.max(r.width, pop.__minW || 0), pop.__maxW || 1e9, vw - MARGIN * 2);
    pop.style.setProperty("width", w + "px");
    var below = vh - r.bottom - GAP - MARGIN, above = r.top - GAP - MARGIN;
    var natural = Math.min(pop.scrollHeight, pop.__cap || MAXH);
    var up = below < natural && above > below;
    var room = Math.max(120, up ? above : below);
    pop.style.setProperty("max-height", Math.min(pop.__cap || MAXH, room) + "px");
    var h = Math.min(pop.offsetHeight, room);
    var top = up ? r.top - GAP - h : r.bottom + GAP;
    top = Math.max(MARGIN, Math.min(top, vh - MARGIN - h));
    var left = Math.max(MARGIN, Math.min(r.left, vw - MARGIN - w));
    pop.style.setProperty("top", top + "px");
    pop.style.setProperty("left", left + "px");
    pop.classList.toggle("uip-up", up);
  }

  // R95 no-flicker: the event that OPENED a popover must never also close it (pointerdown/mousedown of the
  // same press, or a click that follows it). We remember the opening event and the press time.
  var openEvt = null, openAt = 0;
  function sameGesture(e) { return e === openEvt || (openAt && e.timeStamp && Math.abs(e.timeStamp - openAt) < 400 && e.type !== "keydown"); }
  // R95: a modal <dialog> (showModal) sits in the browser's top layer, above ANY z-index, so a list appended to
  // <body> opened BEHIND it (trial "Choose your state"). Mount inside the nearest open modal dialog instead.
  function hostFor(anchor) { var d = anchor.closest && anchor.closest("dialog[open]"); return d || doc.body; }
  function mountPopover(pop, anchor, onClose) {
    var host = hostFor(anchor);
    host.appendChild(pop);
    place(pop, anchor);
    requestAnimationFramePoly(function () { pop.classList.add("uip-open"); });
    function reflow(e) {
      if (!pop.isConnected) return;
      var t = e && e.target;
      if (t && t.nodeType === 1 && pop.contains(t)) return; // scrolling the list itself
      var r = anchor.getBoundingClientRect();
      var box = t && t.nodeType === 1 && t.contains(anchor) ? t.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      // the field scrolled out of its scroll box (or the page): close instead of floating detached
      if (!anchor.isConnected || r.bottom < box.top || r.top > box.bottom) { close(false); return; }
      place(pop, anchor);
    }
    function outside(e) { if (sameGesture(e)) return; if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); }
    window.addEventListener("resize", reflow);
    window.addEventListener("scroll", reflow, true);
    doc.addEventListener("pointerdown", outside, true);
    function close(refocus) {
      if (!pop.parentNode) return;
      window.removeEventListener("resize", reflow);
      window.removeEventListener("scroll", reflow, true);
      doc.removeEventListener("pointerdown", outside, true);
      pop.parentNode.removeChild(pop);
      if (open && open.pop === pop) open = null;
      onClose(refocus);
    }
    if (open) open.close();
    open = { pop: pop, close: close };
    return close;
  }
  function requestAnimationFramePoly(fn) { (window.requestAnimationFrame || setTimeout)(fn); }

  /* ================================ SELECT ================================ */
  function enhanceSelect(sel) {
    // R95: selects owned by phone-input.js's searchable picker (data-picker="search", wrapped and hidden as
    // .hp-sel-native) are skipped - two pickers on one control was half of the "flicker" report.
    if (sel.__hp || sel.multiple || (sel.size && sel.size > 1) || optedOut(sel) || sel.hasAttribute("data-picker") || sel.helmPicker || sel.classList.contains("hp-sel-native")) return;
    sel.__hp = true;
    sel.classList.add("uip-select");
    var listId = "uip-lb-" + (++uid);
    sel.setAttribute("aria-haspopup", "listbox");

    function items() {
      var out = [];
      Array.prototype.forEach.call(sel.children, function (c) {
        if (c.tagName === "OPTGROUP") {
          out.push({ group: c.label, disabled: c.disabled });
          Array.prototype.forEach.call(c.children, function (o) { if (o.tagName === "OPTION" && !o.hidden) out.push({ opt: o, disabled: c.disabled || o.disabled }); });
        } else if (c.tagName === "OPTION" && !c.hidden) out.push({ opt: c, disabled: c.disabled });
      });
      return out;
    }

    function openList() {
      if (sel.disabled) return;
      var all = items();
      var optCount = all.filter(function (i) { return i.opt; }).length;
      var pop = el("div", "uip-pop uip-select-pop");
      pop.__minW = 200; pop.__maxW = 480;
      var search = null;
      if (optCount > 8) {
        search = el("input", "uip-search");
        search.type = "search"; search.placeholder = "Search"; search.autocomplete = "off";
        search.setAttribute("role", "combobox"); search.setAttribute("aria-controls", listId);
        search.setAttribute("aria-expanded", "true"); search.setAttribute("aria-autocomplete", "list");
        search.setAttribute("aria-label", "Search options");
        search.setAttribute("data-native-picker", "");
        pop.appendChild(search);
      }
      var list = el("div", "uip-list"); list.id = listId; list.setAttribute("role", "listbox");
      var lab = sel.getAttribute("aria-label") || (sel.labels && sel.labels[0] && sel.labels[0].textContent.trim()) || "Options";
      list.setAttribute("aria-label", lab);
      pop.appendChild(list);
      var rows = [], active = -1;

      function render(q) {
        while (list.firstChild) list.removeChild(list.firstChild);
        rows = []; q = (q || "").toLowerCase().trim();
        var pendingGroup = null;
        all.forEach(function (it, i) {
          if (it.group != null) { pendingGroup = el("div", "uip-group", it.group); pendingGroup.setAttribute("role", "presentation"); return; }
          var t = it.opt.textContent.trim();
          if (q && t.toLowerCase().indexOf(q) < 0) return;
          if (pendingGroup) { list.appendChild(pendingGroup); pendingGroup = null; }
          var row = el("div", "uip-opt");
          row.id = listId + "-" + i; row.setAttribute("role", "option");
          row.setAttribute("aria-selected", it.opt.selected ? "true" : "false");
          if (it.disabled) row.setAttribute("aria-disabled", "true");
          row.appendChild(el("span", "uip-opt-t", t || " "));
          var tick = el("span", "uip-tick"); tick.setAttribute("aria-hidden", "true"); row.appendChild(tick);
          row.addEventListener("pointerdown", function (e) { e.preventDefault(); });
          row.addEventListener("click", function () { if (!it.disabled) choose(it.opt); });
          row.addEventListener("pointermove", function () { setActive(rows.indexOf(rec)); });
          var rec = { row: row, it: it };
          rows.push(rec); list.appendChild(row);
        });
        if (!rows.length) list.appendChild(el("div", "uip-empty", "No matches"));
        var cur = -1;
        rows.forEach(function (r, i) { if (r.it.opt.selected) cur = i; });
        setActive(cur >= 0 ? cur : nextEnabled(-1, 1), true);
      }
      function nextEnabled(from, dir) {
        for (var i = from + dir; i >= 0 && i < rows.length; i += dir) if (!rows[i].it.disabled) return i;
        return from;
      }
      function setActive(i, center) {
        if (active >= 0 && rows[active]) rows[active].row.classList.remove("uip-active");
        active = i;
        var r = rows[i];
        if (!r) { (search || sel).removeAttribute("aria-activedescendant"); return; }
        r.row.classList.add("uip-active");
        (search || sel).setAttribute("aria-activedescendant", r.row.id);
        var top = r.row.offsetTop, bot = top + r.row.offsetHeight;
        if (center) list.scrollTop = top - list.clientHeight / 2 + r.row.offsetHeight / 2;
        else if (top < list.scrollTop) list.scrollTop = top;
        else if (bot > list.scrollTop + list.clientHeight) list.scrollTop = bot - list.clientHeight;
      }
      function choose(o) {
        var changed = sel.value !== o.value || !o.selected;
        o.selected = true;
        close(true);
        if (changed) { fire(sel, "input"); fire(sel, "change"); }
      }
      function key(e) {
        var k = e.key;
        if (k === "ArrowDown") { e.preventDefault(); setActive(nextEnabled(active, 1)); }
        else if (k === "ArrowUp") { e.preventDefault(); setActive(nextEnabled(active, -1)); }
        else if (k === "Home") { if (search && e.target === search && search.value) return; e.preventDefault(); setActive(nextEnabled(-1, 1)); }
        else if (k === "End") { if (search && e.target === search && search.value) return; e.preventDefault(); setActive(nextEnabled(rows.length, -1)); }
        else if (k === "PageDown") { e.preventDefault(); setActive(Math.min(rows.length - 1, active + 8)); }
        else if (k === "PageUp") { e.preventDefault(); setActive(Math.max(0, active - 8)); }
        else if (k === "Enter") { e.preventDefault(); if (rows[active] && !rows[active].it.disabled) choose(rows[active].it.opt); }
        else if (k === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
        else if (k === "Tab") { close(false); }
        else if (!search && k.length === 1 && !e.metaKey && !e.ctrlKey) {
          // native-like type-to-jump for short lists
          var ch = k.toLowerCase();
          for (var n = 1; n <= rows.length; n++) {
            var j = (active + n) % rows.length;
            if (!rows[j].it.disabled && rows[j].row.textContent.trim().toLowerCase().indexOf(ch) === 0) { setActive(j); break; }
          }
        }
      }
      render("");
      sel.setAttribute("aria-expanded", "true");
      sel.setAttribute("aria-controls", listId);
      var close = mountPopover(pop, sel, function (refocus) {
        sel.setAttribute("aria-expanded", "false");
        sel.removeAttribute("aria-activedescendant");
        sel.removeEventListener("keydown", key);
        if (refocus) { try { sel.focus({ preventScroll: true }); } catch (_) { sel.focus(); } }
      });
      if (search) {
        search.addEventListener("input", function () { render(search.value); place(pop, sel); });
        search.addEventListener("keydown", key);
        search.focus();
      } else {
        sel.addEventListener("keydown", key);
      }
      place(pop, sel);
      if (active >= 0) setActive(active, true);
    }

    function isOpen() { return sel.getAttribute("aria-expanded") === "true"; }
    sel.addEventListener("mousedown", function (e) {
      if (isTouchPhone() || e.button !== 0) return;
      e.preventDefault(); // keep the native list shut
      e.stopPropagation(); // page "click outside" handlers must not see the opening press
      try { sel.focus({ preventScroll: true }); } catch (_) { sel.focus(); }
      if (isOpen()) { if (open) open.close(false); return; }
      openEvt = e; openAt = e.timeStamp || 0;
      openList();
    });
    // the click that ends the opening press must not toggle anything (Safari/label forwarding)
    sel.addEventListener("click", function (e) { if (!isTouchPhone() && isOpen()) e.stopPropagation(); });
    sel.addEventListener("keydown", function (e) {
      if (isTouchPhone() || isOpen()) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " " || (e.altKey && e.key === "ArrowDown")) {
        e.preventDefault(); openList();
      }
    });
  }

  /* ================================ DATE ================================ */
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function iso(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function parse(s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || ""); return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null; }
  function pretty(s) { var d = parse(s); return d ? pad(d.getDate()) + " " + MONTHS[d.getMonth()] + " " + d.getFullYear() : ""; }

  // R106: a page's own hidden helper date box (e.g. quote-validity.js "Change date": a dd/mm/yyyy text box + a calendar
  // button over a hidden native picker, aria-hidden + tabindex -1) is not a field - enhancing it showed the date twice.
  function helperInput(inp) { return inp.getAttribute("aria-hidden") === "true" || inp.hidden || inp.type === "hidden"; }
  function enhanceDate(inp) {
    if (inp.__hp || optedOut(inp) || helperInput(inp)) return;
    inp.__hp = true;
    inp.classList.add("uip-date");
    var wrap = el("span", "uip-date-wrap");
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    var face = el("button", "uip-date-face");
    face.type = "button";
    face.setAttribute("aria-haspopup", "dialog");
    var faceText = el("span", "uip-date-text");
    var icon = el("span", "uip-cal-ico"); icon.setAttribute("aria-hidden", "true");
    face.appendChild(faceText); face.appendChild(icon);
    wrap.appendChild(face);

    function sync() {
      var touch = isTouchPhone();
      wrap.classList.toggle("uip-native", touch);
      var v = pretty(inp.value);
      faceText.textContent = v || inp.getAttribute("placeholder") || "Select date";
      face.classList.toggle("uip-empty", !v);
      face.disabled = inp.disabled || inp.readOnly;
      var lbl = (inp.labels && inp.labels[0] && inp.labels[0].textContent.trim()) || inp.getAttribute("aria-label") || "Date";
      face.setAttribute("aria-label", lbl + (v ? ", " + v : ", not set"));
      face.classList.toggle("uip-invalid", inp.getAttribute("aria-invalid") === "true");
    }
    sync();
    inp.addEventListener("input", sync);
    inp.addEventListener("change", sync);
    if (mqTouch && mqTouch.addEventListener) mqTouch.addEventListener("change", sync);
    // value set programmatically (inp.value = ...) does not fire events; watch it cheaply
    var desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    try {
      Object.defineProperty(inp, "value", { configurable: true, get: function () { return desc.get.call(this); }, set: function (v) { desc.set.call(this, v); sync(); } });
    } catch (_) {}
    new MutationObserver(sync).observe(inp, { attributes: true, attributeFilter: ["disabled", "readonly", "aria-invalid", "placeholder"] });
    face.addEventListener("click", function () { if (!face.disabled) openCal(); });
    // label click → focus input; forward to the face
    inp.addEventListener("focus", function () { if (!isTouchPhone()) face.focus(); });

    function openCal() {
      var min = parse(inp.min), max = parse(inp.max), today = new Date(); today.setHours(0, 0, 0, 0);
      var sel = parse(inp.value);
      var view = new Date((sel || today).getFullYear(), (sel || today).getMonth(), 1);
      var focusD = sel || (min && today < min ? min : (max && today > max ? max : today));
      var pop = el("div", "uip-pop uip-cal");
      pop.__minW = 296; pop.__maxW = 320; pop.__cap = 420;
      pop.setAttribute("role", "dialog"); pop.setAttribute("aria-label", "Choose date");
      var head = el("div", "uip-cal-head");
      var title = el("div", "uip-cal-title"); title.setAttribute("aria-live", "polite");
      var prev = el("button", "uip-cal-nav uip-prev"); prev.type = "button"; prev.setAttribute("aria-label", "Previous month");
      var next = el("button", "uip-cal-nav uip-next"); next.type = "button"; next.setAttribute("aria-label", "Next month");
      var navs = el("div", "uip-cal-navs"); navs.appendChild(prev); navs.appendChild(next);
      head.appendChild(title); head.appendChild(navs);
      var grid = el("div", "uip-cal-grid"); grid.setAttribute("role", "grid");
      var dow = el("div", "uip-cal-dow"); dow.setAttribute("aria-hidden", "true");
      ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"].forEach(function (d) { dow.appendChild(el("span", null, d)); });
      var foot = el("div", "uip-cal-foot");
      var clear = el("button", "uip-cal-btn", "Clear"); clear.type = "button";
      var tbtn = el("button", "uip-cal-btn uip-cal-today", "Today"); tbtn.type = "button";
      if ((min && today < min) || (max && today > max)) tbtn.disabled = true;
      if (inp.required) clear.disabled = !inp.value;
      foot.appendChild(clear); foot.appendChild(tbtn);
      pop.appendChild(head); pop.appendChild(dow); pop.appendChild(grid); pop.appendChild(foot);

      function off(d) { return (min && d < min) || (max && d > max); }
      function draw(focus) {
        title.textContent = MONTHS_LONG[view.getMonth()] + " " + view.getFullYear();
        while (grid.firstChild) grid.removeChild(grid.firstChild);
        var first = new Date(view), lead = (first.getDay() + 6) % 7;
        var start = new Date(view.getFullYear(), view.getMonth(), 1 - lead);
        var pm = new Date(view.getFullYear(), view.getMonth(), 0), nm = new Date(view.getFullYear(), view.getMonth() + 1, 1);
        prev.disabled = !!(min && pm < min); next.disabled = !!(max && nm > max);
        var row;
        for (var i = 0; i < 42; i++) {
          if (i % 7 === 0) { row = el("div", "uip-cal-row"); row.setAttribute("role", "row"); grid.appendChild(row); }
          var d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
          var b = el("button", "uip-day", String(d.getDate())); b.type = "button";
          b.setAttribute("role", "gridcell");
          b.setAttribute("aria-label", pad(d.getDate()) + " " + MONTHS_LONG[d.getMonth()] + " " + d.getFullYear());
          b.__d = d;
          if (d.getMonth() !== view.getMonth()) b.classList.add("uip-out");
          if (+d === +today) { b.classList.add("uip-today"); b.setAttribute("aria-current", "date"); }
          if (sel && +d === +sel) { b.classList.add("uip-sel"); b.setAttribute("aria-selected", "true"); }
          if (off(d)) b.disabled = true;
          b.tabIndex = +d === +focusD ? 0 : -1;
          (function (dd) { b.addEventListener("click", function () { pick(iso(dd)); }); })(d);
          row.appendChild(b);
        }
        if (focus) { var f = grid.querySelector('.uip-day[tabindex="0"]'); if (f) f.focus(); }
      }
      function moveFocus(d) {
        if (min && d < min) d = new Date(min); if (max && d > max) d = new Date(max);
        focusD = d;
        if (d.getMonth() !== view.getMonth() || d.getFullYear() !== view.getFullYear()) view = new Date(d.getFullYear(), d.getMonth(), 1);
        draw(true);
      }
      function pick(v) {
        var changed = inp.value !== v;
        desc.set.call(inp, v); sync();
        close(true);
        if (changed) { fire(inp, "input"); fire(inp, "change"); }
      }
      prev.addEventListener("click", function () { view = new Date(view.getFullYear(), view.getMonth() - 1, 1); draw(); });
      next.addEventListener("click", function () { view = new Date(view.getFullYear(), view.getMonth() + 1, 1); draw(); });
      clear.addEventListener("click", function () { pick(""); });
      tbtn.addEventListener("click", function () { pick(iso(today)); });
      pop.addEventListener("keydown", function (e) {
        var k = e.key;
        if (k === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); return; }
        if (!e.target.classList || !e.target.classList.contains("uip-day")) return;
        var d = e.target.__d, step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[k];
        if (step) { e.preventDefault(); moveFocus(new Date(d.getFullYear(), d.getMonth(), d.getDate() + step)); }
        else if (k === "Home") { e.preventDefault(); moveFocus(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7)); }
        else if (k === "End") { e.preventDefault(); moveFocus(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 6 - (d.getDay() + 6) % 7)); }
        else if (k === "PageUp") { e.preventDefault(); moveFocus(new Date(d.getFullYear(), d.getMonth() - 1, d.getDate())); }
        else if (k === "PageDown") { e.preventDefault(); moveFocus(new Date(d.getFullYear(), d.getMonth() + 1, d.getDate())); }
      });
      face.setAttribute("aria-expanded", "true");
      var close = mountPopover(pop, face, function (refocus) {
        face.setAttribute("aria-expanded", "false");
        if (refocus) face.focus();
        try { inp.dispatchEvent(new Event("blur")); } catch (_) {}
      });
      draw(true);
      place(pop, face);
    }
  }

  /* ============================== DATALIST =============================== */
  // R95: <input list=...> gets the same rounded suggestion popover; the field stays free text. The list id
  // moves to data-uip-list so the browser's own (black, in Safari) datalist popover never shows.
  function enhanceList(inp) {
    var id = inp.getAttribute("list"); if (!id || optedOut(inp) || isTouchPhone()) return;
    if (inp.__hpl) { inp.setAttribute("data-uip-list", id); inp.removeAttribute("list"); return; } // list re-set later
    inp.__hpl = true;
    inp.setAttribute("data-uip-list", id);
    inp.removeAttribute("list");
    inp.setAttribute("autocomplete", "off");
    inp.setAttribute("role", "combobox");
    inp.setAttribute("aria-autocomplete", "list");
    inp.setAttribute("aria-expanded", "false");
    var listId = "hp-dl-" + (++uid), rows = [], active = -1, closeFn = null, list = null, pop = null;
    function values() {
      var dl = doc.getElementById(inp.getAttribute("data-uip-list")); if (!dl) return [];
      var seen = {}, out = [];
      Array.prototype.forEach.call(dl.querySelectorAll("option"), function (o) {
        var v = (o.value || o.textContent || "").trim(); if (!v || seen[v]) return; seen[v] = 1;
        out.push({ v: v, label: (o.label && o.label !== o.value) ? o.label : "" });
      });
      return out;
    }
    function setActive(i) {
      if (rows[active]) rows[active].classList.remove("uip-active");
      active = i;
      if (!rows[i]) { inp.removeAttribute("aria-activedescendant"); return; }
      rows[i].classList.add("uip-active"); inp.setAttribute("aria-activedescendant", rows[i].id);
      var r = rows[i], top = r.offsetTop, bot = top + r.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top; else if (bot > list.scrollTop + list.clientHeight) list.scrollTop = bot - list.clientHeight;
    }
    function choose(v) {
      inp.value = v; closeList();
      fire(inp, "input"); fire(inp, "change");
    }
    function render() {
      var q = inp.value.toLowerCase().trim(), all = values();
      var hits = all.filter(function (it) { return !q || it.v.toLowerCase().indexOf(q) >= 0 || it.label.toLowerCase().indexOf(q) >= 0; });
      // starts-with matches first, like Apple's suggestion lists
      hits.sort(function (a, b) { return (a.v.toLowerCase().indexOf(q) === 0 ? 0 : 1) - (b.v.toLowerCase().indexOf(q) === 0 ? 0 : 1); });
      if (hits.length === 1 && hits[0].v.toLowerCase() === q) hits = [];
      if (!hits.length) { closeList(); return; }
      if (!pop) {
        pop = el("div", "uip-pop uip-select-pop uip-dl-pop");
        pop.__minW = 200; pop.__maxW = 480; pop.__cap = 280;
        list = el("div", "uip-list"); list.id = listId; list.setAttribute("role", "listbox");
        list.setAttribute("aria-label", "Suggestions");
        pop.appendChild(list);
        inp.setAttribute("aria-controls", listId);
        inp.setAttribute("aria-expanded", "true");
        closeFn = mountPopover(pop, inp, function () {
          pop = null; list = null; closeFn = null; rows = []; active = -1;
          inp.setAttribute("aria-expanded", "false"); inp.removeAttribute("aria-activedescendant");
        });
      }
      while (list.firstChild) list.removeChild(list.firstChild);
      rows = []; active = -1;
      hits.slice(0, 200).forEach(function (it, i) {
        var row = el("div", "uip-opt"); row.id = listId + "-" + i; row.setAttribute("role", "option");
        row.setAttribute("aria-selected", "false");
        row.appendChild(el("span", "uip-opt-t", it.v));
        if (it.label) row.appendChild(el("span", "uip-opt-sub", it.label));
        row.addEventListener("pointerdown", function (e) { e.preventDefault(); });
        row.addEventListener("mousedown", function (e) { e.preventDefault(); });
        row.addEventListener("click", function () { choose(it.v); });
        row.addEventListener("pointermove", function () { setActive(i); });
        rows.push(row); list.appendChild(row);
      });
      place(pop, inp);
      requestAnimationFramePoly(function () { if (pop) pop.classList.add("uip-open"); });
    }
    function closeList() { if (closeFn) closeFn(false); }
    inp.addEventListener("focus", function () { if (!isTouchPhone() && !inp.readOnly && !inp.disabled) render(); });
    inp.addEventListener("mousedown", function (e) { if (e.button === 0 && !pop && doc.activeElement === inp) { openEvt = e; openAt = e.timeStamp || 0; render(); } });
    inp.addEventListener("input", function (e) { if (e.isTrusted !== false && doc.activeElement === inp) render(); });
    inp.addEventListener("blur", function () { closeList(); });
    inp.addEventListener("keydown", function (e) {
      var k = e.key;
      if (k === "ArrowDown" || k === "ArrowUp") {
        e.preventDefault();
        if (!pop) { render(); if (!pop) return; }
        var n = rows.length; if (!n) return;
        setActive(k === "ArrowDown" ? (active + 1) % n : (active <= 0 ? n - 1 : active - 1));
      } else if (k === "Enter" && pop && rows[active]) { e.preventDefault(); choose(rows[active].firstChild.textContent); }
      else if (k === "Escape" && pop) { e.preventDefault(); e.stopPropagation(); closeList(); }
      else if (k === "Tab") closeList();
    });
  }

  /* ================================ scan ================================ */
  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    if (root.matches && root.matches("select")) enhanceSelect(root);
    else if (root.matches && root.matches('input[type="date"]')) enhanceDate(root);
    Array.prototype.forEach.call(root.querySelectorAll("select"), enhanceSelect);
    Array.prototype.forEach.call(root.querySelectorAll('input[type="date"]'), enhanceDate);
    if (root.matches && root.matches("input[list]")) enhanceList(root);
    Array.prototype.forEach.call(root.querySelectorAll("input[list]"), enhanceList);
  }
  function start() {
    scan(doc.body);
    // New selects/dates (and new <option>s, which the popover reads fresh on open) are picked up here.
    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        // a list="" set after render (flow-dish-editor, menu-pkg-editor, onboarding) - enhance it then
        if (muts[i].type === "attributes") { var t = muts[i].target; if (t.matches && t.matches("input[list]")) enhanceList(t); continue; }
        var a = muts[i].addedNodes;
        for (var j = 0; j < a.length; j++) if (a[j].nodeType === 1 && !(a[j].classList && a[j].classList.contains("uip-pop"))) scan(a[j]);
      }
    }).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["list"] });
  }
  window.__helmPickers = { scan: scan, version: 3, _sameGesture: sameGesture, _helperInput: helperInput };
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", start); else start();
})();
