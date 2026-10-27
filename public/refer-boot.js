/* refer-boot.js - r29 referral PHASE 1. Runs BEFORE store-api.js on refer.html.
   Only in the localhost click-through demo (referral-demo.js created window.HelmReferralDemo, which it does only on
   localhost / 127.0.0.1 / [::1] with ?demo=1): lift the sign-in gate so the page can be seen without an account.
   Everywhere else this file does nothing and the normal sign-in gate (store-api.js) applies. */
(function () {
  "use strict";
  if (!window.HelmReferralDemo) return;
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(String(location.hostname || ""))) return;
  try { document.documentElement.classList.remove("auth-pending"); } catch (e) {}
})();
