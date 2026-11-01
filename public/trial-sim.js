/* =========================================================================
   HELM - free trial = full SIMULATION (R114, database 0323)
   -------------------------------------------------------------------------
   Owner decision (2026-10-31): in a studio on a Helm free trial NOTHING real
   leaves Helm to a client - no e-mail, no WhatsApp, no SMS, no approval code,
   no payment link. The owner still walks the whole flow and SEES what would
   happen, as previews, under one red banner:
     "Trial simulation - nothing is sent to your client, no real payment."
   This file is the shared piece:
     * banner(host)            - the red banner (client pages + studio send boxes)
     * preview(host, p)        - "This is what your client would receive" box
     * payStep(sim)            - pure: the approval page's simulated payment step
     * refFrom(kind, loc)      - pure: the link reference of a client page
     * auto banner: <script src="/trial-sim.js" data-trial-sim="quote|booklet|site">
       asks public_trial_simulation and puts the banner at the top of <main>.
   The server decides everything (0323 / 0322 / 0187 / 0179): this only shows it.
   Paid studios: the server answers simulation:false and nothing is shown.
   CSP: createElement / textContent only, no inline styles or handlers.
   ========================================================================= */
(function (global) {
  "use strict";
  var TITLE = "Trial simulation";
  var BANNER = "Nothing is sent to your client, and no real payment is taken. This studio is on a Helm free trial - every step here is a preview.";
  var PREVIEW_TITLE = "This is what your client would receive - not sent (trial simulation)";
  var PAY_NEXT = "Next step (simulated): your client would now pay the booking amount through a secure payment link. In this trial no link is created and no money moves.";
  var PAY_DONE = "Payment simulated - no real money moved. In a paid studio the client would get a receipt and you would see the payment in Payments.";
  var PAY_ENDED = "This studio's free trial has ended, so the payment simulation is closed.";
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function money(n, cur) {
    var v = Number(n) || 0, c = String(cur || "INR").toUpperCase();
    try { return new Intl.NumberFormat(c === "INR" ? "en-IN" : "en-US", { style: "currency", currency: c, maximumFractionDigits: 2 }).format(v); }
    catch (e) { return (c === "INR" ? "₹" : c + " ") + v.toLocaleString("en-IN"); }
  }

  // Pure (unit-tested): the public_trial_payment_sim answer -> what the approval page shows, or null (paid studio /
  // unknown answer / database without 0323). Never exposes anything but the amount + label the client already sees.
  function payStep(sim) {
    if (!sim || typeof sim !== "object" || sim.simulation !== true) return null;
    var amount = Number(sim.amount) || 0;
    return {
      next: PAY_NEXT,
      canPay: sim.can_pay === true,
      ended: sim.ended === true,
      approved: sim.approved === true,
      paid: sim.paid === true,
      amountText: amount > 0 ? money(amount, sim.currency) : "",
      label: String(sim.label || "Booking payment").slice(0, 80),
      receipt: sim.receipt ? String(sim.receipt).slice(0, 40) : "",
      done: PAY_DONE,
      endedText: PAY_ENDED
    };
  }
  // Pure: a trial_simulate_payment answer -> the line shown under the button
  function payResult(r) {
    if (!r || typeof r !== "object") return { ok: false, text: "Could not simulate the payment. Please try again." };
    if (r.simulated === true && r.already === true) return { ok: true, text: String(r.message || "Already simulated - nothing real was charged."), more: false };
    if (r.simulated === true) {
      var amt = Number(r.amount) > 0 ? money(r.amount, r.currency) + " " : "";
      return { ok: true, more: r.more_due === true,
        text: "Simulated payment " + amt + "recorded as a TEST (receipt " + String(r.receipt || "TEST") + "). No real money moved." };
    }
    return { ok: false, text: String(r.message || "Could not simulate the payment.") };
  }
  // Pure: the link reference of a client page (approval token / booklet token / invitation slug), or ""
  function refFrom(kind, loc) {
    loc = loc || {};
    var path = String(loc.pathname || ""), q;
    try { q = new URLSearchParams(String(loc.search || "")); } catch (e) { q = { get: function () { return null; } }; }
    var m;
    if (kind === "quote") {
      m = /^\/[a-z0-9-]{3,40}\/(?:quote|portal|proposal)\/([^\/?#]+)\/?$/.exec(path);
      var t = m ? m[1] : String(q.get("token") || "");
      try { t = decodeURIComponent(t); } catch (e) { return ""; }
      return UUID.test(t) ? t.toLowerCase() : "";
    }
    if (kind === "booklet") {
      var b = String(q.get("t") || q.get("token") || "");
      return UUID.test(b) ? b.toLowerCase() : "";
    }
    if (kind === "site") {
      m = /^\/[a-z0-9-]{3,40}\/invite\/([^\/?#]+)\/?$/.exec(path) || /^\/i\/([^\/?#]+)/.exec(path);
      var s = m ? m[1] : String(q.get("s") || "");
      try { s = decodeURIComponent(s); } catch (e) { return ""; }
      return /^[a-z0-9-]{1,120}$/i.test(s) ? s.toLowerCase() : "";
    }
    return "";
  }

  var api = { TITLE: TITLE, BANNER: BANNER, PREVIEW_TITLE: PREVIEW_TITLE, PAY_NEXT: PAY_NEXT, PAY_DONE: PAY_DONE,
    payStep: payStep, payResult: payResult, refFrom: refFrom, money: money };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (!global || !global.document) return;
  var doc = global.document;

  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  // the red banner (one per host)
  api.banner = function (host, text) {
    if (!host) return null;
    var old = host.querySelector(":scope > .trial-sim-banner"); if (old) return old;
    var b = el("div", "trial-sim-banner"); b.setAttribute("role", "note"); b.setAttribute("data-trial-sim", "1");
    b.appendChild(el("strong", null, TITLE)); b.appendChild(el("span", null, " — " + (text || BANNER)));
    host.insertBefore(b, host.firstChild);
    return b;
  };
  // "This is what your client would receive" (p = { subject, text })
  api.preview = function (host, p) {
    if (!host) return null;
    var old = host.querySelector(":scope > .trial-sim-preview"); if (old) old.parentNode.removeChild(old);
    var box = el("div", "trial-sim-preview"); box.setAttribute("role", "region"); box.setAttribute("aria-label", PREVIEW_TITLE);
    box.appendChild(el("div", "trial-sim-preview-h", PREVIEW_TITLE));
    if (p && p.subject) box.appendChild(el("div", "trial-sim-preview-subj", "Subject: " + String(p.subject).slice(0, 200)));
    box.appendChild(el("pre", "trial-sim-preview-body", String((p && p.text) || "").slice(0, 4000)));
    host.appendChild(box);
    return box;
  };

  // auto banner on a client page: <script src="/trial-sim.js" data-trial-sim="quote|booklet|site">
  var me = doc.currentScript, kind = me && me.getAttribute("data-trial-sim");
  if (!kind) { global.HelmTrialSim = api; return; }
  var tries = 0;
  function run() {
    var st = global.BPStore, ref = refFrom(kind, global.location);
    if (!ref) return;
    if (!st || !st.approval || !st.approval.trialSimPage) { if (++tries < 20) setTimeout(run, 300); return; }
    Promise.resolve(st.init ? st.init() : null).catch(function () {}).then(function () { return st.approval.trialSimPage(kind, ref); }).then(function (r) {
      if (!r || r.simulation !== true) return;
      var host = doc.getElementById("main") || doc.body;
      api.banner(host);
      try { global.dispatchEvent(new global.CustomEvent("helm:trial-simulation")); } catch (e) {}
    }).catch(function () {});
  }
  global.HelmTrialSim = api;
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", function () { setTimeout(run, 0); });
  else setTimeout(run, 0);
})(typeof window !== "undefined" ? window : this);
