/* dash-prompts.js - dashboard: show at most ONE setup-style prompt at a time.
 * Priority: demo-data card (#tdCard) -> studio setup nudge (#obNudge) -> two-step (MFA) note (#hauMfaNudge).
 * Lower-priority prompts are only deferred with a class (never removed, never touch their own hidden state),
 * so they re-appear as soon as the higher one goes away. DOM APIs only. */
(function () {
  "use strict";
  var ORDER = ["tdCard", "obNudge", "hauMfaNudge"];
  function apply() {
    var taken = false;
    ORDER.forEach(function (id) {
      var n = document.getElementById(id); if (!n) return;
      var vis = !n.hidden && (n.childNodes.length > 0 || id === "hauMfaNudge");
      if (taken && vis) n.classList.add("dp-defer"); else n.classList.remove("dp-defer");
      if (vis) taken = true;
    });
  }
  var q = false;
  function later() { if (q) return; q = true; setTimeout(function () { q = false; try { apply(); } catch (e) {} }, 50); }
  function boot() {
    try { apply(); } catch (e) {}
    if (!window.MutationObserver || !document.body) return;
    new MutationObserver(later).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
