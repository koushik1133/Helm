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
   R114 (0323): a free trial is a full SIMULATION - flow.html step 10 gets the red
   "SIMULATION - no real payment" banner and the client's simulated payments (TEST
   receipts from the approval page's "Simulate payment"; never the money ledger).
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
  // R116: same shape as the paid line ("they confirm with ...") so a trial never reads as a real one-time code
  var ASK_TEXT = "Their page gets an Approve button - they confirm with the test code 000000 (trial simulation - nothing is sent). Untick to share the booklet only.";
  function shareSpec(t) {
    if (!t || typeof t !== "object" || t.is_trial_org !== true) return null;
    return { note: SHARE_NOTE, ask: ASK_TEXT };
  }
  // "Approved ✓ on <date>" -> "Approved (test mode) ✓ on <date>" for a trial studio; unchanged otherwise
  function approvedLabel(text, test) {
    var s = String(text == null ? "" : text);
    return test && /^Approved\b/.test(s) && !/test mode/i.test(s) ? s.replace(/^Approved/, "Approved (test mode)") : s;
  }

  // R114 (0323): the studio's payment step in a trial is a simulation. Pure (unit-tested): my_trial_org() -> text or null
  var PAY_SIM = "SIMULATION - no real payment. Your client is never sent a payment link in the free trial; on their page they can press Simulate payment (a TEST receipt, no money moves).";
  function paySimSpec(t) {
    if (!t || typeof t !== "object" || t.is_trial_org !== true) return null;
    return { text: PAY_SIM };
  }
  // Pure: trial_sim_payments_for_quote rows -> display lines (amount + label + TEST receipt only)
  function simLines(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.slice(0, 20).map(function (r) {
      var amt = Number(r && r.amount) || 0, cur = String((r && r.currency) || "INR").toUpperCase().slice(0, 3);
      return "Simulated by the client: " + String((r && r.label) || "Payment").slice(0, 80) + " - " + cur + " " +
        amt.toLocaleString("en-IN") + " (receipt " + String((r && r.receipt) || "TEST").slice(0, 40) + ", TEST - no real money)";
    });
  }

  // R116: the page name from a path - production uses clean URLs (/flow, /settlement, /<studio>/flow,
  // /<studio>/settlement) as well as /flow.html. The old /([a-z0-9_-]+)\.html/ test only matched *.html, so on live
  // (cleanUrls) page() was "" and nothing on this page ran. Pure (unit-tested).
  function pageFrom(pathname) {
    var seg = String(pathname || "").split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop() || "";
    seg = seg.toLowerCase().replace(/\.html$/, "");
    return /^[a-z0-9_-]{1,40}$/.test(seg) ? seg : "";
  }

  var api = { noteSpec: noteSpec, pageFrom: pageFrom, paySimSpec: paySimSpec, simLines: simLines, PAY_SIM: PAY_SIM, TEXT: TEXT, shareSpec: shareSpec, approvedLabel: approvedLabel, SHARE_NOTE: SHARE_NOTE, ASK_TEXT: ASK_TEXT,
    approvalTestMode: false };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (!global || !global.document) return;
  global.HelmTrialTestNote = api;
  var doc = global.document;

  function page() {
    try { var U = global.HelmUrl, r = U && U.page && U.page(); if (r === "flow" || r === "settlement") return r; } catch (e) {}
    return pageFrom(global.location.pathname || "");
  }

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

  // R114: the red banner on step 10 + the client's simulated payments (flow.html only)
  function renderPaySim(spec) {
    if (!spec) return;
    var sec = doc.getElementById("sec-pay"); if (!sec || doc.getElementById("paySimNote")) return;
    var TS = global.HelmTrialSim, h2 = sec.querySelector("h2");
    var box = doc.createElement("div"); box.id = "paySimNote";
    if (TS && TS.banner) { sec.insertBefore(box, h2 ? h2.nextSibling : sec.firstChild); TS.banner(box, spec.text); }
    else { box.className = "hint"; box.setAttribute("role", "note"); box.textContent = spec.text; sec.insertBefore(box, h2 ? h2.nextSibling : sec.firstChild); }
    var id = "";
    try { var sp = new URLSearchParams(global.location.search); id = sp.get("quote") || sp.get("id") || ""; } catch (e) { id = ""; }
    var st = global.BPStore;
    if (!/^[0-9a-f-]{36}$/i.test(id) || !st || !st.approval || !st.approval.trialSimPayments) return;
    st.approval.trialSimPayments(id).then(function (rows) {
      var lines = simLines(rows); if (!lines.length) return;
      var ul = doc.createElement("ul"); ul.id = "paySimList"; ul.className = "hint";
      lines.forEach(function (l) { var li = doc.createElement("li"); li.textContent = l; ul.appendChild(li); });
      box.appendChild(ul);
    }).catch(function () {});
  }

  var tries = 0;
  function run() {
    var st = global.BPStore, pg = page();
    if (pg !== "flow" && pg !== "settlement") return;
    if (!st || !st.trialOrg || !st.trialOrg.status || !st.auth || !st.auth.user || !st.auth.user()) {
      if (++tries < 20) setTimeout(run, 500); // wait for the session to restore
      return;
    }
    st.trialOrg.status().then(function (t) { render(noteSpec(t, pg)); if (pg === "flow") { renderShare(shareSpec(t)); renderPaySim(paySimSpec(t)); } }).catch(function () {});
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", function () { setTimeout(run, 0); });
  else setTimeout(run, 0);
})(typeof window !== "undefined" ? window : this);
