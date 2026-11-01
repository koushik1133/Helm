/* =========================================================================
   HELM - client approval page: free-trial TEST MODE (R113, database 0322)
   -------------------------------------------------------------------------
   Owner decision: a studio on a Helm free trial (active or ended) never sends
   a real approval code to its client - no e-mail, no WhatsApp, no SMS. The
   approval page (approve.html) then shows a "Test mode" banner, marks the
   terms as a trial preview, hides the "send code" buttons and offers the test
   code 000000 + "Simulate approval". The server re-checks everything
   (trial_test_approve_code): only a trial studio, only 000000.
   Paid studios: spec() answers null and the page is exactly as before.
   CSP: no inline handlers, no HTML strings - textContent / hidden only.
   ========================================================================= */
(function (global) {
  "use strict";
  var CODE = "000000";
  var BANNER = "Test mode — this studio is on a Helm free trial. No code is sent. Use code " + CODE + " to try the approval.";
  var TERMS_NOTE = "This is a trial preview: nothing here is a binding booking, no payment is taken, and no messages are sent.";
  var TERMS_LABEL = "Preview of the studio's terms (trial - not binding)";
  var ENDED = "This studio's free trial has ended, so the test approval is closed. Please contact your planner.";
  var APPROVED = "Approved in test mode - no code was sent. This is a trial preview: not a binding booking, and no payment is taken.";

  // Pure (unit-tested): the public_trial_approval_mode answer (or, before 0322, the old boolean
  // trial_test_mode_for_token) -> what the page shows, or null for a paid studio / unknown answer.
  function spec(mode) {
    if (mode === true) mode = { test_mode: true, can_approve: true, ended: false };   // pre-0322 database
    if (!mode || typeof mode !== "object" || mode.test_mode !== true) return null;
    var ended = mode.ended === true;
    return { banner: BANNER, termsNote: TERMS_NOTE, termsLabel: TERMS_LABEL, hideSend: true,
      simulate: !ended && mode.can_approve !== false, ended: ended, endedText: ended ? ENDED : "" };
  }
  // Pure: the code typed in the test box -> null when it is the test code, else a friendly message
  function checkCode(v) {
    var c = String(v == null ? "" : v).replace(/\s+/g, "");
    if (c === CODE) return null;
    if (!c) return "Enter the test code " + CODE + ".";
    return "That's not the test code. In test mode no code is sent - use " + CODE + ".";
  }

  var api = { CODE: CODE, BANNER: BANNER, TERMS_NOTE: TERMS_NOTE, TERMS_LABEL: TERMS_LABEL, ENDED: ENDED, APPROVED: APPROVED,
    spec: spec, checkCode: checkCode };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (!global || !global.document) return;
  var doc = global.document;

  function q(sel) { return doc.querySelector(sel); }
  function hide(sel) { var n = q(sel); if (n) { n.hidden = true; n.style.display = "none"; } }

  // DOM: apply a spec() answer to approve.html (ids are the page's own)
  api.apply = function (s) {
    if (!s) return false;
    var b = q("#testModeBanner"); if (b) { b.textContent = s.banner; b.hidden = false; }
    var tn = q("#termsTrialNote"); if (tn) { tn.textContent = s.termsNote; tn.hidden = false; }
    var tl = q("#termsLabel"); if (tl) tl.textContent = s.termsLabel;
    var tc = q("#terms"); if (tc) tc.classList.add("terms-preview");
    if (s.hideSend) { ["#sendEmailOtp", "#sendWa", "#sendOtp", "#waNote"].forEach(hide); }
    var box = q("#trialSkip"); if (box) box.hidden = false;
    var info = q("#trialSkipInfo"); if (info) info.textContent = s.ended ? s.endedText
      : "In this trial no code is sent to you by e-mail, WhatsApp or SMS. Type the test code " + CODE + " and press Simulate approval - it is recorded as a test, not a real booking.";
    if (!s.simulate) { ["#trialCodeRow", "#trialAgreeRow", "#trialSkipBtn"].forEach(hide); }
    var foot = q("#footNote"); if (foot) foot.textContent = "Trial preview - no code is sent and no payment is taken.";
    return true;
  };
  global.HelmApproveTestMode = api;
})(typeof window !== "undefined" ? window : this);
