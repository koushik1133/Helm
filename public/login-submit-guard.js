/* login-submit-guard.js - r84: until login.html's page script has attached its submit handlers (they attach at
   DOMContentLoaded, after the deferred app scripts), a click on "Sign in" would do a NATIVE form submit: the page
   reloads (the e-mail + password land in the URL) and what was typed is lost. This tiny early script holds any submit
   on the page until the handlers are ready, then replays the last one once. External file (strict CSP, no inline). */
(function () {
  "use strict";
  var ready = false, pending = null, submitter = null;
  document.addEventListener("submit", function (e) {
    if (ready) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    pending = e.target;
    submitter = e.submitter || null;
  }, true);
  document.addEventListener("DOMContentLoaded", function () {
    // the page script's DOMContentLoaded listener was registered after this one: let it run first
    setTimeout(function () {
      ready = true;
      window.HelmLoginSubmitReady = true;
      var f = pending; pending = null;
      if (f && f.isConnected && !f.hidden) {
        try { if (f.requestSubmit) f.requestSubmit(submitter && submitter.form === f ? submitter : undefined); }
        catch (err) { /* ignore: the person can click again */ }
      }
    }, 0);
  });
})();
