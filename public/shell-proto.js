/* shell-proto.js - loads the app layout (shell-b.*) on signed-in studio app pages. No switcher: this is THE layout.
 * Gate: store-api.js line ~2 injects this file on every host. */
(function () {
  "use strict";
  var KEY = "helm.shell";
  try { localStorage.removeItem(KEY); } catch (e) {}   /* the old "off" escape is gone: clear it so nobody stays stuck on the old header */
  var v = "b";   /* the new layout is THE layout (no switcher, no ?shell=off) */
  /* ALLOWLIST: the new layout only runs on signed-in studio app pages. Marketing, public/client links, the crew task page,
   * HQ console, booklet, checkout/sim-pay, onboarding, auth pages, 2D builder and floor plan keep their own layout. */
  var APP = { audit: 1, budget: 1, business: 1, calendar: 1, chat: 1, client: 1, closure: 1, command: 1, control: 1, crm: 1, dashboard: 1, design: 1,
    discovery: 1, event: 1, flow: 1, insights: 1, integrations: 1, inventory: 1, "invite-studio": 1, issues: 1, leads: 1, logistics: 1, media: 1, nurture: 1,
    ops: 1, plan: 1, proposal: 1, quotes: 1, ready: 1, reports: 1, resources: 1, runsheet: 1, settlement: 1, staff: 1, teardown: 1,
    templates: 1, vendors: 1 };
  var PRETTY = { dashboard: "dashboard", quotes: "quotes", leads: "leads", chat: "chat", settings: "control", events: "event", clients: "client" };
  function appPage(path) {
    path = String(path || "");
    var m = /^\/[a-z0-9-]{3,40}\/(dashboard|quotes|leads|chat|settings|events|clients|booklet)(?:\/([^/?#]{1,160})(?:\/(floor-plan|tasks))?)?\/?$/.exec(path);
    if (m) { if (m[3] === "floor-plan") return null; if (m[3] === "tasks") return "ops"; return PRETTY[m[1]] || null; }   /* studio pretty URLs (booklet -> null) */
    var last = (path.split("/").pop() || "").toLowerCase().replace(/\.html$/, "");
    return APP[last] ? last : null;
  }
  if (!appPage(location.pathname)) return;
  /* The dashboard is a single design (shell-b-dash.*). Demos 2-7 were retired 2026-10-13 (archived outside the repo). */
  var dv = "1";
  try { localStorage.removeItem("helm.dash.v"); } catch (e) {}
  {
    /* SHELL_V: bump this whenever any shell-* file changes, so browsers refetch (was Date.now(), which defeated caching) */
    var SHELL_V = "130", root = document.documentElement, head = document.head;
    window.HELM_SHELL_V = SHELL_V;
    root.setAttribute("data-shell", v);
    /* 0181 free trial: a studio last seen in its trial is locked before first paint (cached flag, same as trial-early.js);
       trial-lock.js asks the server and takes it off again for a paid studio */
    try { if (localStorage.getItem("helm.trial") === "1") {
      if (!root.classList.contains("helm-trial")) { root.classList.add("helm-trial"); root.classList.add("helm-trial-early"); }
      if (!document.getElementById("trialLockCss")) { var tl = document.createElement("link"); tl.id = "trialLockCss"; tl.rel = "stylesheet"; tl.href = "/trial-lock.css?v=7"; if (!document.body) tl.setAttribute("blocking", "render"); head.appendChild(tl); } } } catch (e) {}
    var th = null; try {
      th = localStorage.getItem("helm.shellb.theme");
      /* one-time move to the new default (Oct 2026): a device still on the OLD default (cobalt / nothing saved) starts on emerald */
      if (localStorage.getItem("helm.theme.v") !== "2") { if (!th || th === "cobalt") { th = "emerald"; localStorage.setItem("helm.shellb.theme", th); } localStorage.setItem("helm.theme.v", "2"); }
    } catch (e) {}
    root.setAttribute("data-hb-theme", /^(cobalt|midnight|emerald|graphite|studio)$/.test(th || "") ? th : "emerald");   /* theme before first paint; default = EMERALD (light) */
    if (window.HELM_DARK_MODE !== true) { root.setAttribute("data-theme", "light"); root.classList.add("hb-nodark"); }   /* dark mode off: always light (store-api.js light lock) */
    try { if (localStorage.getItem("helm.shellb.pin") === "1") root.classList.add("hb-pinned"); } catch (e) {}   /* reserve the right rail width up-front */
    try { if (sessionStorage.getItem("helm.priv.state") !== "shown") root.classList.add("hb-priv-on"); } catch (e) { root.classList.add("hb-priv-on"); }   /* privacy mode: amounts hidden before first paint (default) */
    var page = appPage(location.pathname) + ".html";
    /* HEAD MODE (flash fix): app pages now load this file synchronously in <head>, so data-shell/theme are set and the
       shell stylesheets are requested BEFORE first paint (blocking=render: the browser does not paint the page's legacy
       inline styles - the old violet accent/background - while they load). Shell scripts still run after the page's own
       scripts (same order as when store-api.js injected this file): preloaded now, executed at DOMContentLoaded. */
    var early = !document.body;
    function css(f) { var l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/" + f + "?v=" + SHELL_V; if (early) l.setAttribute("blocking", "render"); head.appendChild(l); }
    var jsq = [];
    function addJs(src) { var s = document.createElement("script"); s.src = src; s.async = false; head.appendChild(s); }   /* async=false: fetched in parallel, executed in insertion order */
    function js(f) { var src = "/" + f + "?v=" + SHELL_V; if (!early) return addJs(src); var p = document.createElement("link"); p.rel = "preload"; p.as = "script"; p.href = src; head.appendChild(p); jsq.push(src); }
    css("shell-" + v + "-boot.css"); css("shell-b-loader.css");   /* critical: no old-header flash, no rail layout shift */
    css("shell-" + v + ".css"); css("shell-b-pages.css"); css("shell-b-style.css"); var sc = document.createElement("link"); sc.id = "hsb-css"; sc.rel = "stylesheet"; sc.href = "/shell-b-search.css?v=" + SHELL_V; head.appendChild(sc);   /* id matches shell-b-search.js so it is not added twice */
    css("shell-b-privacy.css");
    if (page === "dashboard.html") { root.setAttribute("data-dash", dv); css("shell-b-dash.css"); }
    /* shared ui-kit + mobile tables: optional; onerror drops the node so a missing file never breaks a page */
    function optCss(f) { var l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/" + f + "?v=" + SHELL_V; l.onerror = function () { try { l.remove(); } catch (e) {} }; head.appendChild(l); }
    optCss("ui-kit.css"); optCss("tables-mobile.css");
    css("shell-b-theme-studio.css");   /* both always loaded (scoped by data-hb-theme) so switching never flashes; last: wins ties */
    js("shell-b-privacy.js");   /* first: its observer must see the page's content as it renders */
    js("shell-" + v + ".js"); js("shell-b-style.js"); js("shell-b-search.js");
    if (page === "dashboard.html") { js("shell-b-money.js"); js("shell-b-dash.js"); }
    if (early) document.addEventListener("DOMContentLoaded", function () { jsq.forEach(addJs); });
    ["ui-kit.js", "tables-mobile.js"].forEach(function (f) { var s = document.createElement("script"); s.src = "/" + f + "?v=" + SHELL_V; s.async = true; s.onerror = function () { try { s.remove(); } catch (e) {} }; head.appendChild(s); });   /* optional, independent of the shell chain */

    window.HELM_SHELL_ADDONS = true;   /* tells shell-b.js addons() everything is already requested */
    setTimeout(function () { root.classList.add("hb-ready"); root.classList.add("hb-loaded"); }, 2500);   /* safety: unhide old header if shell JS failed */
    /* Blueprint loader (#hb-ld, styled in shell-b-loader.css). HB_MARK = the Helm mark paths (viewBox 0 0 48 48, same as
       shell-b-loader-mark.svg) - swap here to change the mark. Built with createElementNS (no innerHTML: CSP/injection-safe). */
    var HB_MARK = ["M13 12H19.5V21.5H28.5V12H35V36H28.5V26.5H19.5V36H13Z", "M24 1.8L26.5 16.6 24 19.2 21.5 16.6ZM24 46.2L26.5 31.4 24 28.8 21.5 31.4ZM1.8 24L9.6 21.5 11 24 9.6 26.5Z"];
    (function () {
      var NS = "http://www.w3.org/2000/svg", d = document.createElement("div"), st = document.createElement("div");
      function el(n, a, p) { var e = document.createElementNS(NS, n); for (var k in a) e.setAttribute(k, a[k]); if (p) p.appendChild(e); return e; }
      d.id = "hb-ld"; d.setAttribute("aria-hidden", "true"); st.className = "hbl-stage"; d.appendChild(st);
      var s = el("svg", { viewBox: "-12 -12 72 72", focusable: "false" }, st), g = el("g", { "class": "hbl-grid" }, s);
      for (var i = -12; i <= 60; i += 6) { el("line", { x1: i, y1: -12, x2: i, y2: 60 }, g); el("line", { x1: -12, y1: i, x2: 60, y2: i }, g); }
      el("path", { "class": "hbl-dim", pathLength: 1, d: "M6 52v4M42 52v4M6 54h36M52 3h4M52 45h4M54 3v42" }, s);
      el("path", { "class": "hbl-mark", pathLength: 1, "stroke-width": 2, "stroke-linejoin": "round", d: HB_MARK[0] }, s);
      el("path", { "class": "hbl-mark", pathLength: 1, "stroke-width": 2, "stroke-linejoin": "round", d: HB_MARK[1] }, s);
      root.appendChild(d);
    })();
    function hbLoaded() { requestAnimationFrame(function () { root.classList.add("hb-loaded"); }); setTimeout(function () { root.classList.add("hb-settled"); }, 900); }   /* v86: entrance plays once; cards revealed later (auth/data) appear without re-animating = no flicker */   /* loader off + entrance as soon as page + shell scripts are in; no artificial wait */
    if (document.readyState === "complete") hbLoaded(); else window.addEventListener("load", hbLoaded);   /* shell scripts executed; data loads behind .sb-skel shimmer */
  }
})();
