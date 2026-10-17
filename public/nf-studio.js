/* 404 helper: a signed-in user who opens the bare studio link (/<slug>) is sent to that studio's
   dashboard, the same place the root URL goes. Signed-out visitors and any other unknown URL keep
   the normal 404 page. The dashboard itself still checks the user belongs to that studio. */
(function () {
  "use strict";
  try {
    var m = /^\/([a-z0-9-]{2,63})\/?$/.exec(location.pathname || "");
    if (!m) return;
    var signedIn = false;
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i) || "";
      if (/^sb-.+-auth-token$/.test(k) && localStorage.getItem(k)) { signedIn = true; break; }
    }
    if (signedIn) location.replace("/" + m[1] + "/dashboard" + (location.search || "") + (location.hash || ""));
  } catch (e) { /* storage blocked: keep the 404 page */ }
})();
