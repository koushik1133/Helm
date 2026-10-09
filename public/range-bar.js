/* range-bar.js — the shared date-filter bar of Insights + Reports (0076 pass).
   HelmRange.mount(host, { storeKey, defaultKey, onChange(range) }) builds:
     This month · Last month · Last 30 days · Last 60 days · Last 90 days · This year · Custom range
   range = { key, from: "YYYY-MM-DD", to: "YYYY-MM-DD", label }. Preset maths lives in
   BPStore.insights.rangeFor / rangeCheck (pure, unit-tested). CSP: DOM-built only (no HTML strings,
   no inline styling); the look comes from .rb-* rules in each page's <style>.
   The last choice is remembered per page in localStorage (a convenience; failures ignored). */
(function (global) {
  "use strict";
  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { if (attrs[k] != null) n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }
  function fmt(iso) {
    try { return new Date(iso + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }); }
    catch (e) { return iso; }
  }
  function load(k) { try { return JSON.parse(global.localStorage.getItem(k) || "null"); } catch (e) { return null; } }
  function save(k, v) { try { global.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }

  function mount(host, opts) {
    opts = opts || {};
    var S = global.BPStore && global.BPStore.insights;
    if (!host || !S) return null;
    var key = opts.storeKey || "helm_range";
    var presets = S.presets();
    var saved = load(key) || {};
    var cur = { key: saved.key || opts.defaultKey || "this_month", from: saved.from || "", to: saved.to || "" };

    host.textContent = "";
    var bar = el("div", { class: "rb", role: "group", "aria-label": "Date range" });
    var chips = el("div", { class: "rb-chips" });
    var btns = {};
    presets.forEach(function (p) {
      var b = el("button", { type: "button", class: "rb-chip", "aria-pressed": "false", "data-k": p.key }, p.label);
      b.addEventListener("click", function () { pick(p.key); });
      btns[p.key] = b; chips.appendChild(b);
    });
    var custom = el("div", { class: "rb-custom" });
    var lf = el("label", { class: "rb-f" }); lf.appendChild(el("span", null, "From"));
    var fFrom = el("input", { type: "date", "aria-label": "From date" }); lf.appendChild(fFrom);
    var lt = el("label", { class: "rb-f" }); lt.appendChild(el("span", null, "To"));
    var fTo = el("input", { type: "date", "aria-label": "To date" }); lt.appendChild(fTo);
    var apply = el("button", { type: "button", class: "rb-apply" }, "Apply");
    var err = el("span", { class: "rb-err", role: "alert" });
    custom.appendChild(lf); custom.appendChild(lt); custom.appendChild(apply); custom.appendChild(err);
    var shown = el("div", { class: "rb-label", "aria-live": "polite" });
    bar.appendChild(chips); bar.appendChild(custom); bar.appendChild(shown);
    host.appendChild(bar);

    function paint() {
      Object.keys(btns).forEach(function (k) { btns[k].setAttribute("aria-pressed", String(k === cur.key)); });
      custom.hidden = cur.key !== "custom";
    }
    function emit() {
      var r = cur.key === "custom" ? S.rangeCheck(cur.from, cur.to) : S.rangeFor(cur.key, new Date());
      if (!r) { shown.textContent = "Pick a start and end date, then Apply."; return; }
      var p = presets.filter(function (x) { return x.key === cur.key; })[0];
      var range = { key: cur.key, from: r.from, to: r.to, label: (p ? p.label : "") + " · " + fmt(r.from) + " – " + fmt(r.to) };
      shown.textContent = range.label;
      save(key, { key: cur.key, from: cur.from, to: cur.to });
      if (typeof opts.onChange === "function") opts.onChange(range);
    }
    function pick(k) {
      cur.key = k; err.textContent = ""; paint();
      if (k === "custom") {
        if (!cur.from || !cur.to) { var r0 = S.rangeFor("this_month", new Date()); cur.from = cur.from || r0.from; cur.to = cur.to || r0.to; }
        fFrom.value = cur.from; fTo.value = cur.to; fFrom.focus();
        return emit();
      }
      emit();
    }
    apply.addEventListener("click", function () {
      var r = S.rangeCheck(fFrom.value, fTo.value);
      if (!r) { err.textContent = "Enter both dates, with the start on or before the end."; return; }
      err.textContent = ""; cur.from = r.from; cur.to = r.to; emit();
    });
    [fFrom, fTo].forEach(function (f) { f.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); apply.click(); } }); });
    fFrom.value = cur.from; fTo.value = cur.to;
    paint(); emit();
    return { get: function () { return cur.key === "custom" ? S.rangeCheck(cur.from, cur.to) : S.rangeFor(cur.key, new Date()); } };
  }
  global.HelmRange = { mount: mount };
})(window);
