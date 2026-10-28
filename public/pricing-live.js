/* pricing-live.js - r28 HQ v2 round 2: the public pricing page reads plan names, texts and US-dollar prices from the
   database (public_pricing_plans, SQL 0280 - read-only, no sign-in) so a change in Helm HQ -> Plans shows here.
   SAFE FALLBACK: the page already carries the built-in prices; if the call fails, times out, returns nothing usable, or
   no card matches a database plan, NOTHING on the page changes. Text is written with textContent only (never HTML).
   Cards are matched by data-plan="<code>". A plan HQ hides (not "visible") hides its card - but only when at least one
   card matched, so a database with different plan codes can never empty the page. */
(function () {
  "use strict";
  var cfg = window.SUPABASE_CONFIG || {};
  if (!cfg.url || !cfg.anonKey || typeof fetch !== "function" || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(String(cfg.url))) return;
  function usd(n) {
    var v = Number(n); if (!isFinite(v) || v < 0) return null;
    return "$" + (Math.round(v) === v ? String(v) : v.toFixed(2)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  function priceOf(p, cur) { var a = Array.isArray(p.prices) ? p.prices : []; for (var i = 0; i < a.length; i++) if (a[i] && a[i].currency === cur) return a[i]; return null; }
  function clean(t, max) { return String(t == null ? "" : t).replace(/\s+/g, " ").trim().slice(0, max || 200); }
  function apply(list) {
    if (!Array.isArray(list) || !list.length) return;
    var byCode = {}; list.forEach(function (p) { if (p && typeof p.code === "string") byCode[p.code] = p; });
    var cards = Array.prototype.slice.call(document.querySelectorAll("[data-plan]"));
    var matched = cards.filter(function (c) { return byCode[c.getAttribute("data-plan")]; });
    if (!matched.length) return;
    cards.forEach(function (card) {
      var p = byCode[card.getAttribute("data-plan")];
      if (!p) { card.hidden = true; return; }
      var h = card.querySelector("h2"); if (h && clean(p.name, 80)) h.textContent = clean(p.name, 80);
      var f = card.querySelector(".pr-for"); if (f && clean(p.description, 300)) f.textContent = clean(p.description, 300);
      var pr = priceOf(p, "USD"), m = pr && usd(pr.monthly), y = pr && pr.yearly != null ? usd(pr.yearly) : null;
      var b = card.querySelector(".pr-price b"), alt = card.querySelector(".pr-alt");
      if (b && m && Number(pr.monthly) > 0) {
        b.textContent = m;
        if (alt) alt.textContent = y ? "or " + y + "/year" : "";
      }
      var feats = Array.isArray(p.features) ? p.features.map(function (x) { return clean(x, 120); }).filter(Boolean).slice(0, 20) : [];
      var ul = card.querySelector("ul");
      if (ul && feats.length) {
        while (ul.firstChild) ul.removeChild(ul.firstChild);
        feats.forEach(function (t) { var li = document.createElement("li"); li.textContent = t; ul.appendChild(li); });
      }
    });
  }
  var ctl = typeof AbortController === "function" ? new AbortController() : null;
  var timer = setTimeout(function () { if (ctl) ctl.abort(); }, 4000);
  fetch(String(cfg.url) + "/rest/v1/rpc/public_pricing_plans", {
    method: "POST", headers: { apikey: cfg.anonKey, Authorization: "Bearer " + cfg.anonKey, "Content-Type": "application/json" },
    body: "{}", signal: ctl ? ctl.signal : undefined, credentials: "omit", cache: "no-store"
  }).then(function (r) { return r && r.ok ? r.json() : null; })
    .then(function (list) { clearTimeout(timer); try { apply(list); } catch (e) {} })
    .catch(function () { clearTimeout(timer); });
})();
