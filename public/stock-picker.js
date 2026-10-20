/* =========================================================================
   HelmStockPicker (r24) — searchable stock-item list for Event-day command.
   The old native <select> listed every item in one long drop-down that did
   not scroll properly (and was hard to use on a phone). This is a search box
   + a short, scrollable list (keyboard + touch), with an optional
   "Use “…” — not from stock" row for something you do not keep in stock.
   CSP: DOM nodes + textContent only, no inline styles (command-polish.css).
   HelmStockPicker.mount(host, { items, placeholder, allowFree, meta(item)->text, onChange(sel) })
     sel = { item } | { label } (typed, not from stock) | null
   -> { value(), clear(), setItems(items), input }
   ========================================================================= */
(function (root) {
  "use strict";
  var seq = 0;
  function mount(host, o) {
    o = o || {};
    var doc = host.ownerDocument, id = "stkp" + (++seq), items = o.items || [], shown = [], active = -1, sel = null;
    var SF = root.HelmStockFlow;
    var wrap = doc.createElement("div"); wrap.className = "stkp";
    var input = doc.createElement("input");
    input.type = "search"; input.className = "stkp-in"; input.autocomplete = "off"; input.spellcheck = false;
    input.setAttribute("autocorrect", "off"); input.setAttribute("autocapitalize", "off"); input.setAttribute("enterkeyhint", "done");
    input.placeholder = o.placeholder || "Search stock…";
    input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false"); input.setAttribute("aria-controls", id + "-list");
    input.setAttribute("aria-label", o.label || "Stock item");
    var list = doc.createElement("ul"); list.className = "stkp-list"; list.id = id + "-list"; list.hidden = true;
    list.setAttribute("role", "listbox"); list.setAttribute("aria-label", o.label || "Stock items");
    wrap.appendChild(input); wrap.appendChild(list); host.appendChild(wrap);

    function emit() { if (typeof o.onChange === "function") { try { o.onChange(sel); } catch (e) {} } }
    function close() { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); active = -1; }
    function setActive(i) {
      var opts = list.querySelectorAll("[role=option]"); if (!opts.length) return;
      active = Math.max(0, Math.min(i, opts.length - 1));
      for (var k = 0; k < opts.length; k++) opts[k].setAttribute("aria-selected", k === active ? "true" : "false");
      input.setAttribute("aria-activedescendant", opts[active].id);
      var el = opts[active], top = el.offsetTop, bottom = top + el.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top; else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }
    function render() {
      var q = input.value.trim();
      shown = SF ? SF.search(items, q, 200) : items.slice(0, 200);
      while (list.firstChild) list.removeChild(list.firstChild);
      shown.forEach(function (it, i) {
        var li = doc.createElement("li"); li.setAttribute("role", "option"); li.id = id + "-o" + i; li.className = "stkp-opt";
        li.setAttribute("aria-selected", "false"); li.dataset.i = String(i);
        var nm = doc.createElement("span"); nm.className = "stkp-nm"; nm.textContent = it.name || "Item"; li.appendChild(nm);
        var m = typeof o.meta === "function" ? o.meta(it) : ""; if (m) { var sm = doc.createElement("span"); sm.className = "stkp-meta"; sm.textContent = m; li.appendChild(sm); }
        list.appendChild(li);
      });
      if (o.allowFree && q && !shown.some(function (it) { return String(it.name || "").toLowerCase() === q.toLowerCase(); })) {
        var li = doc.createElement("li"); li.setAttribute("role", "option"); li.id = id + "-free"; li.className = "stkp-opt stkp-free";
        li.setAttribute("aria-selected", "false"); li.dataset.free = "1";
        li.textContent = "Use “" + q.slice(0, 120) + "” — not from stock"; list.appendChild(li);
      }
      if (!list.firstChild) { var e = doc.createElement("li"); e.className = "stkp-empty"; e.textContent = items.length ? "No stock item matches." : "No stock items yet."; list.appendChild(e); }
      list.hidden = false; input.setAttribute("aria-expanded", "true"); active = -1;
    }
    function pick(li) {
      if (!li) return;
      if (li.dataset.free) { sel = { label: input.value.trim().slice(0, 200) }; }
      else { var it = shown[Number(li.dataset.i)]; if (!it) return; sel = { item: it }; input.value = it.name || ""; }
      close(); emit();
    }
    input.addEventListener("focus", render);
    input.addEventListener("input", function () { if (sel) { sel = null; emit(); } render(); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) render(); setActive(active + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
      else if (e.key === "Enter") { if (!list.hidden && active >= 0) { e.preventDefault(); pick(list.querySelectorAll("[role=option]")[active]); } }
      else if (e.key === "Escape") { if (!list.hidden) { e.preventDefault(); e.stopPropagation(); close(); } }
    });
    // keep focus in the box while tapping / scrolling the list; pick on click (a scroll gesture is not a click)
    list.addEventListener("mousedown", function (e) { e.preventDefault(); });
    list.addEventListener("click", function (e) { var li = e.target && e.target.closest ? e.target.closest("[role=option]") : null; pick(li); });
    doc.addEventListener("click", function (e) { if (!wrap.contains(e.target)) close(); });
    // no close-on-blur: on a phone, scrolling the list can move focus; outside tap / Tab / Escape / a pick close it
    input.addEventListener("keydown", function (e) { if (e.key === "Tab") close(); });

    return {
      input: input,
      value: function () { if (sel) return sel; var q = input.value.trim(); if (!q) return null;
        var exact = items.filter(function (it) { return String(it.name || "").toLowerCase() === q.toLowerCase(); })[0];
        return exact ? { item: exact } : (o.allowFree ? { label: q.slice(0, 200) } : null); },
      clear: function () { sel = null; input.value = ""; close(); },
      setItems: function (a) { items = a || []; if (!list.hidden) render(); },
    };
  }
  var api = { mount: mount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.HelmStockPicker = api;
})(typeof window !== "undefined" ? window : this);
