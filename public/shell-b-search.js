/* HELM shell-b search add-on: extends the existing Cmd/Ctrl+K palette (studio-search.js,
   window.HelmStudioSearch) instead of replacing it. Adds Templates + run-actions
   (dark mode, tour) to its shared ACTIONS registry, and full-screen mobile sheet CSS.
   Read-only: never writes data. Run-actions use a same-page hash (#hsb-act-*) that
   the palette's own choose() navigates to; we catch hashchange and click the button. */
(function () {
  "use strict";
  var doc = document;
  var EXTRA = [
    { id: "go-business", label: "Go to Business", icon: "\u{1F4BC}", href: "/business.html", need: [["view", "finance"]], kw: "money revenue collected outstanding payments finance" },
    { id: "go-reports", label: "Go to reports", icon: "\u{1F4C8}", href: "/reports.html", need: [["view", "controls"]], kw: "revenue export summary" },
    { id: "go-audit", label: "Open audit log", icon: "\u{1F6E1}", href: "/audit.html", need: [["view", "controls"]], kw: "history changes log security" },
    { id: "go-insights-b", label: "Go to insights", icon: "\u{1F4CA}", href: "/insights.html", need: [["view", "insights"]], kw: "analytics trends" },
    { id: "go-setup", label: "Studio setup", icon: "\u2699", href: "/onboarding.html", need: [["view", "controls"]], kw: "onboarding import configure" },
    { id: "go-templates", label: "Go to templates", icon: "\u{1F4C4}", href: "/templates.html", need: [["view", "templates"]], kw: "proposal layouts" },
    /* dark mode is off for now (window.HELM_DARK_MODE !== true): this action opens the colour theme picker instead */
    window.HELM_DARK_MODE === true
      ? { id: "hsb-theme", label: "Toggle dark mode", icon: "\u{1F313}", href: "#hsb-act-theme", need: [], kw: "theme light night appearance", run: "bpThemeToggle" }
      : { id: "hsb-theme", label: "Change colour theme", icon: "\u{1F3A8}", href: "#hsb-act-theme", need: [], kw: "theme colour color appearance emerald graphite", run: "hbThemePick" },
    { id: "hsb-tour", label: "Take the tour", icon: "❓", href: "#hsb-act-tour", need: [], kw: "help guide onboarding", run: "helpBtn" }
  ];
  var RUN = { "#hsb-act-theme": window.HELM_DARK_MODE === true ? "bpThemeToggle" : "hbThemePick", "#hsb-act-tour": "helpBtn" };

  function btn(id) { return doc.getElementById(id) || (id === "helpBtn" ? doc.querySelector(".htour-fab") : null); }   /* some pages only have the tour pill */
  function css() {
    try {
      if (doc.getElementById("hsb-css")) return;
      var l = doc.createElement("link"); l.id = "hsb-css"; l.rel = "stylesheet"; l.href = "/shell-b-search.css?v=" + (window.HELM_SHELL_V || "1");
      doc.head.appendChild(l);
    } catch (e) {}
  }
  // free trial (0181): Templates and Studio setup are not part of the trial - keep them out of the palette;
  // QA B5: nor the activity log ("Open audit log") or Reports & exports (CSV / PDF only)
  var TRIAL_OUT = /^\/?(templates|onboarding|audit|reports)(\.html)?([?#].*)?$/;
  function trialOn() { return doc.documentElement.classList.contains("helm-trial"); }
  function prune() {
    var api = window.HelmStudioSearch;
    if (!trialOn() || !api || !Array.isArray(api.ACTIONS)) return;
    for (var i = api.ACTIONS.length - 1; i >= 0; i--) { var x = api.ACTIONS[i]; if (x && x.href && TRIAL_OUT.test(x.href)) api.ACTIONS.splice(i, 1); }
  }
  window.addEventListener("helm:trial", prune);
  function extend() {
    var api = window.HelmStudioSearch;
    if (!api || !Array.isArray(api.ACTIONS)) return false;
    try {
      EXTRA.forEach(function (a) {
        if (trialOn() && a.href && TRIAL_OUT.test(a.href)) return;   // free trial: no Templates / Studio setup
        if (a.run && !btn(a.run)) return;        // button not on this page
        // pages with <base href="/"> resolve a bare "#hash" to "/#hash" (a full reload to the home page): pin it to this page
        if (a.run) a.href = location.pathname + location.search + "#" + a.href.split("#")[1];
        if (a.href.indexOf("/") === 0 && !a.run && api.ACTIONS.some(function (x) { return x.href && x.href.replace(/^\//, "") === a.href.slice(1); })) return;   // palette already has it
        if (!api.ACTIONS.some(function (x) { return x.id === a.id; })) api.ACTIONS.push(a);
      });
      prune();
    } catch (e) {}
    return true;
  }
  function onHash() {
    try {
      var id = RUN[location.hash]; if (!id) return;
      history.replaceState(null, "", location.pathname + location.search);
      var b = btn(id);
      if (b) setTimeout(function () { try { b.click(); } catch (e) {} }, 30);
    } catch (e) {}
  }
  window.addEventListener("hashchange", onHash);
  css();
  var tries = 0;
  (function go() { if (!extend() && tries++ < 40) setTimeout(go, 250); else setTimeout(extend, 1500); })();
})();
