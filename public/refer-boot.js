/* refer-boot.js - r29 referral PHASE 1. Runs BEFORE store-api.js on refer.html.
   Only in the localhost click-through demo (r78: referral-demo-gate.js says it is wanted - localhost / 127.0.0.1 /
   [::1] with ?demo=1 - and is loading referral-demo.js; this must stay synchronous, before store-api.js): lift the sign-in gate so the page can be seen without an account.
   Everywhere else this file does nothing and the normal sign-in gate (store-api.js) applies. */
(function () {
  "use strict";
  var g = window.HelmReferralDemoGate; if (!g || !g.wanted) return;
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(String(location.hostname || ""))) return;
  try { document.documentElement.classList.remove("auth-pending"); } catch (e) {}
})();
