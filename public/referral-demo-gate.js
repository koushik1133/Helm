/* referral-demo-gate.js - r78: loads the localhost-only referral click-through demo (referral-demo.js) ONLY when it is
   wanted: page on localhost / 127.0.0.1 / [::1] AND ?demo=1 (same rule as hq.js demoWanted). referral-demo.js is never
   deployed (.vercelignore), so it is never requested anywhere else (no 404 / MIME error in production).
   window.HelmReferralDemoGate = { wanted: bool, demoWanted(host, search), ready: Promise }.
   refer-boot.js / refer.js / hq-referrals.js / referral-signup.js wait on `ready` only when `wanted`; otherwise they
   run straight away exactly as before. */
(function (root) {
  "use strict";
  function demoWanted(host, search) {
    return /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(String(host || "")) && /(^|[?&])demo=1(&|$)/.test(String(search || "").replace(/^\?/, ""));
  }
  var api = { demoWanted: demoWanted, wanted: false, ready: null };
  if (typeof module === "object" && module.exports) { module.exports = api; return; }
  try { api.wanted = demoWanted(root.location.hostname, root.location.search); } catch (e) { api.wanted = false; }
  api.ready = !api.wanted ? Promise.resolve() : new Promise(function (resolve) {
    var sc = document.createElement("script"); sc.src = "/referral-demo.js?v=3";
    sc.addEventListener("load", function () { resolve(); }); sc.addEventListener("error", function () { resolve(); });
    (document.head || document.documentElement).appendChild(sc);
  });
  root.HelmReferralDemoGate = api;
})(typeof window !== "undefined" ? window : this);
