/* venue-picker.js (0085) - "Pick a saved venue" for the quote flow (Venue section) and the
 * builder's Custom Event dialog. Fills the existing fields (manual entry stays possible) and
 * shows warnings: guests over capacity, event type not allowed, relevant restrictions.
 * Builds DOM nodes only (no HTML strings). Needs venues-core.js + store-api.js. */
(function () {
  "use strict";
  var V = window.HelmVenues;
  if (!V) return;
  var $ = function (id) { return document.getElementById(id); };
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === "text") el.textContent = attrs[k]; else if (k === "cls") el.className = attrs[k]; else el.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(c); });
    return el;
  }
  function setVal(id, v) {
    var el = $(id); if (!el || v === null || v === undefined || v === "") return;
    el.value = String(v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // which page are we on
  var ctx = null;
  if ($("sec-venue") && $("v_name")) {
    ctx = { where: "flow", anchor: $("sec-venue").querySelector(".grid"), guests: "c_guests", type: "c_type",
      fill: function (f) { setVal("v_name", f.name); setVal("v_addr", f.address); setVal("v_contact", f.contact);
        setVal("g_len", f.lenFt); setVal("g_wid", f.widFt); } };
  } else if ($("customModal") && $("c_len")) {
    var sec = $("customModal").querySelector(".cform");
    ctx = { where: "builder", anchor: sec, guests: "c_guests", type: "c_type",
      fill: function (f) { setVal("c_len", f.lenFt); setVal("c_wid", f.widFt); setVal("c_setting", f.setting); setVal("capInput", f.capacity); } };
  }
  if (!ctx || !ctx.anchor) return;

  var list = [];
  var sel = h("select", { id: "vp_pick", "aria-describedby": "vp_sum" }, [h("option", { value: "", text: "- type the venue by hand -" })]);
  var sum = h("div", { id: "vp_sum", cls: "vp-sum", "aria-live": "polite" });
  var warn = h("ul", { id: "vp_warn", cls: "vp-warn", "aria-live": "polite" });
  var box = h("div", { cls: "vp-box", id: "vp_box", hidden: "" }, [
    h("label", { "for": "vp_pick", cls: "vp-lbl", text: "Pick a saved venue" }), sel, sum, warn]);
  ctx.anchor.parentNode.insertBefore(box, ctx.anchor);

  function picked() { var id = sel.value; for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return null; }
  function render() {
    var v = picked();
    sum.textContent = v ? V.summary(v) : "";
    warn.textContent = "";
    if (!v) return;
    var g = $(ctx.guests), t = $(ctx.type);
    V.warnings(v, { guests: g ? g.value : null, eventType: t ? t.value : null }).forEach(function (w) {
      warn.appendChild(h("li", { cls: "vp-" + w.level, text: (w.level === "warn" ? "⚠ " : "ℹ ") + w.msg }));
    });
  }
  sel.addEventListener("change", function () {
    var v = picked();
    if (v) ctx.fill(V.fillFor(v));
    render();
  });
  [ctx.guests, ctx.type].forEach(function (id) { var el = $(id); if (el) { el.addEventListener("input", render); el.addEventListener("change", render); } });

  var tries = 0;
  function load() {
    var S = window.BPStore;
    if (!S || !S.venues || !S.auth || !S.auth.user || !S.auth.user()) { if (tries++ < 40) setTimeout(load, 500); return; }
    S.venues.list().then(function (rows) {
      list = rows || [];
      if (!list.length) return;
      list.forEach(function (v) { sel.appendChild(h("option", { value: v.id, text: v.name + (v.city ? " - " + v.city : "") })); });
      box.hidden = false;
    }).catch(function () { /* no venues area / not migrated yet: keep manual entry only */ });
  }
  load();
  window.HelmVenuePicker = { where: ctx.where, render: render };
})();
