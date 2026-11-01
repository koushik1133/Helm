/* =========================================================================
   HELM - plan cards (r22): ONE layout wherever plans appear - the sign-up "How would you like to start?"
   step (login.html), the in-app "Choose a plan" page (/checkout) and the pricing-page deep links.
   Every card: name, who it is for, price (before tax), what's included, then
     PRIMARY   "Pay now"                (an on-request plan: "Contact sales" is its primary)
     secondary "Try free for 8 days"    (only where a free trial is still possible)
     link      "Contact sales"
   r24: "Pay now" follows ONE switch, config.js HELM_FEATURES.payNow (false for now). While it is off no card shows
   Pay now: "Contact sales" becomes the primary button and "Try free" stays where a trial is possible.
   Prices come from the server (signup_plan_options / my_checkout_options). CATALOG is the display-only
   fallback - the SAME plans and prices as the public pricing page and checkout.js (never payable on its own).
   r25 currency: ONE list currency in public (USD). Each studio is billed in ONE fixed currency: India -> INR (GST added),
   elsewhere -> USD. Prices are FIXED per currency (never converted); the server says which currency (opts.currency).
   Before a studio exists the browser time zone picks the fallback catalogue (currencyFor: India time -> INR, else USD).
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
  // r25: the same plans at the fixed USD list prices (public /pricing)
  var CATALOG_USD = CATALOG.map(function (p) {
    var usd = { starter: [24, 240], studio: [59, 590] }[p.code];
    return { code: p.code, name: p.name, description: p.description, monthly: usd ? usd[0] : null, yearly: usd ? usd[1] : null, features: p.features.slice() };
  });
  var CATALOGS = { INR: CATALOG, USD: CATALOG_USD };
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
  // r25: billing currency code ("INR" / "USD" / another ISO code from the server); anything else -> INR
  function cur(c) { var x = String(c || "").toUpperCase(); return /^[A-Z]{3}$/.test(x) ? x : "INR"; }
  // r25: the visitor's currency before a studio exists - India time -> INR, any other time zone -> USD, unknown -> INR
  //   (the server rule _r25_currency_for is the same; a billing country, once known, wins on the server)
  function currencyFor(tz) {
    var z = String(tz == null ? "" : tz).trim();
    if (z === "Asia/Kolkata" || z === "Asia/Calcutta") return "INR";
    return /^[A-Za-z]+(\/[A-Za-z0-9_+-]+){1,2}$/.test(z) ? "USD" : "INR";
  }
  // r110 (QA B3): once the sign-up knows the studio's COUNTRY it decides the currency, not the browser clock - the time
  //   zone sent to the server is made to agree with it (India -> Asia/Kolkata; elsewhere a non-India zone, the browser's
  //   own when it is not India time, else Etc/UTC). No / unknown country -> the browser zone unchanged.
  function zoneForCountry(country, tz) {
    var c = String(country == null ? "" : country).trim().toUpperCase(), z = String(tz == null ? "" : tz).trim();
    if (!/^[A-Z]{2}$/.test(c)) return z;
    if (c === "IN") return "Asia/Kolkata";
    return currencyFor(z) === "USD" ? z : "Etc/UTC";
  }
  function browserZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { return ""; } }
  function plansOr(list, currency) { var l = normalize(list); return l.length ? l : (CATALOGS[cur(currency)] || CATALOG).slice(); }
  function onRequest(p) { return !!p && p.monthly == null && p.yearly == null; }
  function offered(p, interval) { return onRequest(p) || (interval === "yearly" ? p.yearly : p.monthly) != null; }
  // r25: rupees in the Indian style (₹1,999), dollars in the US style ($24); whole amounts without decimals
  function money(v, currency) {
    var n = Number(v), c = cur(currency); if (!isFinite(n)) return "";
    var whole = Math.round(n * 100) % 100 === 0;
    try { return new Intl.NumberFormat(c === "INR" ? "en-IN" : "en-US", { style: "currency", currency: c, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(n); }
    catch (e) { return (c === "INR" ? "₹" : c === "USD" ? "$" : c + " ") + (whole ? Math.round(n) : n.toFixed(2)); }
  }
  // the price lines on a card; GST is mentioned for rupee prices only (r25)
  function priceText(p, interval, currency) {
    if (onRequest(p)) return { main: "Price on request", unit: "", sub: "Custom pricing for larger teams" };
    var v = interval === "yearly" ? p.yearly : p.monthly, c = cur(currency);
    if (v == null) return { main: "—", unit: "monthly only", sub: "Yearly billing isn't offered for this plan" };
    var tail = c === "INR" ? "plus GST" : c === "USD" ? "in US dollars" : "in " + c;
    return { main: money(v, c), unit: interval === "yearly" ? "/year" : "/month",
      sub: interval === "yearly" ? "≈ " + money(c === "INR" ? Math.round(Number(v) / 12) : Math.round(Number(v) / 12 * 100) / 100, c) + " a month, " + tail : c === "INR" ? tail : tail.charAt(0).toUpperCase() + tail.slice(1) };
  }
  // the middle plan of 2+ is "Most studios" (same rule as checkout)
  function recommended(list) { return list.length > 1 ? list[Math.min(1, list.length - 1)].code : ""; }
  // ?plan= / stored choice -> a code that exists in the list, else the recommended one
  function pickPlan(list, want) {
    var w = String(want || "").toLowerCase();
    return list.some(function (p) { return p.code === w; }) ? w : recommended(list) || (list[0] && list[0].code) || "";
  }
  function interval(v) { return v === "yearly" ? "yearly" : "monthly"; }
  // r24: the Pay now switch - true only when config.js says HELM_FEATURES.payNow === true (missing = off)
  function payNowOn(features) {
    var f = features !== undefined ? features : (typeof global !== "undefined" && global ? global.HELM_FEATURES : null);
    return !!(f && f.payNow === true);
  }
  // which buttons a card shows: { pay, trial, sales, primary: "pay" | "sales" }
  //   opts.payNow (bool) overrides the config switch (tests); with Pay now off "Contact sales" is the primary
  function actionsFor(p, opts) {
    var o = opts || {}, ask = onRequest(p);
    var on = typeof o.payNow === "boolean" ? o.payNow : payNowOn();
    return { pay: !ask && on && o.pay !== false && offered(p, o.interval), trial: !!o.trial, sales: o.sales !== false || !on,
      primary: ask || !on ? "sales" : "pay" };
  }

  var api = { CATALOG: CATALOG, CATALOGS: CATALOGS, currencyFor: currencyFor, zoneForCountry: zoneForCountry, browserZone: browserZone, cur: cur, normalize: normalize, plansOr: plansOr, onRequest: onRequest, offered: offered, money: money,
    priceText: priceText, recommended: recommended, pickPlan: pickPlan, interval: interval, actionsFor: actionsFor, payNowOn: payNowOn };
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
  //   opts: actions() opts + { plans, currency, selected, onSelect(code) }
  function render(box, opts) {
    var o = opts || {}, list = plansOr(o.plans, o.currency), iv = interval(o.interval), rec = recommended(list);
    while (box.firstChild) box.removeChild(box.firstChild);
    box.classList.add("plans", "hpc");
    list.forEach(function (p) {
      var card = el("article", "plan" + (o.selected === p.code ? " on" : "") + (offered(p, iv) ? "" : " off"));
      card.setAttribute("data-plan", p.code);
      var pn = el("h3", "pn"); pn.appendChild(el("span", null, p.name));
      if (p.code === rec) { card.classList.add("rec"); pn.appendChild(el("span", "badge", "Most studios")); }
      card.appendChild(pn);
      card.appendChild(el("p", "pd", p.description || ""));
      var pt = priceText(p, iv, o.currency), pp = el("p", "pp" + (onRequest(p) ? " req" : ""), pt.main);
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
  global.HelmPlanCards = { CATALOG: CATALOG, CATALOGS: CATALOGS, currencyFor: currencyFor, zoneForCountry: zoneForCountry, browserZone: browserZone, cur: cur, normalize: normalize, plansOr: plansOr, onRequest: onRequest, offered: offered, money: money,
    priceText: priceText, recommended: recommended, pickPlan: pickPlan, interval: interval, actionsFor: actionsFor, payNowOn: payNowOn, actions: actions, render: render };
})(typeof window !== "undefined" ? window : globalThis);
