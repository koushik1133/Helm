/* email-send.js - "Send by email" for the client approval link / client booklet link.
 * Calls BPStore.approval.emailLink (client-mailer edge function). The server sends to the
 * client e-mail SAVED ON THE QUOTE; the address shown here is only a preview.
 * Result line: "Emailed to a***@b.com" / "Not sent: <reason>".
 * allowUnknown: page has no e-mail field (event page) - the server still checks the address.
 * Free trial (0212, owner decision): e-mail WORKS in an ACTIVE trial - the e-mail really reaches the client
 * (capped: 30 a day per studio, 5 a day to one address; the server counts, client-mailer + trial_email_gate).
 * The line under the button says so (TRIAL_EMAIL). WhatsApp and SMS unlock on a paid plan. An ended trial, the
 * owner switch off or a database without 0212 (BPStore.subscription.messaging() -> email false / null): nothing
 * is sent - the button is off with the test-mode line (the server answers status "test_mode" too).
 * R114 (0323, owner decision: a free trial is a full SIMULATION): in a trial the button is "Preview e-mail (trial)":
 * nothing is sent - the server (client-mailer) answers { status: "test_mode", simulated: true, preview } and the box
 * shows "This is what your client would receive - not sent (trial simulation)" under the red trial banner.
 * CSP-safe: DOM via createElement / textContent, no inline styles or handlers. */
(function () {
  "use strict";
  var TEST_MODE = "Test mode \u2014 in the free trial we don't send real messages; copy the link instead.";
  // R114 (0323): the free trial is a simulation - preview instead of send
  var SIM_LINE = "Trial simulation \u2014 nothing is sent to your client. Press Preview to see the e-mail they would receive.";
  var SIM_LABEL = "Preview e-mail (trial)";
  var SIM_NO_PREVIEW = "Trial simulation \u2014 nothing was sent. (The e-mail preview appears once the latest Helm update is live.)";
  // 0212: an ACTIVE free trial e-mails the client for real (n = the studio's daily cap from the server)
  function trialEmailText(n) {
    return "Free trial: this e-mail really goes to your client (up to " + (n > 0 ? n : 30) + " e-mails a day). WhatsApp and SMS unlock on a paid plan.";
  }
  var TRIAL_EMAIL = trialEmailText(30);
  var OK = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function mask(e) { var s = String(e || ""), i = s.indexOf("@"); return i < 1 ? "" : s.slice(0, 1) + "***" + s.slice(i); }
  function resultText(r, fallbackTo) {
    var st = r && r.status;
    if (st === "sent") return "Emailed to " + ((r && r.masked) || mask(fallbackTo) || "the client");
    if (st === "test_mode") return TEST_MODE;
    if (st === "limit") return "Not sent: " + ((r && r.reason) || "the free trial e-mail limit for today is reached");
    if (st === "demo") return "Not sent: this is a sample (demo) event \u2014 e-mails go only to the clients of your own events.";
    if (st === "not_configured") return "Not sent: " + ((r && r.reason) || "e-mail sending is not set up yet") + ". Use Copy link meanwhile.";
    return "Not sent: " + friendlyReason((r && (r.reason || r.error)) || "");
  }
  // R106: never show a raw transport error ("HTTP 404", "Failed to fetch") - say what happened and what to do
  function friendlyReason(raw) {
    var m = String(raw || "").trim(), code = /HTTP (\d{3})/.exec(m);
    var c = code ? Number(code[1]) : 0;
    if (c === 404) return "the e-mail service isn't switched on yet. Use Copy link and send it yourself meanwhile.";
    if (c === 401 || c === 403) return "your sign-in has expired or you can't send e-mails for this event. Sign in again, or use Copy link.";
    if (c === 429) return "too many e-mails just now. Wait a minute and try again.";
    if (c >= 500 || /HTTP \d{3}/.test(m)) return "the e-mail service had a problem. Try again in a minute, or use Copy link.";
    if (/failed to fetch|network|load failed/i.test(m)) return "couldn't reach Helm. Check your connection and try again, or use Copy link.";
    return m || "the e-mail could not be sent. Try again, or use Copy link.";
  }
  // opts: { quoteId, kind: "approval"|"booklet", getEmail: () => string, label? }
  function mount(host, opts) {
    var S = window.BPStore, U = window.BPUI;
    if (!host || !opts || !opts.quoteId || !S || !S.approval || !S.approval.emailLink) return null;
    if (S.approval.emailEnabled && !S.approval.emailEnabled()) return null;
    var box = el("div", "ems-box"); box.setAttribute("data-email-send", opts.kind || "approval");
    var btn = el("button", "btn sm primary", opts.label || "Send by email"); btn.type = "button";
    var to = el("div", "ems-to muted");
    var msg = el("div", "ems-msg"); msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");
    box.appendChild(btn); box.appendChild(to); box.appendChild(msg); host.appendChild(box);
    var trial = false;          // free trial and e-mail does NOT reach clients (test mode)
    var trialEmail = "";        // 0212: active free trial, e-mail works - the note under the address
    function email() { return String((opts.getEmail && opts.getEmail()) || "").trim(); }
    var label = opts.label || "Send by email";
    function refresh() {
      var e = email();
      // R114: a trial previews - the button stays on, nothing is ever sent (the server refuses too)
      if (trial) { btn.disabled = false; btn.textContent = SIM_LABEL; to.textContent = SIM_LINE;
        try { if (window.HelmTrialSim && window.HelmTrialSim.banner) window.HelmTrialSim.banner(box); } catch (x) {}
        return; }
      btn.textContent = label;
      var note = trialEmail ? " " + trialEmail : "";
      if (!e && opts.allowUnknown) { btn.disabled = false; to.textContent = "To the client e-mail saved on the quote." + note; return; }
      btn.disabled = !OK.test(e);
      to.textContent = OK.test(e) ? "To the client e-mail on the quote: " + e + "." + note : "Add a valid client e-mail in step 1 to send by email.";
    }
    btn.addEventListener("click", function () {
      refresh(); msg.textContent = ""; if (btn.disabled) return;
      var e = email();
      var run = function () {
        return S.approval.emailLink(opts.quoteId, opts.kind).then(function (r) {
          msg.textContent = resultText(r, e);
          if (r && r.status === "test_mode") {
            trial = true; refresh();
            // R114: show what the client would receive (the server's preview) - never sent
            msg.textContent = (r.preview ? String(r.reason || "Trial simulation \u2014 nothing was sent to your client.") : SIM_NO_PREVIEW);
            var TS = window.HelmTrialSim;
            if (r.preview && TS && TS.preview) TS.preview(box, r.preview);
            else if (r.preview) { var pv = el("pre", "ems-preview", "Subject: " + String(r.preview.subject || "") + "\n\n" + String(r.preview.text || "").replace(/\(you will get a one-time code to confirm\)/g, "(trial simulation: they confirm with the test code 000000 - nothing is sent)")); box.appendChild(pv); }
          }
          if (r && r.status === "sent" && U && U.toast) U.toast(msg.textContent, { type: "ok" });
        }).catch(function (err) { msg.textContent = "Not sent: " + friendlyReason((err && err.message) || ""); });
      };
      return U && U.guard ? U.guard(btn, run) : run();
    });
    refresh();
    // free-trial studio: 0212 my_trial_messaging says whether e-mail reaches clients; before 0212 (null) the older
    // rule: a trial (my_trial_limits {trial}) sends nothing real
    try {
      var sub = S.subscription || {};
      Promise.resolve(sub.messaging ? sub.messaging() : null).then(function (m) {
        var st = trialState(m);
        if (st) { trial = st.testMode; trialEmail = st.note; refresh(); return; }
        if (sub.limits) return sub.limits().then(function (l) { if (l && l.trial === true) { trial = true; refresh(); } });
      }).catch(function () {});
    } catch (e) {}
    return { refresh: refresh };
  }
  // my_trial_messaging answer -> null (not known: use the older rule) | { testMode, note }
  function trialState(m) {
    if (!m || typeof m !== "object" || typeof m.trial !== "boolean") return null;
    if (m.trial !== true) return { testMode: false, note: "" };
    // R114 (0323): ANY free trial is a simulation - even an older database that still says email:true (0212)
    return { testMode: true, note: "" };
  }
  window.HelmEmailSend = { mount: mount, resultText: resultText, friendlyReason: friendlyReason, mask: mask, trialState: trialState, TEST_MODE: TEST_MODE, TRIAL_EMAIL: TRIAL_EMAIL,
    SIM_LINE: SIM_LINE, SIM_LABEL: SIM_LABEL };
})();
