/* builder-back.js - full-screen tools (2D/3D builder, floor plan) keep their own full-screen layout (no sidebar)
 * but get a clear "Back to event" link in the header. No inline handlers; CSP-safe. */
(function () {
  "use strict";
  function backUrl(loc) {
    var p = String(loc.pathname || "");
    var m = /^\/([a-z0-9-]{3,40})\/events\/([^/?#]{1,160})\/floor-plan\/?$/.exec(p);
    if (m) return "/" + m[1] + "/events/" + m[2];
    var q = null; try { q = new URLSearchParams(loc.search).get("quote"); } catch (e) {}
    if (q && /^[A-Za-z0-9_-]{1,80}$/.test(q)) return "event.html?id=" + encodeURIComponent(q);
    return null;
  }
  if (typeof module !== "undefined" && module.exports) { module.exports = { backUrl: backUrl }; return; }
  function apply() {
    var a = document.querySelector("header .brand"); if (!a) return;
    var u = backUrl(location); if (!u) return;
    a.setAttribute("href", u); a.setAttribute("title", "Back to this event");
    var s = a.querySelector(".brand-txt small"); if (s) s.textContent = "← Back to event";
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply); else apply();
})();
