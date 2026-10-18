/* 404 helper: a signed-in user who opens the bare studio link (/<slug>) is sent to that studio's
   dashboard, the same place the root URL goes. Signed-out visitors and any other unknown URL keep
   the normal 404 page. The dashboard itself still checks the user belongs to that studio.
   la-1018: an app page opened UNDER a studio path that has no pretty route of its own
   (/<slug>/event.html?id=…, /<slug>/ops.html?quote=… - a relative link followed from a studio page)
   goes to that page with its query (/event?id=…), which then upgrades its own links. Known pages only,
   so a typo never bounces between 404s. */
(function () {
  "use strict";
  var PAGES = /^(dashboard|quotes|leads|chat|control|event|builder|ops|client|booklet|flow|settlement|budget|closure|runsheet|resources|logistics|teardown|command|ready|issues|inventory|staff|vendors|calendar|crm|nurture|reports|insights|business|audit|templates|onboarding)$/;
  try {
    var path = location.pathname || "";
    var m = /^\/([a-z0-9-]{2,63})\/?$/.exec(path), p = /^\/([a-z0-9-]{2,63})\/([a-z]{2,20})(?:\.html)?\/?$/.exec(path);
    if (!m && !(p && PAGES.test(p[2]))) return;
    var signedIn = false;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i) || "";
      if (/^sb-.+-auth-token$/.test(k) && localStorage.getItem(k)) { signedIn = true; break; }
    }
    if (!signedIn) return;
    if (m) location.replace("/" + m[1] + "/dashboard" + (location.search || "") + (location.hash || ""));
    else location.replace("/" + p[2] + (location.search || "") + (location.hash || ""));
  } catch (e) { /* storage blocked: keep the 404 page */ }
})();
