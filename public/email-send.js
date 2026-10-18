/* email-send.js - "Send by email" for the client approval link / client booklet link.
 * Calls BPStore.approval.emailLink (client-mailer edge function). The server sends to the
 * client e-mail SAVED ON THE QUOTE; the address shown here is only a preview.
 * Result line: "Emailed to a***@b.com" / "Not sent: <reason>".
 * allowUnknown: page has no e-mail field (event page) - the server still checks the address.
 * Free trial: nothing real is sent - the button is off with the test-mode line (the server
 * answers status "test_mode" too, client-mailer + _shared/trial-outbound.ts).
 * CSP-safe: DOM via createElement / textContent, no inline styles or handlers. */
(function () {
  "use strict";
  var TEST_MODE = "Test mode \u2014 in the free trial we don't send real messages; copy the link instead.";
  var OK = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function mask(e) { var s = String(e || ""), i = s.indexOf("@"); return i < 1 ? "" : s.slice(0, 1) + "***" + s.slice(i); }
  function resultText(r, fallbackTo) {
    var st = r && r.status;
    if (st === "sent") return "Emailed to " + ((r && r.masked) || mask(fallbackTo) || "the client");
    if (st === "test_mode") return TEST_MODE;
    if (st === "not_configured") return "Not sent: " + ((r && r.reason) || "e-mail sending is not set up yet") + ". Use Copy link meanwhile.";
    return "Not sent: " + ((r && (r.reason || r.error)) || "the e-mail could not be sent");
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
    var trial = false;
    function email() { return String((opts.getEmail && opts.getEmail()) || "").trim(); }
    function refresh() {
      var e = email();
      if (trial) { btn.disabled = true; to.textContent = TEST_MODE; return; }
      if (!e && opts.allowUnknown) { btn.disabled = false; to.textContent = "To the client e-mail saved on the quote."; return; }
      btn.disabled = !OK.test(e);
      to.textContent = OK.test(e) ? "To the client e-mail on the quote: " + e : "Add a valid client e-mail in step 1 to send by email.";
    }
    btn.addEventListener("click", function () {
      refresh(); msg.textContent = ""; if (btn.disabled) return;
      var e = email();
      var run = function () {
        return S.approval.emailLink(opts.quoteId, opts.kind).then(function (r) {
          msg.textContent = resultText(r, e);
          if (r && r.status === "test_mode") { trial = true; refresh(); }
          if (r && r.status === "sent" && U && U.toast) U.toast(msg.textContent, { type: "ok" });
        }).catch(function (err) { msg.textContent = "Not sent: " + String((err && err.message) || "the e-mail could not be sent"); });
      };
      return U && U.guard ? U.guard(btn, run) : run();
    });
    refresh();
    // free-trial studio (my_trial_limits {trial}): nothing real is sent
    try { if (S.subscription && S.subscription.limits) S.subscription.limits().then(function (l) { if (l && l.trial === true) { trial = true; refresh(); } }).catch(function () {}); } catch (e) {}
    return { refresh: refresh };
  }
  window.HelmEmailSend = { mount: mount, resultText: resultText, mask: mask, TEST_MODE: TEST_MODE };
})();
