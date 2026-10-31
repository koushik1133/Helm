/* =========================================================================
   HELM - trial test mode instructions on staff payment steps (builds on 0128)
   -------------------------------------------------------------------------
   flow.html step 9 (advance payment) and settlement.html (Record payment):
   in an ACTIVE free-trial studio only, show a short info box explaining the
   real client step (OTP + UPI/card payment link) and a "Skip" button that
   records the payment offline instead (no gateway, no SMS). Non-trial studios:
   nothing is shown. The server still gates every write; this is guidance only.
   R113 (0322): flow.html step 9 also says "Trial: your client sees a test-mode
   approval page (no code is sent)" and shows "Approved (test mode)" in a trial.
   CSP: createElement/textContent only, no inline styles.
   ========================================================================= */
(function (global) {
  "use strict";
  var TEXT = "In a real studio your client verifies with a one-time code sent to their phone, then pays by UPI/card through the payment link. In this trial you can skip that step.";

  // Pure (unit-tested): my_trial_org() answer + page -> note spec, or null.
  function noteSpec(t, pageName) {
    if (!t || typeof t !== "object" || t.is_trial_org !== true) return null;
    if (t.ended === true || t.locked === true) return null;
    if (pageName === "flow") return { anchor: "#pay_terms", text: TEXT, skip: "Skip online payment - record as cash (trial)", method: "cash", focus: "#pay_amount" };
    if (pageName === "settlement") return { anchor: "#pay_block", text: TEXT, skip: "Skip online payment - record it here (trial)", method: null, focus: "#pay_amt" };
    return null;
  }

  // R113 (0322): in a free-trial studio (active or ended) the client approval is a TEST - no code is sent, the client
  // uses the test code 000000. Pure (unit-tested): my_trial_org() answer -> share-panel spec, or null (paid studio).
  var SHARE_NOTE = "Trial: your client sees a test-mode approval page (no code is sent).";
  var ASK_TEXT = "Their page gets an Approve button - in the free trial it is a test approval (code 000000, nothing is sent). Untick to share the booklet only.";
  function shareSpec(t) {
    if (!t || typeof t !== "object" || t.is_trial_org !== true) return null;
    return { note: SHARE_NOTE, ask: ASK_TEXT };
  }
  // "Approved ✓ on <date>" -> "Approved (test mode) ✓ on <date>" for a trial studio; unchanged otherwise
  function approvedLabel(text, test) {
    var s = String(text == null ? "" : text);
    return test && /^Approved\b/.test(s) && !/test mode/i.test(s) ? s.replace(/^Approved/, "Approved (test mode)") : s;
  }

  var api = { noteSpec: noteSpec, TEXT: TEXT, shareSpec: shareSpec, approvedLabel: approvedLabel, SHARE_NOTE: SHARE_NOTE, ASK_TEXT: ASK_TEXT,
    approvalTestMode: false };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (!global || !global.document) return;
  global.HelmTrialTestNote = api;
  var doc = global.document;

  function page() { var m = /([a-z0-9_-]+)\.html/i.exec(global.location.pathname || ""); return m ? m[1].toLowerCase() : ""; }

  function render(spec) {
    if (!spec || doc.getElementById("trialTestNote")) return;
    var anchor = doc.querySelector(spec.anchor); if (!anchor || !anchor.parentNode) return;
    var box = doc.createElement("div"); box.id = "trialTestNote"; box.className = "hint"; box.setAttribute("role", "note");
    var b = doc.createElement("b"); b.textContent = "Trial test mode: ";
    box.appendChild(b); box.appendChild(doc.createTextNode(spec.text + " "));
    var btn = doc.createElement("button"); btn.type = "button"; btn.className = "btn"; btn.id = "trialTestSkip"; btn.textContent = spec.skip;
    btn.addEventListener("click", function () {
      if (spec.method) { var sel = doc.getElementById("pay_method"); if (sel) { sel.value = spec.method; try { sel.dispatchEvent(new Event("change", { bubbles: true })); } catch (e) {} } }
      var f = doc.querySelector(spec.focus); if (f) { try { f.focus(); } catch (e) {} }
    });
    box.appendChild(btn);
    anchor.parentNode.insertBefore(box, anchor.nextSibling);
  }

  // R113: flow.html step 9 "Share with client" - the trial note + "Approved (test mode)" (flow.html re-syncs on the event)
  function renderShare(spec) {
    if (!spec) return;
    api.approvalTestMode = true;
    var sub = doc.getElementById("csApproveSub");
    if (sub && sub.parentNode && !doc.getElementById("csTrialNote")) {
      var p = doc.createElement("p"); p.id = "csTrialNote"; p.className = "hint"; p.setAttribute("role", "note");
      p.textContent = spec.note; sub.parentNode.insertBefore(p, sub.nextSibling);
    }
    var ask = doc.querySelector("#csAskRow small"); if (ask) ask.textContent = spec.ask;
    try { global.dispatchEvent(new global.CustomEvent("helm:approval-test-mode")); } catch (e) {}
  }

  var tries = 0;
  function run() {
    var st = global.BPStore, pg = page();
    if (pg !== "flow" && pg !== "settlement") return;
    if (!st || !st.trialOrg || !st.trialOrg.status || !st.auth || !st.auth.user || !st.auth.user()) {
      if (++tries < 20) setTimeout(run, 500); // wait for the session to restore
      return;
    }
    st.trialOrg.status().then(function (t) { render(noteSpec(t, pg)); if (pg === "flow") renderShare(shareSpec(t)); }).catch(function () {});
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", function () { setTimeout(run, 0); });
  else setTimeout(run, 0);
})(typeof window !== "undefined" ? window : this);
