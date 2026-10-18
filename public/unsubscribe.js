/* unsubscribe.js - /unsubscribe?t=<signed token> (0165). One click to unsubscribe, a
   confirmation, and a re-subscribe button. Talks only to the email-unsubscribe edge function;
   the token is checked (HMAC) in the database. Never shows the full address. Text only (textContent). */
(function () {
  "use strict";
  var TOKEN_RE = /^v1\.[0-9a-f]{32}\.[0-9a-f]{2,520}\.[0-9a-f]{64}$/;
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var token = String(params.get("t") || "");
  var cfg = window.SUPABASE_CONFIG || {};
  var base = String(cfg.url || "").replace(/\/+$/, "");
  var endpoint = base ? base + "/functions/v1/email-unsubscribe" : "";

  function show(title, msg, unsub, resub) {
    $("us-title").textContent = title;
    $("us-msg").textContent = msg;
    $("us-unsub").hidden = !unsub; $("us-resub").hidden = !resub;
    $("us-unsub").disabled = false; $("us-resub").disabled = false;
  }
  function render(d) {
    if (!d || d.ok !== true) return show("Link not valid", "This unsubscribe link is not valid. Use the link in the most recent e-mail, or reply to that e-mail and ask to be removed.", false, false);
    var who = d.sender || "this sender";
    if (d.opted_out) show("You are unsubscribed", d.email + " will no longer get follow-up or greeting e-mails from " + who + ". Changed your mind?", false, true);
    else show("Unsubscribe?", "Stop follow-up and greeting e-mails from " + who + " to " + d.email + "?", true, false);
  }
  function call(action) {
    if (!endpoint) return Promise.resolve(null);
    var h = { "Content-Type": "application/json" };
    if (cfg.anonKey) h.apikey = cfg.anonKey;
    return fetch(endpoint, { method: "POST", headers: h, body: JSON.stringify({ t: token, action: action }), credentials: "omit" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }
  function act(action) {
    $("us-unsub").disabled = true; $("us-resub").disabled = true;
    call(action).then(function (d) {
      if (!d) return show("Something went wrong", "We could not save that just now. Please try again in a minute.", action === "unsubscribe", action === "resubscribe");
      render(d);
    });
  }
  function start() {
    $("us-unsub").addEventListener("click", function () { act("unsubscribe"); });
    $("us-resub").addEventListener("click", function () { act("resubscribe"); });
    if (!TOKEN_RE.test(token)) return render(null);
    call("status").then(function (d) { if (d === null) show("Something went wrong", "We could not load this link just now. Please try again in a minute.", false, false); else render(d); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
