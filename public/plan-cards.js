/* =========================================================================
   HELM - plan cards (r22): ONE layout wherever plans appear - the sign-up "How would you like to start?"
   step (login.html), the in-app "Choose a plan" page (/checkout) and the pricing-page deep links.
   Every card: name, who it is for, price (before tax), what's included, then
     PRIMARY   "Pay now"                (an on-request plan: "Contact sales" is its primary)
     secondary "Try free for 8 days"    (only where a free trial is still possible)
     link      "Contact sales"
   Prices come from the server (signup_plan_options / my_checkout_options). CATALOG is the display-only
   fallback - the SAME plans and prices as the public pricing page and checkout.js (never payable on its own).
   CSP: DOM via createElement / textContent only; styles in plan-cards.css.
   ========================================================================= */
(function (global) {
  "use strict";
  var CATALOG = [
    { code: "starter", name: "Starter", description: "Solo planners and decorators", monthly: 1999, yearly: 19990,
      features: ["Up to 3 team members", "Leads, clients and follow-ups (CRM)", "2D layout builder and 3D view", "Quotes with tax and client approval links", "Tasks and event calendar"] },
    { code: "studio", name: "Studio", description: "Growing event companies", monthly: 4999, yearly: 49990,
      features: ["Everything in Starter", "Up to 15 team members", "Roles and access matrix", "Inventory, stock check-out and shortages", "Client portal, booklet and invitation site"] },
    { code: "enterprise", name: "Enterprise", description: "Multi-city teams and corporate studios", monthly: null, yearly: null,
      features: ["Everything in Studio", "Unlimited team members", "Multiple branches and countries, local tax rules", "Priority onboarding and data import help", "Audit log review and custom roles"] }
  ];
  var CODE_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;

  // ---- pure helpers (unit-tested) ----
  function num(v) { if (v == null || v === "") return null; var n = Number(v); return isFinite(n) && n >= 0 ? n : null; }
  // server list -> clean cards (no ids, no provider ids); [] / bad input -> []
  function normalize(list) {
    if (!Array.isArray(list)) return [];
    return list.filter(function (p) { return p && typeof p === "object" && CODE_RE.test(String(p.code || "")); }).map(function (p) {
      return { code: String(p.code), name: String(p.name || p.code).slice(0, 60), description: String(p.description || "").slice(0, 140),
        monthly: num(p.monthly), yearly: num(p.yearly),
        features: (Array.isArray(p.features) ? p.features : []).map(function (f) { return String(f).slice(0, 120); }).slice(0, 8) };
    });
  }
  function plansOr(list) { var l = normalize(list); return l.length ? l : CATALOG.slice(); }
  function onRequest(p) { return !!p && p.monthly == null && p.yearly == null; }
  function offered(p, interval) { return onRequest(p) || (interval === "yearly" ? p.yearly : p.monthly) != null; }
  function money(v) {
    var n = Number(v); if (!isFinite(n)) return "";
    try { return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(n); }
    catch (e) { return "₹" + Math.round(n); }
  }
  function priceText(p, interval) {
    if (onRequest(p)) return { main: "Price on request", unit: "", sub: "Custom pricing for larger teams" };
    var v = interval === "yearly" ? p.yearly : p.monthly;
    if (v == null) return { main: "—", unit: "monthly only", sub: "Yearly billing isn't offered for this plan" };
    return { main: money(v), unit: interval === "yearly" ? "/year" : "/month",
      sub: interval === "yearly" ? "≈ " + money(Number(v) / 12) + " a month, plus GST" : "plus GST" };
  }
  // the middle plan of 2+ is "Most studios" (same rule as checkout)
  function recommended(list) { return list.length > 1 ? list[Math.min(1, list.length - 1)].code : ""; }
  // ?plan= / stored choice -> a code that exists in the list, else the recommended one
  function pickPlan(list, want) {
    var w = String(want || "").toLowerCase();
    return list.some(function (p) { return p.code === w; }) ? w : recommended(list) || (list[0] && list[0].code) || "";
  }
  function interval(v) { return v === "yearly" ? "yearly" : "monthly"; }
  // which buttons a card shows: { pay, trial, sales, primary: "pay" | "sales" }
  function actionsFor(p, opts) {
    var o = opts || {}, ask = onRequest(p);
    return { pay: !ask && o.pay !== false && offered(p, o.interval), trial: !!o.trial, sales: o.sales !== false,
      primary: ask ? "sales" : "pay" };
  }

  var api = { CATALOG: CATALOG, normalize: normalize, plansOr: plansOr, onRequest: onRequest, offered: offered, money: money,
    priceText: priceText, recommended: recommended, pickPlan: pickPlan, interval: interval, actionsFor: actionsFor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!global || !global.document) return;
  var doc = global.document;

  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function btn(cls, text, fn, p) {
    var b = el("button", cls, text); b.type = "button";
    if (p) b.setAttribute("data-plan", p.code);
    b.addEventListener("click", function (ev) { ev.preventDefault(); ev.stopPropagation(); if (!b.disabled && fn) fn(p, b); });
    return b;
  }
  // the action row under a card (also used inside checkout's own radio cards)
  //   opts: { interval, trial (bool), trialDays, pay (bool), onPay(p, btn), onTrial(p, btn), onSales(p, btn), payLabel }
  function actions(p, opts) {
    var o = opts || {}, a = actionsFor(p, o), box = el("div", "plan-acts");
    if (a.primary === "sales") box.appendChild(btn("pc-btn pc-pay", "Contact sales", o.onSales, p));
    else if (a.pay) box.appendChild(btn("pc-btn pc-pay", o.payLabel || "Pay now", o.onPay, p));
    if (a.trial) box.appendChild(btn("pc-btn pc-trial", "Try free for " + (Number(o.trialDays) > 0 ? Number(o.trialDays) : 8) + " days", o.onTrial, p));
    if (a.sales && a.primary !== "sales") box.appendChild(btn("pc-link", "Contact sales", o.onSales, p));
    return box;
  }
  // full card list for pages that have no cards of their own (login.html "How would you like to start?")
  //   opts: actions() opts + { plans, selected, onSelect(code) }
  function render(box, opts) {
    var o = opts || {}, list = plansOr(o.plans), iv = interval(o.interval), rec = recommended(list);
    while (box.firstChild) box.removeChild(box.firstChild);
    box.classList.add("plans", "hpc");
    list.forEach(function (p) {
      var card = el("article", "plan" + (o.selected === p.code ? " on" : "") + (offered(p, iv) ? "" : " off"));
      card.setAttribute("data-plan", p.code);
      var pn = el("h3", "pn"); pn.appendChild(el("span", null, p.name));
      if (p.code === rec) { card.classList.add("rec"); pn.appendChild(el("span", "badge", "Most studios")); }
      card.appendChild(pn);
      card.appendChild(el("p", "pd", p.description || ""));
      var pt = priceText(p, iv), pp = el("p", "pp" + (onRequest(p) ? " req" : ""), pt.main);
      if (pt.unit) pp.appendChild(el("small", null, pt.unit));
      card.appendChild(pp);
      card.appendChild(el("p", "px", pt.sub));
      card.appendChild(actions(p, o));
      if (p.features.length) {
        var ul = el("ul", "pf"); p.features.slice(0, 5).forEach(function (f) { ul.appendChild(el("li", null, f)); }); card.appendChild(ul);
      }
      if (o.onSelect) card.addEventListener("click", function () { o.onSelect(p.code); });
      box.appendChild(card);
    });
    return list;
  }
  global.HelmPlanCards = { CATALOG: CATALOG, normalize: normalize, plansOr: plansOr, onRequest: onRequest, offered: offered, money: money,
    priceText: priceText, recommended: recommended, pickPlan: pickPlan, interval: interval, actionsFor: actionsFor, actions: actions, render: render };
})(typeof window !== "undefined" ? window : globalThis);
