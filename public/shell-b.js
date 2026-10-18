/* shell-b.js - LOCAL PROTOTYPE: the new app layout (owner picked "B - icon rail").
 * Left rail: monochrome line icons in segments (Workspace / Manage / Admin), recent pages, theme toggle, profile at the bottom.
 * Top bar: page title, search, notifications, tour, New quote.
 * Existing widgets (bell, search, recent, avatar menu, theme toggle) are MOVED, never cloned, so their own JS keeps working.
 * DOM APIs only. Loaded by shell-proto.js. */
(function () {
  "use strict";
  if (/builder|floor-plan/.test(location.pathname)) return;
  if (document.getElementById("hbRail")) return;
  var PIN = "helm.shellb.pin";
  var page = (location.pathname.split("/").pop() || "dashboard.html").toLowerCase();
  if (page === "" || page === "index.html" || page === "dashboard") page = "dashboard.html";
  if (!/\.html$/.test(page)) page += ".html";
  try { if (window.HelmUrl && HelmUrl.route && HelmUrl.route()) page = HelmUrl.page() + ".html"; } catch (e) {}   /* pretty URLs: /<studio>/settings → control.html */
  function ls(k, v) { try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { return null; } }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  /* ---- monochrome line icons (24px grid, stroke = currentColor) ---- */
  var P = {
    dashboard: "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z",
    quotes: "M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M9 13h6M9 17h6",
    leads: "M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M12 12h.01",
    calendar: "M4 6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1zM4 10h16M8 3v4M16 3v4",
    chat: "M4 5h16v11H9l-5 4z",
    crm: "M4 4h16v5H4zM5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4",
    nurture: "M12 21v-9M12 12c0-4 3-7 8-7 0 5-3 8-8 7zM12 15c0-3-2-5-7-5 0 4 2 6 7 5z",
    staff: "M9 8m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M3 20c0-3 3-5 6-5s6 2 6 5M16 5a3 3 0 0 1 0 6M18 15c2 .5 3 2 3 5",
    inventory: "M3 7l9-4 9 4-9 4zM3 7v10l9 4 9-4V7M12 11v10",
    vendors: "M3 9l2-5h14l2 5M3 9v11h18V9M3 9h18M9 20v-6h6v6",
    templates: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
    venues: "M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6",
    controls: "M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1",
    insights: "M3 17l6-6 4 4 8-8M15 7h6v6",
    reports: "M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM14 3v5h5M9 18v-3M12 18v-6M15 18v-2",
    setup: "M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M15 9h.01M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5",
    business: "M4 8h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM9 8V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v3M3 13h18",
    audit: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
    integrations: "M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4",
    ops: "M4 6h16M4 12h16M4 18h10",
    dot: "M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0",
    pin: "M15 4l5 5-3 1-4 4 1 4-2 2-4-4-4 4M9 11l4 4",
    moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
    sun: "M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
    menu: "M4 6h16M4 12h16M4 18h16",
    history: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
    search: "M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0M20 20l-4-4",
    star: "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z",
    help: "M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01",
    plus: "M12 5v14M5 12h14",
    sliders: "M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1M15 5v4M9 10v4M17 15v4"
  };
  var NS = "http://www.w3.org/2000/svg";
  function icon(name) {
    var s = document.createElementNS(NS, "svg");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("aria-hidden", "true"); s.setAttribute("class", "hb-svg");
    var p = document.createElementNS(NS, "path"); p.setAttribute("d", P[name] || P.dot); s.appendChild(p); return s;
  }
  var KEY_ICON = { crm: "crm", nurture: "nurture", staff: "staff", inventory: "inventory", vendors: "vendors", templates: "templates",
    venues: "venues", controls: "controls", insights: "insights", reports: "reports", setup: "setup", audit: "audit", ops: "ops", integrations: "integrations" };

  /* relative links break on pretty studio URLs (/<studio>/quotes → /<studio>/calendar.html = 404): always root them */
  function abs(h) { return (typeof h === "string" && h && !/^([a-z]+:|\/|#)/i.test(h)) ? "/" + h : h; }
  function item(iconName, label, href, key) {
    var a = el("a", "hb-item"); a.href = abs(href); a.setAttribute("aria-label", label);
    if (key) { a.setAttribute("data-key", key); a.setAttribute("data-nav", key); REG[key] = [iconName, label, href, key]; }
    var i = el("span", "hb-ic"); i.appendChild(icon(iconName)); a.appendChild(i);
    a.appendChild(el("span", "hb-lb", label));
    var sc = key && SC_HINT[key];
    if (sc) a.setAttribute("aria-keyshortcuts", sc);   /* no native title: the expanded rail already shows the label, and the OS tooltip overlapped the next row + pin star */
    if (key && COUNT_KEYS[key]) { var c = el("span", "hb-cnt"); c.hidden = true; c.setAttribute("aria-hidden", "true"); a.appendChild(c); }
    var target = href.toLowerCase().split("?")[0].replace(/^\//, "");
    if (target === page || (target === "quotes.html" && /^(event|flow|ops|closure|settlement|proposal|runsheet|budget|logistics|plan|design|client)\.html$/.test(page))) { a.classList.add("on"); a.setAttribute("aria-current", "page"); }
    return a;
  }
  var REG = {};   /* rail items by key, for the Pinned group */
  var ALWAYS_NAV = { dashboard: 1, chat: 1 };   /* crew-1020: team chat is open to every signed-in member (no area gate) */
  var SC_HINT = { dashboard: "G D", quotes: "G Q", leads: "G L", calendar: "G C", chat: "G M", business: "G B" };
  var COUNT_KEYS = { leads: 1, quotes: 1, chat: 1 };
  function group(title) {
    var g = el("div", "hb-group"); g.appendChild(el("div", "hb-head", title)); return g;
  }

  function startQuote() {
    if (page === "dashboard.html") { safe(dashCreate); return; }
    location.href = "/dashboard.html#hb-new";
  }

  /* move a widget into a slot as soon as it exists (auth-ui / bell / theme build theirs after load) */
  /* no deadline: one MutationObserver for the page's lifetime re-adopts widgets whenever a page re-renders #account
   * (auth-ui builds a fresh search trigger / recent / avatar menu inside the hidden #account). `dedupe` removes the stale copy. */
  var ADOPT = [], adoptQueued = false;
  function adoptRun() {
    adoptQueued = false;
    ADOPT.forEach(function (a) {
      var node = null; try { node = a.find(); } catch (e) {}
      if (!node || node.parentNode === a.slot || node.contains(a.slot)) return;
      try {
        if (a.dedupe) Array.prototype.slice.call(a.slot.querySelectorAll(a.dedupe)).forEach(function (o) { if (o !== node && o.parentNode === a.slot) a.slot.removeChild(o); });
        a.slot.appendChild(node); if (a.keep) a.keep(node);
      } catch (e) {}
    });
  }
  function adoptSoon() { if (adoptQueued) return; adoptQueued = true; setTimeout(adoptRun, 30); }
  function adopt(find, slot, keep, dedupe) {
    ADOPT.push({ find: find, slot: slot, keep: keep, dedupe: dedupe });
    adoptSoon();
    if (!adopt.mo && window.MutationObserver && document.body) {
      adopt.mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) if (muts[i].addedNodes && muts[i].addedNodes.length) { adoptSoon(); return; }
      });
      adopt.mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  /* ---- guided tour: page steps when tour.js has them, else a generic tour of the shell ---- */
  /* on-screen reading order: the sidebar top to bottom, then the top bar left to right */
  var SHELL_TOUR = [
    { sel: "[data-tour='pin']", side: "right", title: "Keep it open", desc: "Pin the sidebar to keep the labels visible, or leave it slim and hover to expand." },
    { sel: "#hbRail .hb-group:not(.hb-fav)", side: "right", title: "Your workspace", desc: "Every area of Helm lives in this sidebar: Workspace for daily work, Manage and Admin below it. Scroll the list if it is taller than your screen." },
    { sel: ".hb-recent .htr-btn", side: "right", title: "Recently viewed", desc: "Jump back to the pages and events you opened last." },
    { sel: "[data-tour='theme']", side: "right", title: "Look and feel", desc: window.HELM_DARK_MODE === true ? "Switch dark mode and pick a colour theme." : "Pick a colour theme: Emerald, Cobalt, Midnight, Graphite or Studio." },
    { sel: "[data-tour='account']", side: "right", title: "Your account", desc: "Profile, studio settings and sign out." },
    { sel: "[data-tour='search']", title: "Search anything", desc: "Find quotes, leads, clients and pages from one box. Press / or Ctrl+K." },
    { sel: "[data-tour='bell']", title: "Notifications", desc: "Approvals, payments and mentions arrive here." },
    { sel: "[data-tour='new']", title: "Create", desc: "Start a new quote, lead or event from any page." }
  ];
  function startTour() {
    var hb = document.getElementById("helpBtn");
    if (hb && !hb.closest("#hbRail")) { hb.click(); return; }   /* the page's own tour (dashboard) */
    function go() {
      var T = window.HelmTour; if (!T || typeof T.start !== "function") return;
      if (T.hasSteps) T.start(); else T.start(SHELL_TOUR.filter(function (st) { return !/hb-recent/.test(st.sel) || document.querySelector(".hb-recent .htr-btn"); }), "helm_tour_shell");
    }
    if (window.HelmTour) { go(); return; }
    var sc = document.createElement("script"); sc.src = "/tour.js?v=" + (window.HELM_SHELL_V || "1"); sc.onload = go; document.head.appendChild(sc);
  }

  function build() {
    if (document.getElementById("hbRail")) return;
    var root = document.documentElement, body = document.body;
    /* labels-by-default: a brand-new user (no tour seen, no shell prefs yet) starts with the rail pinned open; existing users keep
       their stored choice (unset = slim). Unpinning stores "0" so the choice sticks. */
    if (ls(PIN) === null) safe(function () {
      var fresh = true; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i) || ""; if (k.indexOf("helm_tour") === 0 || k.indexOf("helm.shellb.") === 0) { fresh = false; break; } }
      if (fresh) ls(PIN, "1");
    });
    if (ls(PIN) === "1") root.classList.add("hb-pinned");

    /* ---------- rail ---------- */
    var rail = el("nav", "hb-rail"); rail.id = "hbRail"; rail.setAttribute("aria-label", "App navigation"); rail.setAttribute("data-tour", "nav");
    var top = el("div", "hb-top");
    var brand = el("a", "hb-brand"); brand.href = "/dashboard.html"; brand.setAttribute("aria-label", "Helm home");
    var logo = el("span", "hb-logo"); logo.setAttribute("aria-hidden", "true");
    /* Helm logo = brand-kit shape (compass-H + ELM), recoloured per theme: classes hl-ink / hl-acc / hl-ring read
       --hl-ink / --hl-acc / --hl-ring from shell-b.css, so a theme switch recolours it live. Collapsed rail = symbol only.
       Geometry copied from docs/HELM_Brand_and_Website_Kit 2 (helm-primary.svg); built with createElementNS (CSP-safe). */
    var HL = {"arcs": ["M 124.37,175.11 A 235,235 0 0 1 290.61,88.57", "M 323.39,88.57 A 235,235 0 0 1 481.64,165.75", "M 494.68,181.57 A 235,235 0 0 1 489.63,470.89", "M 467.27,494.87 A 235,235 0 0 1 327.48,557.11", "M 286.52,557.11 A 235,235 0 0 1 140.83,489.17", "M 119.32,464.43 A 235,235 0 0 1 121.82,178.32"], "ticks": ["M 132.9 154.9 L 105.6 128.5", "M 481.1 154.9 L 508.4 128.5", "M 481.1 491.1 L 508.4 517.5", "M 132.9 491.1 L 105.6 517.5"], "h": "M148 153 H232 V284 H386 V153 H475 V486 H386 V363 H232 V486 H148 Z", "pts": ["M307 5 L256 272 L286 263 L307 102 L333 265 L356 272 Z", "M6 324 L269 260 L269 280 L114 323 Z", "M6 324 L269 368 L269 387 Z", "M280 365 L307 633 L340 365 Z"], "elm": ["M518 153 H790 V220 H607 V290 H765 V357 H607 V416 H792 V486 H518 Z", "M822 153 H910 V416 H1037 V486 H822 Z", "M1060 486 V153 H1147 L1272 354 L1397 153 H1505 V486 H1419 V296 L1288 447 H1254 L1146 295 V486 Z"], "rw": 17, "tw": 15, "gap": 20};
    function hlSvg(vb, cls) { var SN = "http://www.w3.org/2000/svg", sv = document.createElementNS(SN, "svg");
      sv.setAttribute("class", cls); sv.setAttribute("viewBox", vb); sv.setAttribute("focusable", "false"); sv.setAttribute("aria-hidden", "true");
      sv.mk = function (n, a, p) { var e = document.createElementNS(SN, n); for (var k in a) e.setAttribute(k, a[k]); (p || sv).appendChild(e); return e; }; return sv; }
    var sym = hlSvg("-14 -10 591 660", "hl-logo hb-sym"), mk = sym.mk;
    var msk = mk("mask", { id: "hlm-gap-rail", maskUnits: "userSpaceOnUse", x: -10, y: -10, width: 600, height: 660 });
    mk("rect", { x: -10, y: -10, width: 600, height: 660, fill: "#fff" }, msk);
    var mg = mk("g", { fill: "#000", stroke: "#000", "stroke-width": HL.gap, "stroke-linejoin": "round" }, msk); HL.pts.forEach(function (d) { mk("path", { d: d }, mg); });
    var r1 = mk("g", { "class": "hl-ring", fill: "none", stroke: "currentColor", "stroke-width": HL.rw, "stroke-linecap": "round" }); HL.arcs.forEach(function (d) { mk("path", { d: d }, r1); });
    var r2 = mk("g", { "class": "hl-ring", fill: "none", stroke: "currentColor", "stroke-width": HL.tw, "stroke-linecap": "round" }); HL.ticks.forEach(function (d) { mk("path", { d: d }, r2); });
    mk("path", { "class": "hl-ink", d: HL.h, fill: "currentColor", mask: "url(#hlm-gap-rail)" });
    var pg = mk("g", { "class": "hl-acc", fill: "currentColor", stroke: "currentColor", "stroke-width": 5, "stroke-linejoin": "round" }); HL.pts.forEach(function (d) { mk("path", { d: d }, pg); });
    logo.appendChild(sym);
    var elm = el("span", "hb-lb hb-name"); elm.setAttribute("aria-hidden", "true");
    var es = hlSvg("505 -10 1011 660", "hl-logo hb-elm"), eg = es.mk("g", { "class": "hl-ink", fill: "currentColor" }); HL.elm.forEach(function (d) { es.mk("path", { d: d }, eg); });
    elm.appendChild(es);
    brand.appendChild(logo); brand.appendChild(elm);
    var pin = el("button", "hb-pin"); pin.type = "button"; pin.setAttribute("data-tour", "pin"); pin.appendChild(icon("pin"));
    function syncPin() { var p = root.classList.contains("hb-pinned"); pin.setAttribute("aria-pressed", p ? "true" : "false"); pin.title = p ? "Unpin sidebar" : "Keep sidebar open"; pin.setAttribute("aria-label", pin.title); }
    pin.addEventListener("click", function () { root.classList.toggle("hb-pinned"); ls(PIN, root.classList.contains("hb-pinned") ? "1" : "0"); syncPin(); });
    syncPin();
    top.appendChild(brand); top.appendChild(pin); rail.appendChild(top);

    var scroll = el("div", "hb-scroll");
    var work = group("Workspace");
    [["dashboard", "Dashboard", "dashboard.html", "dashboard"], ["quotes", "Quotes", "quotes.html", "quotes"], ["leads", "Leads", "leads.html", "leads"],
     ["calendar", "Calendar", "calendar.html", "calendar"], ["chat", "Chat", "chat.html", "chat"]].forEach(function (x) { var it = item(x[0], x[1], x[2], x[3]); if (!ALWAYS_NAV[x[0]]) it.hidden = true; work.appendChild(it); });   /* crew-1020: gated items start hidden (no Quotes/Leads flash) */
    var manage = group("Manage"); manage.hidden = true; manage.setAttribute("data-tour", "nav-manage");
    var admin = group("Admin"); admin.hidden = true; admin.setAttribute("data-tour", "nav-admin");
    var favs = group("Pinned"); favs.classList.add("hb-fav"); favs.hidden = true; favs.id = "hbFavs";
    scroll.appendChild(favs);
    scroll.appendChild(work); scroll.appendChild(manage); scroll.appendChild(admin);
    rail.appendChild(scroll);

    var bottom = el("div", "hb-bottom");
    // theme toggle: move the app's own toggle in, give it a label + line icon that follow the theme
    var themeSlot = el("div", "hb-slot hb-theme"); themeSlot.setAttribute("data-tour", "theme");
    var DARK_ON = window.HELM_DARK_MODE === true;   /* dark mode off (Oct 2026): no light/dark toggle in the rail, only the colour theme picker */
    if (DARK_ON) adopt(function () { return document.getElementById("bpThemeToggle"); }, themeSlot, function (b) {
      if (b.dataset.hbDone) return; b.dataset.hbDone = "1"; b.classList.add("hb-item");
      var paint = function () {
        var dark = root.getAttribute("data-theme") === "dark";
        while (b.firstChild) b.removeChild(b.firstChild);
        var i = el("span", "hb-ic"); i.appendChild(icon(dark ? "sun" : "moon")); b.appendChild(i);
        b.appendChild(el("span", "hb-lb", dark ? "Light mode" : "Dark mode"));
      };
      paint();
      new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    });
    var acctSlot = el("div", "hb-slot hb-acct"); acctSlot.setAttribute("data-tour", "account");
    safe(function () { customizeItem(acctSlot); });
    var who = el("div", "hb-who hb-lb");
    var whoName = el("b", null, ""), whoRole = el("small", null, "");
    who.appendChild(whoName); who.appendChild(whoRole);
    adopt(function () { return document.querySelector("#account .hau-mw"); }, acctSlot, function () {
      acctSlot.appendChild(who); safe(function () { fillWho(whoName, whoRole); });
    }, ".hau-mw");
    /* FLAG (Oct 2026): "Recently viewed" in the rail is OFF until it is flicker-free (late adoption after auth moved the
     * footer, popover re-anchoring). Code kept; turn on with window.HELM_FLAGS = { recentViewed: true } before shell-b.js. */
    var RECENT_ON = !!(window.HELM_FLAGS && window.HELM_FLAGS.recentViewed === true);
    if (!RECENT_ON) root.classList.add("hb-no-recent");
    var recentSlot = el("div", "hb-slot hb-recent");
    if (RECENT_ON) adopt(function () { return document.querySelector("#account .htr-w") || document.querySelector(".htr-w:not(.hb-recent .htr-w)"); }, recentSlot, function (w) {
      var b = w.querySelector(".htr-btn"); if (!b || b.dataset.hbDone) return; b.dataset.hbDone = "1"; b.classList.add("hb-item");
      while (b.firstChild) b.removeChild(b.firstChild);
      var i = el("span", "hb-ic"); i.appendChild(icon("history")); b.appendChild(i); b.appendChild(el("span", "hb-lb", "Recently viewed")); b.title = "Recently viewed pages"; b.setAttribute("aria-label", "Recently viewed pages");
    }, ".htr-w");
    var tourSlot = el("div", "hb-slot hb-tour"); tourSlot.setAttribute("data-tour", "tour");
    /* v86: the rail owns ONE tour button from the first paint (no late adoption = no footer jump). It works on every app page:
     * a page's own #helpBtn (e.g. the dashboard's custom tour) wins; else tour.js steps for this page; else a generic shell tour.
     * tour.js is loaded on demand when the page does not include it. */
    var tourBtn = el("button", "hb-item hb-tourbtn"); tourBtn.type = "button";
    var ti = el("span", "hb-ic"); ti.appendChild(icon("help")); tourBtn.appendChild(ti); tourBtn.appendChild(el("span", "hb-lb", "Take a guided tour"));
    tourBtn.title = "Guided product tour: a quick walkthrough of this page"; tourBtn.setAttribute("aria-label", "Start guided product tour");
    tourBtn.addEventListener("click", function () { safe(startTour); });
    tourSlot.appendChild(tourBtn);
    /* accent theme picker: swatch button beside the dark-mode toggle, popover floats beside the rail */
    safe(function () {
      var TH = [["emerald", "Emerald", "#047857"], ["cobalt", "Cobalt", "#2450f0"], ["midnight", "Midnight", "#1e1b4b"], ["graphite", "Graphite", "#000000"], ["studio", "Studio", "#5B2A86"]];
      var cur = function () { return root.getAttribute("data-hb-theme") || "emerald"; };
      var sw;
      if (DARK_ON) { sw = el("button", "hb-swbtn"); sw.appendChild(el("span", "hb-swdot")); }
      else {   /* no dark toggle beside it: the picker is a full rail item ("Theme") so the footer row is never empty */
        sw = el("button", "hb-item hb-switem"); sw.id = "hbThemePick"; var si = el("span", "hb-ic"); si.appendChild(el("span", "hb-swdot")); sw.appendChild(si);
        sw.appendChild(el("span", "hb-lb", "Colour theme"));
      }
      sw.type = "button"; sw.title = "Colour theme"; sw.setAttribute("aria-label", "Colour theme");
      sw.setAttribute("aria-haspopup", "true"); sw.setAttribute("aria-expanded", "false");
      var pop = el("div", "hb-swpop"); pop.hidden = true; pop.setAttribute("role", "group"); pop.setAttribute("aria-label", "Colour theme");
      pop.appendChild(el("div", "hb-swhd", "Theme"));
      var opts = [];
      TH.forEach(function (t) {
        var o = el("button", "hb-swopt"); o.type = "button"; o.setAttribute("data-t", t[0]);
        var d = el("span", "hb-swchip"); d.style.background = t[2]; o.appendChild(d); o.appendChild(el("span", null, t[1]));
        o.addEventListener("click", function () {
          root.setAttribute("data-hb-theme", t[0]);
          try { localStorage.setItem("helm.shellb.theme", t[0]); } catch (e) {}
          mark(); close(); sw.focus();
        });
        opts.push(o); pop.appendChild(o);
      });
      function mark() { opts.forEach(function (o) { o.setAttribute("aria-pressed", o.getAttribute("data-t") === cur() ? "true" : "false"); }); }
      function close() { pop.hidden = true; sw.setAttribute("aria-expanded", "false"); root.classList.remove("hb-sw-open"); }
      sw.addEventListener("click", function (e) { e.stopPropagation(); var open = pop.hidden; mark(); pop.hidden = !open; sw.setAttribute("aria-expanded", open ? "true" : "false"); root.classList.toggle("hb-sw-open", open); if (open) { var on = pop.querySelector('[aria-pressed="true"]'); if (on) on.focus(); } });
      document.addEventListener("click", function (e) { if (!pop.hidden && !pop.contains(e.target)) close(); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !pop.hidden) { close(); sw.focus(); } });
      themeSlot.appendChild(sw); document.body.appendChild(pop);
    });
    if (RECENT_ON) bottom.appendChild(recentSlot); bottom.appendChild(tourSlot); bottom.appendChild(themeSlot); bottom.appendChild(acctSlot);
    rail.appendChild(bottom);
    /* v86: short windows (< 1100px tall): Recently viewed + Tour move from the pinned footer to the END of the scrolling nav,
     * so the footer is only theme + account and Admin (Reports, Audit log, Studio setup) is never squeezed out of view.
     * A fade at the scroll edges shows there is more to scroll; the active item is scrolled into view. */
    /* r19 L4: its own name - build() later declares `var tools` for the header's tool row, and with one hoisted `var` the
     * first window resize moved the tour button into the header (and a tall window then HID the header's search/bell/New). */
    var ftools = el("div", "hb-group hb-ftools"); scroll.appendChild(ftools);
    function placeTools() {
      var short = window.innerHeight < 1100 && window.innerWidth >= 820;
      var host = short ? ftools : bottom;
      if (tourSlot.parentNode !== host) { if (RECENT_ON) host.insertBefore(recentSlot, short ? null : themeSlot); host.insertBefore(tourSlot, short ? null : themeSlot); }
      ftools.hidden = !short;
      edges();
    }
    function edges() {
      var t = scroll.scrollTop > 2, b = scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - 2;
      if (scroll.classList.contains("hb-more-t") !== t) scroll.classList.toggle("hb-more-t", t);
      if (scroll.classList.contains("hb-more-b") !== b) scroll.classList.toggle("hb-more-b", b);
    }
    var userNav = false;   /* keep the active page in view while items arrive, until the user scrolls/clicks the rail */
    ["wheel", "pointerdown", "touchstart", "keydown"].forEach(function (t) { rail.addEventListener(t, function () { userNav = true; }, { passive: true }); });
    scroll.addEventListener("scroll", edges, { passive: true });
    window.addEventListener("resize", placeTools);
    if (window.ResizeObserver) new ResizeObserver(edges).observe(scroll);
    if (window.MutationObserver) new MutationObserver(function () { edges(); var on = scroll.querySelector(".hb-item.on"); if (on && !userNav && on.offsetParent && scroll.clientHeight) { var r = on.getBoundingClientRect(), s = scroll.getBoundingClientRect(); if (r.bottom > s.bottom || r.top < s.top) scroll.scrollTop += r.top - s.top - s.height / 2; } })
      .observe(scroll, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden"] });
    placeTools();
    var skip = document.querySelector("body > .skip-link, body > a[href='#main']:first-child");   /* skip link stays first in tab order */
    body.insertBefore(rail, skip ? skip.nextSibling : body.firstChild);
    /* <base href="/"> pages: keep in-page skip links on this page instead of jumping to the site root */
    document.addEventListener("click", function (e) { var a = e.target.closest && e.target.closest("a[href^='#']"); if (!a || a.getAttribute("href").length < 2) return; var t = document.getElementById(a.getAttribute("href").slice(1)); if (!t) return; e.preventDefault(); if (!t.hasAttribute("tabindex")) t.setAttribute("tabindex", "-1"); t.focus(); t.scrollIntoView(); });
    var scrim = el("div", "hb-scrim"); scrim.addEventListener("click", function () { root.classList.remove("hb-drawer"); }); body.appendChild(scrim);
    /* tour.js ignores Escape while any [aria-modal] exists - and the bell panel always does (just not visible): close the tour here */
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      safe(function () { var sk = document.querySelector(".htour .skip"); if (!sk || !sk.offsetParent || document.querySelector(".hss-ov, .bpui-overlay")) return;
        var other = Array.prototype.some.call(document.querySelectorAll("[aria-modal='true']"), function (m) { return m.offsetParent && !m.closest(".htour"); });
        if (!other) sk.click(); });
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && root.classList.contains("hb-drawer")) { root.classList.remove("hb-drawer"); var bg = document.querySelector(".hb-burger"); if (bg && bg.offsetParent) bg.focus(); } });

    /* ---------- top bar ---------- */
    var header = document.querySelector("body > header") || document.querySelector("header");
    if (header && !header.querySelector(".hb-tools")) {
      header.classList.add("hb-header");
      // older pages put the brand in <h1> and the page name in <small>: the bar shows the page name
      safe(function () {
        var h = header.querySelector("h1"), sm = header.querySelector("h1 + small");
        if (h && page === "dashboard.html") { h.textContent = "Dashboard"; return; }
        if (h && sm && /^\s*helm(\s+events)?\s*$/i.test(h.textContent) && sm.textContent.trim()) {
          var full = sm.textContent.trim(), short = String(sm.getAttribute("data-short") || "").trim();
          if (!short || short === full) h.textContent = full;
          else {   /* la-1018: a short name for phones ("Leads" instead of a clipped "Leads & …"); the full one stays for screen readers */
            h.textContent = ""; h.title = full;
            var lf = el("span", "hb-tl", full), ls = el("span", "hb-ts", short); ls.setAttribute("aria-hidden", "true");
            h.appendChild(lf); h.appendChild(ls);
          }
        }
      });
      safe(function () { navTrim(header); });
      if (header.parentNode !== body) body.insertBefore(header, rail.nextSibling);
      safe(function () { var tr = document.getElementById("helmTrail"); if (tr) tr.classList.add("hb-trail"); });   // full-width bar, not inside the page column
      var burger = el("button", "hb-burger hb-ibtn"); burger.type = "button"; burger.setAttribute("aria-label", "Open menu"); burger.appendChild(icon("menu"));
      burger.addEventListener("click", function (e) { e.stopPropagation(); root.classList.toggle("hb-drawer"); });
      header.insertBefore(burger, header.firstChild);
      var tools = el("div", "hb-tools");
      var searchSlot = el("div", "hb-tslot hb-search"); searchSlot.setAttribute("data-tour", "search");
      var chat = el("a", "hb-ibtn hb-chat"); chat.href = "/chat.html"; chat.title = "Chat"; chat.setAttribute("aria-label", "Chat"); chat.setAttribute("data-tour", "chat"); chat.appendChild(icon("chat"));
      if (page === "chat.html") { chat.classList.add("on"); body.classList.add("hb-chatpage"); }
      var bellSlot = el("div", "hb-tslot hb-bell"); bellSlot.setAttribute("data-tour", "bell");
      var chatBadge = el("span", "hb-badge"); chatBadge.hidden = true; chatBadge.setAttribute("aria-hidden", "true"); chat.appendChild(chatBadge);
      var split = el("div", "hb-split"); split.hidden = true; split.setAttribute("data-tour", "new");
      var nq = el("button", "hb-new"); nq.type = "button"; nq.setAttribute("aria-label", "New quote");
      nq.appendChild(icon("plus")); nq.appendChild(el("span", null, "New quote"));
      nq.addEventListener("click", startQuote);
      split.appendChild(nq);
      tools.appendChild(searchSlot); tools.appendChild(chat); tools.appendChild(bellSlot); tools.appendChild(split);
      header.appendChild(tools);
      adopt(function () { return document.getElementById("helm-topbar-search"); }, searchSlot);
      (function hint(n) {   /* subtle "jump to" hint + ⌘K chip in the header search field */
        var tl = document.querySelector(".hb-search .hss-tl"), tr = document.querySelector(".hb-search .hss-trig");
        if (!tl || !tr) { if (n < 40) setTimeout(function () { hint(n + 1); }, 150); return; }
        tl.textContent = "Search or jump to…"; tr.classList.add("hb-hint");
        var kb = tr.querySelector(".hss-kbd"); if (kb) kb.textContent = MAC ? "⌘K" : "Ctrl K";
      })(0);
      if (!document.getElementById("bell") && !document.getElementById("bpBellBtn")) safe(function () { autoBell(bellSlot); });
      adopt(function () { return document.getElementById("bell"); }, bellSlot);
      var ms = el("button", "hb-ibtn hb-msearch"); ms.type = "button"; ms.setAttribute("aria-label", "Search"); ms.title = "Search"; ms.setAttribute("data-tour", "search-m"); ms.appendChild(icon("search"));
      ms.addEventListener("click", function () { safe(openSearch); });
      tools.insertBefore(ms, chat);
      safe(function () { quickCreate(split, nq); });
      safe(function () { chatUnread(chat, chatBadge); });
    }
    safe(function () { bottomBar(root, body); });
    safe(function () { watchPopovers(root); });
    safe(function () { favsInit(favs, [work]); });
    /* data-nav-ready: the role-gated Manage / Admin items are in (the dashboard's first-run tour waits for it) */
    fillMore(manage, admin, function () { safe(function () { favsInit(favs, [manage, admin]); }); rail.setAttribute("data-nav-ready", "1"); });
    safe(railCounts);
    safe(shortcuts);
    if (location.hash === "#hb-new") {
      safe(function () { history.replaceState(null, "", location.pathname + location.search); });
      if (page === "dashboard.html") safe(dashCreate);
      else {
        var tries = 0, t = setInterval(function () {
          try {
            var b = document.getElementById("newBtn");   /* .click() works without layout: no offsetParent check */
            if (b && !b.hidden) { clearInterval(t); b.click(); }
            else if (++tries > 60) clearInterval(t);
          } catch (e) { clearInterval(t); }
        }, 250);
      }
    }
    safe(function () { gateWork(work); });
    safe(adminExtras.bind(null, admin));
  }

  function waitAuth(cb) {
    var n = 0; (function poll() {
      if (window.BPStore && BPStore.auth && typeof BPStore.auth.areas === "function") return safe(cb);
      if (++n < 200) setTimeout(poll, 150);   /* ~30s: slow auth / MFA / cold start */
    })();
  }
  function safe(fn) { try { fn(); } catch (e) { try { console.warn("[shell-b]", e); } catch (x) {} } }
  function can(area, edit) {
    var a = window.BPStore && BPStore.auth; if (!a) return Promise.resolve(false);
    var fn = edit ? (a.canEditArea || a.canView) : a.canView;
    if (typeof fn !== "function") return Promise.resolve(false);
    try { return Promise.resolve(fn.call(a, area)).then(function (x) { return !!x; }, function () { return false; }); } catch (e) { return Promise.resolve(false); }
  }

  /* ---- quick-create split button ---- */
  var CREATE = [
    { label: "New quote", icon: "quotes", area: "quotes", edit: true, run: startQuote },
    { label: "New lead", icon: "leads", area: "leads", edit: true, href: "leads.html#hb-new" },
    { label: "Checklist template", icon: "templates", area: "templates", edit: true, href: "templates.html" },
    { label: "Inventory item", icon: "inventory", area: "inventory", edit: true, href: "inventory.html#hb-new" },
    { label: "Vendor", icon: "vendors", area: "vendors", edit: true, href: "vendors.html#hb-new" },
    { label: "Staff member", icon: "staff", area: "staff", edit: true, href: "staff.html#hb-new" }
  ];
  function go(href) {
    var target = href.split("#")[0].replace(/^\//, "");
    if (target === page && /#hb-new$/.test(href)) { var b = document.getElementById("newBtn"); if (b && !b.hidden) { b.click(); return; } }
    location.href = abs(href);
  }
  function quickCreate(split, nq) {
    waitAuth(function () {
      Promise.all(CREATE.map(function (c) { return can(c.area, c.edit); })).then(function (ok) {
        // free trial (0181): no "Checklist template" (Templates is not part of the trial)
        var trial = document.documentElement.classList.contains("helm-trial");
        var items = CREATE.filter(function (c, i) { return ok[i] && !(trial && c.area === "templates"); });
        if (!items.length) return;
        split.hidden = false;
        if (!ok[0]) { nq.hidden = true; }
        if (items.length < 2 && ok[0]) return;   // only "New quote": plain button
        var chev = el("button", "hb-new hb-chev"); chev.type = "button";
        chev.setAttribute("aria-label", "More create options"); chev.setAttribute("aria-haspopup", "menu"); chev.setAttribute("aria-expanded", "false");
        var cs = document.createElementNS(NS, "svg"); cs.setAttribute("viewBox", "0 0 24 24"); cs.setAttribute("class", "hb-svg"); cs.setAttribute("aria-hidden", "true");
        var cp = document.createElementNS(NS, "path"); cp.setAttribute("d", "M6 9l6 6 6-6"); cs.appendChild(cp); chev.appendChild(cs);
        if (!ok[0]) { chev.classList.add("hb-solo"); chev.insertBefore(icon("plus"), cs); chev.insertBefore(el("span", null, "New"), cs); }
        var menu = el("div", "hb-menu"); menu.setAttribute("role", "menu"); menu.hidden = true; menu.id = "hbCreateMenu";
        chev.setAttribute("aria-controls", menu.id);
        items.forEach(function (c) {
          var b = el("button", "hb-mi"); b.type = "button"; b.setAttribute("role", "menuitem"); b.tabIndex = -1; b.setAttribute("data-area", c.area);
          b.appendChild(icon(c.icon)); b.appendChild(el("span", null, c.label));
          b.addEventListener("click", function () { close(false); if (c.run) c.run(); else go(c.href); });
          menu.appendChild(b);
        });
        split.appendChild(chev); split.appendChild(menu);
        function mis() { return Array.prototype.slice.call(menu.querySelectorAll(".hb-mi")); }
        function open(focusIdx) {
          menu.hidden = false; chev.setAttribute("aria-expanded", "true"); document.documentElement.classList.add("hb-pop-open");
          var l = mis(); if (l.length) l[(focusIdx < 0 ? l.length - 1 : 0)].focus();
        }
        function close(restore) {
          if (menu.hidden) return;
          menu.hidden = true; chev.setAttribute("aria-expanded", "false"); document.documentElement.classList.remove("hb-pop-open");
          if (restore) chev.focus();
        }
        chev.addEventListener("click", function (e) { e.stopPropagation(); if (menu.hidden) open(0); else close(true); });
        chev.addEventListener("keydown", function (e) {
          if (e.key === "ArrowDown") { e.preventDefault(); open(0); } else if (e.key === "ArrowUp") { e.preventDefault(); open(-1); }
        });
        menu.addEventListener("keydown", function (e) {
          var l = mis(), i = l.indexOf(document.activeElement);
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
          else if (e.key === "ArrowDown") { e.preventDefault(); l[(i + 1) % l.length].focus(); }
          else if (e.key === "ArrowUp") { e.preventDefault(); l[(i - 1 + l.length) % l.length].focus(); }
          else if (e.key === "Home") { e.preventDefault(); l[0].focus(); }
          else if (e.key === "End") { e.preventDefault(); l[l.length - 1].focus(); }
          else if (e.key === "Tab") close(false);
        });
        document.addEventListener("click", function (e) { if (!split.contains(e.target)) close(false); });
      });
    });
  }

  /* ---- chat unread badge (same source as the bell: BPStore.chat.notifications) ---- */
  function chatUnread(link, badge) {
    var busy = false;
    function set(n) {
      badge.hidden = !n; badge.textContent = n > 9 ? "9+" : n ? String(n) : "";
      link.setAttribute("aria-label", n ? "Chat, " + n + " unread" : "Chat"); link.title = link.getAttribute("aria-label");
    }
    function poll() {
      if (busy || document.hidden) return;
      var c = window.BPStore && BPStore.chat;
      if (!c || typeof c.notifications !== "function") return;
      if (BPStore.auth && typeof BPStore.auth.user === "function") { try { if (!BPStore.auth.user()) return; } catch (e) { return; } }
      busy = true;
      Promise.resolve().then(function () { return c.notifications(50); }).then(function (rows) {
        var n = 0; (Array.isArray(rows) ? rows : []).forEach(function (r) { n += (r && Number(r.count)) || 1; });
        set(page === "chat.html" ? 0 : n); railCount("chat", page === "chat.html" ? 0 : n);
      }, function () {}).then(function () { busy = false; }, function () { busy = false; });
    }
    /* perf: first poll once the page has loaded and gone idle (chat reads never compete with the page's own data) */
    waitAuth(function () {
      var idle = function () { if (window.requestIdleCallback) window.requestIdleCallback(poll, { timeout: 4000 }); else setTimeout(poll, 1200); };
      if (page === "chat.html") setTimeout(poll, 300);
      else if (document.readyState === "complete") setTimeout(idle, 1500); else window.addEventListener("load", function () { setTimeout(idle, 1500); }, { once: true });
    });
    setInterval(poll, 45000);
    // manager-1019: a quick hide/show (tab switch) re-polled every time - at most once per 30s now
    var lastVis = 0;
    document.addEventListener("visibilitychange", function () { if (!document.hidden && Date.now() - lastVis > 30000) { lastVis = Date.now(); poll(); } });
  }

  /* ---- mobile bottom tab bar (replaces mobile-nav.js's bar under shell B) ---- */
  function bottomBar(root, body) {
    if (document.getElementById("hbTabs")) return;
    var bar = el("nav", "hb-tabs"); bar.id = "hbTabs"; bar.setAttribute("aria-label", "Quick navigation"); bar.setAttribute("data-tour", "tabs");
    [["dashboard", "Home", "dashboard.html"], ["quotes", "Quotes", "quotes.html"], ["leads", "Leads", "leads.html"], ["chat", "Chat", "chat.html"]].forEach(function (x) {
      var a = el("a", "hb-tab"); a.href = abs(x[2]); a.setAttribute("data-key", x[0]);
      if (!ALWAYS_NAV[x[0]]) { a.hidden = true; can(x[0]).then(function (ok) { a.hidden = !ok; }); }
      a.appendChild(icon(x[0])); a.appendChild(el("span", null, x[1]));
      if (x[2] === page) { a.classList.add("on"); a.setAttribute("aria-current", "page"); }
      bar.appendChild(a);
    });
    var more = el("button", "hb-tab"); more.type = "button"; more.setAttribute("aria-label", "More: open menu"); more.setAttribute("data-tour", "tabs-more");
    more.appendChild(icon("menu")); more.appendChild(el("span", null, "More"));
    more.addEventListener("click", function (e) { e.stopPropagation(); root.classList.toggle("hb-drawer"); });
    bar.appendChild(more);
    body.appendChild(bar);
    /* the on-screen keyboard: hide the tab bar so it never sits over inputs */
    function field(t) { return !!(t && t.tagName && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable) && !/^(checkbox|radio|button|submit|range|color|file)$/i.test(t.type || "")); }
    var vv = window.visualViewport;
    function kb() { var open = !!(vv && window.innerHeight - vv.height > 150); if (!open && window.innerWidth < 820) open = field(document.activeElement); root.classList.toggle("hb-kb", open); }
    if (vv) vv.addEventListener("resize", kb);
    document.addEventListener("focusin", kb); document.addEventListener("focusout", function () { setTimeout(kb, 60); });
  }

  /* ---- keep the hover-expanded rail open while a popover inside it is open ---- */
  function watchPopovers(root) {
    var rail = document.getElementById("hbRail"); if (!rail || !window.MutationObserver) return;
    function check() {
      var open = false;
      try {
        var pops = rail.querySelectorAll(".hau-menu, .htr-pop");
        for (var i = 0; i < pops.length; i++) {
          var p = pops[i];
          if (!p.hidden && p.getAttribute("aria-hidden") !== "true" && getComputedStyle(p).display !== "none" && getComputedStyle(p).visibility !== "hidden") { open = true; if (p.classList.contains("htr-pop")) placePop(p); break; }
        }
      } catch (e) {}
      root.classList.toggle("hb-rail-hold", open);
    }
    /* Recently viewed: anchor the popover to its button (it moves between footer and nav), clamped inside the window */
    function placePop(p) {
      var btn = p.parentNode && p.parentNode.querySelector(".htr-btn"); if (!btn || window.innerWidth < 820) return;
      var r = btn.getBoundingClientRect(), h = Math.min(p.offsetHeight || 320, window.innerHeight - 16);
      var top = Math.max(8, Math.min(r.top, window.innerHeight - h - 8));
      if (p.style.getPropertyValue("top") !== top + "px") { p.style.setProperty("top", top + "px", "important"); p.style.setProperty("bottom", "auto", "important"); }
    }
    new MutationObserver(check).observe(rail, { subtree: true, attributes: true, attributeFilter: ["hidden", "class", "style", "aria-hidden", "open"], childList: true });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || !root.classList.contains("hb-rail-hold")) return;
      // the widgets own their close logic; nudge them with an outside click, then drop the hold
      try { document.body.dispatchEvent(new MouseEvent("click", { bubbles: true })); } catch (x) {}
      setTimeout(check, 50);
    });
  }
  function fillMore(manage, admin, done) {
    waitAuth(function () {
      var skip = { dashboard: 1, quotes: 1, leads: 1, calendar: 1, chat: 1, users: 1 }, seen = {};
      /* FLAG (Oct 2026, trial-data-v3): the "Templates" rail item is hidden for now. The page (templates.html) stays
       * reachable from its own links (Control Center, search, "Checklist template" quick action). Turn the rail item
       * back on with window.HELM_FLAGS = { navTemplates: true } before shell-b.js. */
      if (!(window.HELM_FLAGS && window.HELM_FLAGS.navTemplates === true)) skip.templates = 1;
      var areas = BPStore.auth.areas().filter(function (a) {
        if (!a || !a.page || skip[a.key] || seen[a.page]) return false; seen[a.page] = 1; return true;
      });
      Promise.all(areas.map(function (a) { return Promise.resolve(BPStore.auth.canView(a.key)).catch(function () { return false; }); }))
        .then(function (vis) {
          areas.forEach(function (a, i) {
            if (!vis[i] || document.querySelector('#hbRail .hb-group:not(.hb-fav) [data-key="' + a.key + '"]')) return;
            var isAdmin = a.group === "Admin" || a.key === "controls";
            var label = a.key === "controls" ? "Control Center" : a.label;
            (isAdmin ? admin : manage).appendChild(item(KEY_ICON[a.key] || "dot", label, a.page, a.key));
          });
          /* Business: the studio's money, moved off the client-facing dashboard (finance VIEW, same gate as dashboard_money) */
          Promise.resolve(BPStore.auth.canView("finance")).catch(function () { return false; }).then(function (fin) {
            if (fin && !document.querySelector('#hbRail .hb-group:not(.hb-fav) [data-key="business"]')) { /* planner-1023: the first item may sit inside an .hb-row wrapper — insert before the admin group's own child, never a grandchild (that threw and left Manage hidden) */
              var ref = admin.querySelector(".hb-item"); while (ref && ref.parentNode !== admin) ref = ref.parentNode;
              admin.insertBefore(item("business", "Business", "business.html", "business"), ref || null); }
            manage.hidden = !manage.querySelector(".hb-item");
            admin.hidden = !admin.querySelector(".hb-item");
            if (done) done();
          });
        });
    });
  }


  /* ---- Workspace items: dashboard always; the rest only when the role can view that area ---- */
  function gateWork(work) {
    Array.prototype.forEach.call(work.querySelectorAll("a.hb-item[data-key]"), function (a) {
      var k = a.getAttribute("data-key"); if (ALWAYS_NAV[k]) return;
      var row = a.parentNode && a.parentNode.classList.contains("hb-row") ? a.parentNode : a;
      row.hidden = true;
      waitAuth(function () { can(k).then(function (ok) { var r = a.parentNode && a.parentNode.classList.contains("hb-row") ? a.parentNode : a; r.hidden = !ok; if (ok) a.hidden = false; if (!ok) favDrop(k); }); });
    });
  }
  function favDrop(k) { try { var f = document.querySelector('#hbFavs [data-fkey="' + k + '"]'); if (f) f.hidden = true; } catch (e) {} }

  /* QA B4: is this studio on its free trial? The server's answer through trial-lock.js (my_trial_status status
     'trial' -> html.helm-trial), else the subscription itself, else start_trial()'s my_trial_org. false when unknown. */
  function trialKnown() {
    return Promise.resolve().then(function () {
      var L = window.HelmTrialLock;
      if (L && typeof L.whenKnown === "function") return L.whenKnown();
      var B = window.BPStore;
      if (B && B.subscription && typeof B.subscription.trial === "function")
        return Promise.resolve(B.subscription.trial()).then(function (t) { return !!(t && (t.status === "trial" || t.state === "trial")); });
      return B && B.trialOrg && B.trialOrg.inTrial ? B.trialOrg.inTrial() : document.documentElement.classList.contains("helm-trial");
    }).then(function (v) { return v === true; }, function () { return false; });
  }
  /* ---- Admin extras that have no area page: Insights, Reports, Audit log, Studio setup (same gates as their pages) ---- */
  function adminExtras(admin) {
    waitAuth(function () {
      var A = BPStore.auth;
      var role = Promise.resolve().then(function () { return typeof A.role === "function" ? A.role() : null; }).catch(function () { return null; });
      // 0177: no "Studio setup" for a free-trial studio (it uses the 2-step welcome); 0203: no Audit log either.
      // QA B4: "free trial" = the subscription's answer (trial-lock.js / html.helm-trial), not only a start_trial()
      // studio - a trial studio made another way showed Audit log + Studio setup. QA B23: no Reports (exports) either.
      var trial = trialKnown();
      Promise.all([role, can("controls"), can("insights"), trial]).then(function (r) {
        var rl = String(r[0] || ""), ctl = r[1], ins = r[2], inTrial = r[3] === true;
        var add = [
          [ins, "insights", "Insights", "insights.html", "insights"],
          [(ctl || /^(admin|manager|planner)$/.test(rl)) && !inTrial, "reports", "Reports", "reports.html", "reports"],   // QA B23: CSV / PDF exports only
          [(ctl || rl === "admin") && !inTrial, "audit", "Audit log", "audit.html", "audit"],   // 0203: no activity log in the free trial
          [ctl && !inTrial, "setup", "Studio setup", "onboarding.html", "setup"],
          [ctl && !!(window.HELM_FEATURES && window.HELM_FEATURES.integrationsPage === true), "integrations", "Integrations", "integrations.html", "integrations"]
        ];
        add.forEach(function (x) {
          if (!x[0] || admin.querySelector('[data-key="' + x[4] + '"]')) return;
          var a = item(x[1], x[2], x[3], x[4]); admin.appendChild(a); safe(function () { favInit_star(a); });
        });
        admin.hidden = !admin.querySelector(".hb-item");
        safe(favRender);
      });
    });
  }

  /* ---- profile menu: "Customize dashboard" (auth-ui rebuilds #hauMenu on every open, so re-add it after each rebuild) ---- */
  function customizeItem(slot) {
    function run() {
      var btn = document.getElementById("hauAccountBtn"), pop = document.getElementById("hauMenu");
      if (btn && pop && !pop.hidden) btn.click();   /* close the menu the same way the user would */
      if (page === "dashboard.html") window.dispatchEvent(new CustomEvent("hb:customize"));
      else location.href = abs("dashboard.html?customize=1");   /* same dashboard URL as the rail's Home item */
    }
    function add(pop) {
      if (pop.querySelector('[data-mi="hb-customize"]')) return;
      var mi = el("button", "hau-mi"); mi.type = "button"; mi.setAttribute("role", "menuitem"); mi.tabIndex = -1; mi.setAttribute("data-mi", "hb-customize");
      var ic = icon("sliders"); ic.setAttribute("class", "hb-svg hau-mi-ic"); mi.appendChild(ic); mi.appendChild(el("span", null, "Customize dashboard"));
      mi.addEventListener("click", run);
      var out = pop.querySelector('[data-mi="signout"]'), anchor = out && out.previousElementSibling && out.previousElementSibling.getAttribute("role") === "separator" ? out.previousElementSibling : out;
      pop.insertBefore(mi, anchor || null);
    }
    var seen = null;
    new MutationObserver(function () {
      var pop = document.getElementById("hauMenu"); if (!pop || !slot.contains(pop)) return;
      if (pop !== seen) { seen = pop; new MutationObserver(function () { if (pop.childNodes.length) add(pop); }).observe(pop, { childList: true }); }
      if (pop.childNodes.length) add(pop);
    }).observe(slot, { childList: true, subtree: true });
  }

  /* ---- rail profile: from the auth/profile APIs (pages render #account differently) ---- */
  function fillWho(nameEl, roleEl) {
    var B = window.BPStore, u = null;
    try { u = B && B.auth && typeof B.auth.user === "function" ? B.auth.user() : null; } catch (e) { u = null; }
    var w = document.querySelector("#account .who") || document.querySelector("#account span:not(.role)");
    nameEl.textContent = (u && u.email) || (w && w.textContent.trim()) || "Your account";
    var r = document.querySelector("#account .role"); roleEl.textContent = (r && r.textContent.trim()) || "";
    if (!B || !u) return;
    try { if (B.profile && typeof B.profile.mine === "function") Promise.resolve(B.profile.mine()).then(function (p) { var n = p && String(p.full_name || "").trim(); if (n) { nameEl.textContent = n; nameEl.title = u.email || ""; } }, function () {}); } catch (e) {}
    try { if (typeof B.auth.role === "function") Promise.resolve(B.auth.role()).then(function (x) { if (x) roleEl.textContent = String(x).charAt(0).toUpperCase() + String(x).slice(1); }, function () {}); } catch (e) {}
  }

  /* ---- header nav: hide only links the rail already has; keep page-specific ones (Builder, Event, Booklet, Design) ---- */
  var DUP = /^(dashboard|index|chat|control|quotes|leads|calendar|insights|reports|audit|onboarding|templates|staff|inventory|vendors|crm|nurture)\.html$/;
  function navTrim(header) {
    Array.prototype.forEach.call(header.querySelectorAll("nav.nav"), function (nav) {
      var keep = 0;
      Array.prototype.forEach.call(nav.querySelectorAll("a"), function (a) {
        var h = (a.getAttribute("href") || "").split(/[?#]/)[0].replace(/^\//, "").toLowerCase();
        if (DUP.test(h) || (h === "" && !a.id)) a.classList.add("hb-dup");
        else if (h + ".html" !== page && h !== page) keep++;
      });
      nav.classList.toggle("hb-navkeep", keep > 0);
    });
  }

  /* ---- New quote on the dashboard: the hidden #createBtn (or the same create flow if it is missing) ---- */
  var creating = false;
  function dashCreate() {
    if (creating) return; creating = true;
    var n = 0;
    (function poll() {
      var B = window.BPStore, u = null;
      try { u = B && B.auth && typeof B.auth.user === "function" ? B.auth.user() : null; } catch (e) { u = null; }
      if (!B || !B.auth || (B.auth.user && !u && n < 120)) { if (++n < 160) return void setTimeout(poll, 250); creating = false; return; }
      can("quotes", true).then(function (ok) {
        if (!ok) { creating = false; location.href = "/quotes.html"; return; }
        var b = document.getElementById("createBtn");
        if (b) { setTimeout(function () { creating = false; try { if (!b.hidden) b.click(); else location.href = "/quotes.html"; } catch (e) {} }, 400); return; }
        var Q = B.quotes, NQ = window.HelmNewQuote;
        /* audit 7: never create without the confirm dialog (no dialog on this page -> the Quotes list) */
        if (!Q || typeof Q.startBlank !== "function" || !NQ || typeof NQ.ask !== "function") { creating = false; location.href = "/quotes.html"; return; }
        Promise.resolve(NQ.ask({})).then(function (pick) {
          if (!pick) { creating = false; return; }
          var code = null; try { code = typeof Q.nextCode === "function" ? Q.nextCode([]) : null; } catch (e) { code = null; }
          Promise.resolve(Q.startBlank(code)).then(function (q) {
            if (!q || !q.id) throw new Error("no quote");
            var patch = {}; if (pick.title) patch.title = pick.title; else if (q.code && q.code !== q.title) patch.title = q.code;
            if (pick.eventType) patch.eventType = pick.eventType;
            var meta = (Object.keys(patch).length && typeof Q.updateMeta === "function") ? Promise.resolve(Q.updateMeta(q.id, patch)).catch(function () {}) : null;
            return Promise.resolve(meta).then(function () { var h = "flow.html?quote=" + encodeURIComponent(q.id); try { if (window.HelmUrl && HelmUrl.upgrade) h = HelmUrl.upgrade(h); } catch (e) {} location.href = h.charAt(0) === "/" ? h : "/" + h; });
          }).catch(function () { creating = false; try { if (window.BPUI && BPUI.toast) BPUI.toast("Could not start a quote. Try again.", { type: "err" }); } catch (e) {} });
        });
      });
    })();
  }

  /* ---- bell on every page: pages without span#bell get one, mounted once auth is ready ---- */
  function autoBell(slot) {
    var span = el("span"); span.id = "bell"; slot.appendChild(span);
    var n = 0;
    (function poll() {
      try {
        if (document.getElementById("bpBellBtn")) return;   // someone else mounted it
        var B = window.BPStore, u = null;
        try { u = B && B.auth && typeof B.auth.user === "function" ? B.auth.user() : null; } catch (e) { u = null; }
        if (u && B.bell && typeof B.bell.mount === "function") { Promise.resolve(B.bell.mount(span)).catch(function () {}); return; }
      } catch (e) {}
      if (++n < 80) setTimeout(poll, 250);
    })();
  }

  /* ---- search palette (mobile icon + shortcuts) ---- */
  function openSearch() {
    var S = window.HelmStudioSearch;
    if (S && typeof S.open === "function") { S.open(); return; }
    var t = document.getElementById("hssTrigger") || document.querySelector(".hss-trig"); if (t) t.click();
  }

  /* la-1018: ONE "not contacted yet" rule, shared with the dashboard (Follow-ups, Needs attention, New leads tile):
     the lead is still in "New" and has not been turned into a quote. */
  window.HelmLeadRules = window.HelmLeadRules || { uncontacted: function (l) { return !!l && String(l.status || "new") === "new" && !l.quote_id; } };

  /* ---- sidebar count badges (dot when collapsed, pill when expanded) ---- */
  var CNT_KEY = "helm.shellb.counts";
  function readCounts() { try { var v = JSON.parse(sessionStorage.getItem(CNT_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; } }
  function railCount(key, n) {
    try {
      n = Math.max(0, Number(n) || 0);
      var c = readCounts(); c[key] = n; try { sessionStorage.setItem(CNT_KEY, JSON.stringify(c)); } catch (e) {}
      var nodes = document.querySelectorAll('#hbRail [data-key="' + key + '"] .hb-cnt, #hbRail [data-fkey="' + key + '"] .hb-cnt');
      Array.prototype.forEach.call(nodes, function (b) {
        b.hidden = !n; b.textContent = n > 9 ? "9+" : n ? String(n) : "";
        var a = b.parentNode, base = a.getAttribute("data-label") || a.getAttribute("aria-label") || "";
        if (!a.getAttribute("data-label")) a.setAttribute("data-label", base);
        var why = key === "chat" ? (n === 1 ? "1 unread message" : n + " unread messages")
          : key === "leads" ? (n === 1 ? "1 new lead not yet contacted" : n + " new leads not yet contacted")
          : (n === 1 ? "1 quote sent, waiting for client approval" : n + " quotes sent, waiting for client approval");
        b.title = n ? why : ""; a.removeAttribute("title");
        a.setAttribute("aria-label", n ? base + ", " + why : base);
      });
    } catch (e) {}
  }
  function railCounts() {
    var c = readCounts(); Object.keys(c).forEach(function (k) { if (COUNT_KEYS[k]) railCount(k, c[k]); });
    var busy = false;
    function run() {
      if (busy || document.hidden) return;
      var B = window.BPStore; if (!B) return;
      try { if (B.auth && typeof B.auth.user === "function" && !B.auth.user()) return; } catch (e) { return; }
      busy = true;
      var jobs = [];
      if (B.leads && typeof B.leads.list === "function") jobs.push(can("leads").then(function (ok) {
        if (!ok) return railCount("leads", 0);
        // la-fetch (audit 25): a HEAD count when the store has one - no lead rows downloaded for a badge
        if (typeof B.leads.countNew === "function") return Promise.resolve(B.leads.countNew()).then(function (n) { railCount("leads", n); });
        return Promise.resolve(B.leads.list()).then(function (rows) {
          railCount("leads", (Array.isArray(rows) ? rows : []).filter(window.HelmLeadRules.uncontacted).length);
        });
      }).catch(function () {}));
      if (B.quotes && typeof B.quotes.list === "function") jobs.push(can("quotes").then(function (ok) {
        if (!ok) return railCount("quotes", 0);
        if (typeof B.quotes.countAwaiting === "function") return Promise.resolve(B.quotes.countAwaiting()).then(function (n) { railCount("quotes", n); });
        return Promise.resolve(B.quotes.list()).then(function (rows) {
          railCount("quotes", (Array.isArray(rows) ? rows : []).filter(function (q) { return q && q.status === "quote" && (q.approvalStatus === "sent" || q.approvalStatus === "viewed"); }).length);
        });
      }).catch(function () {}));
      Promise.all(jobs).then(function () { busy = false; }, function () { busy = false; });
    }
    waitAuth(function () { setTimeout(run, 1500); });
    setInterval(run, 60000);
    var lastVisRun = 0;   // manager-1019: same 30s cap for the rail counts on tab show
    document.addEventListener("visibilitychange", function () { if (!document.hidden && Date.now() - lastVisRun > 30000) { lastVisRun = Date.now(); run(); } });
  }

  /* ---- favourites: "Pinned" group at the top of the rail ---- */
  var FAV_KEY = "helm.shellb.favs";
  function favList() { try { var v = JSON.parse(ls(FAV_KEY) || "[]"); return Array.isArray(v) ? v.filter(function (x) { return typeof x === "string"; }) : []; } catch (e) { return []; } }
  function favInit_star(a) {
    var key = a.getAttribute("data-key"); if (!key || a.parentNode.classList.contains("hb-row")) return;
    var row = el("div", "hb-row"); a.parentNode.insertBefore(row, a); row.appendChild(a);
    var st = el("button", "hb-star"); st.type = "button"; st.setAttribute("data-star", key); st.appendChild(icon("star"));
    st.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      var l = favList(), i = l.indexOf(key);
      if (i === -1) l.push(key); else l.splice(i, 1);
      ls(FAV_KEY, l.length ? JSON.stringify(l) : null);
      favRender();
    });
    row.appendChild(st);
  }
  var favBox = null;
  function favRender() {
    if (!favBox) return;
    var l = favList();
    Array.prototype.forEach.call(document.querySelectorAll("#hbRail .hb-star"), function (st) {
      var k = st.getAttribute("data-star"), on = l.indexOf(k) !== -1, lb = (REG[k] && REG[k][1]) || k;
      st.setAttribute("aria-pressed", on ? "true" : "false");
      st.setAttribute("aria-label", (on ? "Unpin " : "Pin ") + lb); st.title = on ? "Remove from Pinned" : "Add to Pinned";
    });
    Array.prototype.slice.call(favBox.querySelectorAll(".hb-item")).forEach(function (n) { favBox.removeChild(n); });
    l.forEach(function (k) {
      var r = REG[k]; if (!r) return;
      var a = item(r[0], r[1], r[2], null);
      a.setAttribute("data-fkey", k);
      if (COUNT_KEYS[k]) { var c = el("span", "hb-cnt"); c.hidden = true; c.setAttribute("aria-hidden", "true"); a.appendChild(c); }
      favBox.appendChild(a);
    });
    favBox.hidden = !favBox.querySelector(".hb-item");
    var c = readCounts(); Object.keys(c).forEach(function (k) { if (COUNT_KEYS[k]) railCount(k, c[k]); });
  }
  function favsInit(box, groups) {
    favBox = box;
    groups.forEach(function (g) { Array.prototype.forEach.call(g.querySelectorAll("a.hb-item[data-key]"), favInit_star); });
    favRender();
  }

  /* ---- keyboard shortcuts: G then D/Q/L/C/M, N new, ? help ---- */
  var GO = { d: ["dashboard.html", "Dashboard"], q: ["quotes.html", "Quotes"], l: ["leads.html", "Leads"], c: ["calendar.html", "Calendar"], m: ["chat.html", "Messages (chat)"], b: ["business.html", "Business (money)"] };
  function modalOpen() {
    try {
      if (document.querySelector(".hss-ov, .bpui-overlay, .hb-help:not([hidden])")) return true;
      return Array.prototype.some.call(document.querySelectorAll("[aria-modal='true'], dialog[open]"), function (m) { return !!m.offsetParent || m.getClientRects().length > 0; });
    } catch (e) { return false; }
  }
  function typing(t) {
    if (!t || !t.tagName) return false;
    var tag = t.tagName; return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || !!t.isContentEditable;
  }
  var helpEl = null, helpPrev = null;
  var MAC = /Mac|iPhone|iPad/.test(navigator.platform || ""), MOD = MAC ? "⌘" : "Ctrl";
  function helpGroups() {
    var go = Object.keys(GO).map(function (k) { return ["G " + k.toUpperCase(), "Go to " + GO[k][1]]; });
    return [
      ["Search", [[MOD + " K", "Open search and commands"], ["/", "Open search (when not typing)"]]],
      ["Navigate", go],
      ["Create", [["N", "New quote / create menu"]]],
      ["General", [["?", "Show keyboard shortcuts"], ["Esc", "Close dialogs and menus"]]]
    ];
  }
  function helpSheet() {
    if (helpEl) return helpEl;
    var ov = el("div", "hb-help"); ov.hidden = true;
    var dlg = el("div", "hb-help-dlg"); dlg.setAttribute("role", "dialog"); dlg.setAttribute("aria-modal", "true"); dlg.setAttribute("aria-labelledby", "hbHelpT"); dlg.tabIndex = -1;
    var hd = el("div", "hb-help-hd"); var h = el("h2", null, "Keyboard shortcuts"); h.id = "hbHelpT"; hd.appendChild(h);
    var x = el("button", "hb-ibtn hb-help-x", "✕"); x.type = "button"; x.setAttribute("aria-label", "Close shortcuts"); x.addEventListener("click", helpClose); hd.appendChild(x);
    dlg.appendChild(hd);
    var q = el("input", "hb-help-q"); q.type = "search"; q.placeholder = "Filter shortcuts…"; q.setAttribute("aria-label", "Filter shortcuts"); q.autocomplete = "off";
    dlg.appendChild(q);
    var body = el("div", "hb-help-body"), rows = [], secs = [];
    helpGroups().forEach(function (g) {
      var sec = el("section", "hb-help-sec"); var gh = el("h3", "hb-help-gh", g[0]); sec.appendChild(gh);
      var dl = el("dl", "hb-help-list");
      g[1].forEach(function (r) {
        var row = el("div", "hb-help-row"), dt = el("dt");
        r[0].split(" ").forEach(function (k, i) { if (i && r[0].charAt(0) === "G") dt.appendChild(el("span", "hb-help-then", "then")); dt.appendChild(el("kbd", null, k)); });
        row.appendChild(el("dd", null, r[1])); row.appendChild(dt); dl.appendChild(row);
        rows.push({ n: row, t: (r[0] + " " + r[1] + " " + g[0]).toLowerCase(), s: sec });
      });
      sec.appendChild(dl); body.appendChild(sec); secs.push(sec);
    });
    var none = el("p", "hb-help-none", "No shortcut matches."); none.hidden = true; body.appendChild(none);
    dlg.appendChild(body);
    q.addEventListener("input", function () {
      var v = q.value.trim().toLowerCase(), any = false;
      rows.forEach(function (r) { r.n.hidden = !!v && r.t.indexOf(v) === -1; });
      secs.forEach(function (s) { var vis = Array.prototype.some.call(s.querySelectorAll(".hb-help-row"), function (n) { return !n.hidden; }); s.hidden = !vis; if (vis) any = true; });
      none.hidden = any;
    });
    var ft = el("p", "hb-help-ft"); ft.appendChild(document.createTextNode("Press ")); ft.appendChild(el("kbd", null, "?")); ft.appendChild(document.createTextNode(" anywhere to open this sheet."));
    dlg.appendChild(ft);
    ov.appendChild(dlg);
    ov.addEventListener("click", function (e) { if (e.target === ov) helpClose(); });
    dlg.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (q.value) { q.value = ""; q.dispatchEvent(new Event("input")); } else helpClose(); }
      else if (e.key === "Tab") { e.preventDefault(); (document.activeElement === q ? x : q).focus(); }
    });
    document.body.appendChild(ov); helpEl = ov; return ov;
  }
  function helpOpen() { var ov = helpSheet(); helpPrev = document.activeElement; ov.hidden = false; var q = ov.querySelector(".hb-help-q"); if (q) { q.value = ""; q.dispatchEvent(new Event("input")); q.focus(); } }
  function helpClose() { if (!helpEl || helpEl.hidden) return; helpEl.hidden = true; try { if (helpPrev && helpPrev.focus) helpPrev.focus(); } catch (e) {} }
  try { window.HelmShortcuts = { open: function () { safe(helpOpen); }, close: helpClose }; } catch (e) {}
  function shortcuts() {
    var gAt = 0;
    document.addEventListener("keydown", function (e) {
      try {
        if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
        if (typing(e.target) || modalOpen()) { gAt = 0; return; }
        var k = (e.key || "").toLowerCase();
        if (gAt && Date.now() - gAt < 1500) {
          gAt = 0;
          if (GO[k]) { e.preventDefault(); if (GO[k][0] !== page) location.href = abs(GO[k][0]); }
          return;
        }
        gAt = 0;
        if (k === "g" && !e.shiftKey) { gAt = Date.now(); return; }
        if (e.key === "?") { e.preventDefault(); helpOpen(); return; }
        if (k === "n" && !e.shiftKey) {
          var chev = document.querySelector(".hb-split:not([hidden]) .hb-chev"), nq = document.querySelector(".hb-split:not([hidden]) .hb-new:not(.hb-chev):not([hidden])");
          if (chev) { e.preventDefault(); chev.click(); } else if (nq) { e.preventDefault(); nq.click(); }
        }
      } catch (x) {}
    });
  }

  /* add-on modules (built in parallel): global monochrome style, dashboard, skeletons, search */
  (function addons() {
    if (window.HELM_SHELL_ADDONS) return;   /* shell-proto.js already injected these in parallel */
    var v = window.HELM_SHELL_V || "1";
    function css(f) { var l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/" + f + "?v=" + v; document.head.appendChild(l); }
    function js(f) { var s = document.createElement("script"); s.src = "/" + f + "?v=" + v; s.defer = true; document.head.appendChild(s); }
    css("shell-b-style.css"); js("shell-b-style.js");
    js("shell-b-search.js");
    if (page === "dashboard.html") { css("shell-b-dash.css"); js("shell-b-dash.js"); }
  })();
  function boot() { safe(build); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
/* tour: dashboard tour targets [data-nav=*]; hidden #modnav pills must not win over rail items */
(function () {
  function strip() {
    var n = document.querySelectorAll("#modnav [data-nav]");
    for (var i = 0; i < n.length; i++) { n[i].setAttribute("data-modnav", n[i].getAttribute("data-nav")); n[i].removeAttribute("data-nav"); }
  }
  /* close the notifications panel when the search overlay opens (no stacked popovers) */
  try {
    new MutationObserver(function (ms) {
      for (var i = 0; i < ms.length; i++) for (var j = 0; j < ms[i].addedNodes.length; j++) {
        var nd = ms[i].addedNodes[j];
        if (nd.nodeType === 1 && nd.classList && nd.classList.contains("hss-ov")) {
          var bb = document.getElementById("bpBellBtn");
          if (bb && bb.getAttribute("aria-expanded") === "true") bb.click();
          return;
        }
      }
    }).observe(document.body || document.documentElement, { childList: true });
  } catch (e) {}
  strip();
  try { new MutationObserver(strip).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
})();
