/* item-pricing.js — Control Center "Item pricing" card (0086). The studio's rate cards for
   spec-priced items (DJ, generator, stage, lighting, LED wall, chandelier, photo booth,
   chocolate fountain, chariot, smoke effects, dancers). Reads / writes ONLY through
   BPStore.config.itemRates / setItemRate (get_item_rate_cards / set_item_rate_card — the
   server re-checks the "item_pricing" edit right). Shown to roles with item_pricing VIEW;
   read-only unless the role has EDIT. Builds every element with the DOM API (no HTML strings).
   Hidden when the server is older than 0086. */
(function (global) {
  "use strict";
  if (typeof document === "undefined") return;
  var started = false;
  var NAMES = { dj: "DJ", generator: "Generator", stage: "Stage", lighting: "Lighting", led: "LED screen / wall", chandelier: "Chandelier",
    photobooth: "Photo booth", chocolatefountain: "Chocolate fountain", chariot: "Chariot / entry", smoke: "Smoke effects", dancers: "Dancers" };
  var KEYS = { base: "Base (₹)", perSqM: "Rate per m² (₹)", stdHeightM: "Standard height (m, no surcharge)", heightPerSqMPerM: "Height surcharge (₹ per m² per extra m)",
    perKvaDay: "Rent per kVA per day (₹)", dieselPerKvaDay: "Diesel per kVA per day (₹)", operatorPerDay: "Operator per day (₹)",
    perExtraSpeaker: "Each extra speaker (₹)", setup: "Setup", power: "Power connection (add-on)", each: "Per unit (₹)", perM: "Per metre (₹)",
    perSqMDay: "Per m² per day (₹)", perHour: "Per hour (₹)", minHours: "Minimum hours", perServing: "Per serving (₹)", perTrip: "Per trip (₹)",
    perUnit: "Per unit (₹)", perDancerShow: "Per dancer per performance (₹)", perDancerHour: "Per dancer per hour (₹)" };
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function msg(box, t, kind) { clear(box); if (!t) return; var p = el("div", "msg " + (kind || "ok"), t); if (kind === "err") p.setAttribute("role", "alert"); box.appendChild(p); }
  function numInput(id, v, ro) {
    var i = el("input"); i.type = "number"; i.min = "0"; i.max = "10000000"; i.step = "any"; i.id = id; i.value = String(v); i.disabled = !!ro; i.setAttribute("data-ip", "1");
    return i;
  }
  function field(grid, id, label, v, ro) {
    var f = el("div", "fld"), l = el("label", null, label); l.htmlFor = id; f.appendChild(l); f.appendChild(numInput(id, v, ro)); grid.appendChild(f);
  }
  function read(type, rates) {
    var out = {}, bad = null;
    Object.keys(rates).forEach(function (k) {
      function one(id) { var n = document.getElementById(id); var raw = String(n.value).trim(); var v = Number(raw);
        if (raw === "" || !isFinite(v) || v < 0 || v > 10000000) bad = bad || n; return v; }
      if (rates[k] && typeof rates[k] === "object") { out[k] = {}; Object.keys(rates[k]).forEach(function (k2) { out[k][k2] = one("ip_" + type + "_" + k + "_" + k2); }); }
      else out[k] = one("ip_" + type + "_" + k);
    });
    return { rates: out, bad: bad };
  }
  function render(card, data) {
    var S = global.BPStore.pricing.ITEM_SPEC, body = card.querySelector("[data-ip-body]"), ro = !data.canEdit;
    clear(body);
    var note = card.querySelector("[data-ip-ro]"); if (note) note.hidden = !ro;
    S.TYPES.forEach(function (type) {
      var rates = (data.rates && data.rates[type]) || S.DEFAULT_RATES[type];
      var box = el("details", "ip-type"), sum = el("summary", null, NAMES[type] || type);
      if ((data.custom || []).indexOf(type) >= 0) sum.appendChild(el("span", "ip-tag", " · studio rate"));
      box.appendChild(sum);
      Object.keys(rates).forEach(function (k) {
        if (rates[k] && typeof rates[k] === "object") {
          box.appendChild(el("p", "mnote", KEYS[k] || k));
          var g = el("div", "grid"); Object.keys(rates[k]).forEach(function (k2) { field(g, "ip_" + type + "_" + k + "_" + k2, S.label(k2), rates[k][k2], ro); }); box.appendChild(g);
        } else { var g2 = el("div", "grid"); field(g2, "ip_" + type + "_" + k, KEYS[k] || k, rates[k], ro); box.appendChild(g2); }
      });
      var m = el("div"); m.setAttribute("aria-live", "polite");
      if (!ro) {
        var act = el("div", "actions"), b = el("button", "btn primary sm", "Save " + (NAMES[type] || type) + " rates"); b.type = "button";
        b.addEventListener("click", function () {
          var r = read(type, rates);
          if (r.bad) { msg(m, "Every rate must be a number from 0 to 1,00,00,000.", "err"); r.bad.focus(); return; }
          b.disabled = true;
          global.BPStore.config.setItemRate(type, r.rates).then(function () { msg(m, "Saved. New quotes use these rates; existing quotes keep their prices until re-priced.", "ok"); })
            .catch(function (e) { msg(m, (e && /not authorized|42501/.test(String(e.message || e.code))) ? "You can view these rates but not change them." : "Couldn't save: " + ((e && e.message) || e), "err"); })
            .then(function () { b.disabled = false; });
        });
        act.appendChild(b); box.appendChild(act);
      }
      box.appendChild(m); body.appendChild(box);
    });
  }
  function init() {
    if (started) return; started = true;
    var card = document.getElementById("itemPricingCard"); if (!card || !global.BPStore) return;
    var A = global.BPStore.auth;
    Promise.resolve(A && A.canView ? A.canView("item_pricing") : true).then(function (ok) {
      if (!ok) return;
      return global.BPStore.config.itemRates().then(function (d) { if (!d || !d.rates) return; render(card, d); card.hidden = false; });
    }).catch(function () { /* older server / not signed in: card stays hidden */ });
  }
  global.HelmItemPricing = { init: init };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function () { setTimeout(init, 0); });
  else setTimeout(init, 0);
})(typeof window !== "undefined" ? window : globalThis);
