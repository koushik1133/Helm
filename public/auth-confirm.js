/* auth-confirm.js — /auth/confirm (0205): opens every Helm auth e-mail link on www.helm.events.
   The link carries a one-time hashed token (never a session); it is verified HERE, in this browser
   (supabase.auth.verifyOtp), then:
     invite / magiclink → the Join page (/login?invite=<token>) signed in → accept → "Set your password"
                          when the login has none (the same marks the old #fragment path set)
     recovery           → /reset-password (choose a new password)
     signup / email     → signed in → /login routes to the studio (only when THIS browser started that
                          sign-up; otherwise "E-mail confirmed - sign in", so a link made for someone
                          else's account can never sign this browser into it)
     email_change       → "E-mail changed - sign in"
   Already signed in → nothing is verified until the person chooses "Sign out and continue".
   External file: no inline script, so the hash-based CSP needs no change for this page's logic.
   Round 19: loaded BEFORE store-api.js, so the right words show at once ("Confirming your email…" for a
   sign-up link) and the token leaves the address bar sooner; the work starts once store-api.js is in.
   A confirmed sign-up hands over to /login with a one-shot flag (sessionStorage bp_confirm_handoff): the
   sign-in page opens on "Setting up your studio…" instead of flashing its sign-in form. A sign-up confirmed
   in ANOTHER browser asks once - "Continue as <e-mail>" (or sign out) - then goes straight on to the welcome. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var C = window.HelmAuthConfirm;
  var link = C ? C.parse(location.search || "", location.origin) : { ok: false, reason: "bad_link" };
  // the one-time token never stays in the address bar / history
  try { if (window.history && history.replaceState) history.replaceState(null, "", location.pathname); } catch (e) {}

  function say(title, sub) { $("#title").textContent = title; $("#sub").textContent = sub || ""; }
  function err(t) { var e = $("#err"); e.textContent = t; e.hidden = !t; }
  // r21 CodeQL js/xss + js/client-side-unvalidated-url-redirection: parse() (auth-confirm-core.js safePath) already
  // allows only same-origin paths. go() never hands the link's own text to location.replace: the path is resolved
  // with new URL() against this origin, must be one of the fixed pages an auth e-mail returns to (the string sent
  // is this file's own constant), and only the query (invite token, ?next=, ?error_code=) is carried after "?".
  // Anything else -> /login (the default every auth link already falls back to).
  var GO_PATHS = ["/login", "/login.html", "/reset-password", "/reset-password.html"];
  function go(path) {
    var target = "/login", u = null;
    try { u = new URL(String(path || ""), location.origin); } catch (e) { u = null; }
    if (u && u.origin === location.origin) {
      for (var i = 0; i < GO_PATHS.length; i++) {
        if (u.pathname === GO_PATHS[i]) { target = GO_PATHS[i]; if (u.search.length > 1) target = target + "?" + u.search.slice(1); break; }
      }
    }
    location.replace(target);
  }
  var SIGNUP = link.ok && (link.type === "signup" || link.type === "email");
  // round 19: the right words straight away (this file runs before the big store-api.js loads)
  if (SIGNUP) say("Confirming your email…", "One moment — we're confirming your e-mail address.");
  // the sign-in page opens on "Setting up your studio…" (auth-handoff.js), never on its sign-in form
  function handoff() { try { sessionStorage.setItem("bp_confirm_handoff", String(Date.now())); } catch (e) {} }
  // a sign-up confirmed in a browser that did not start it: say whose account it is, continue on one click
  // left without choosing (tab closed / navigated away): this browser keeps NO session of that account
  // (synchronous: the Supabase session lives in localStorage under sb-<project>-auth-token)
  function dropSessionNow() {
    try { for (var i = localStorage.length - 1; i >= 0; i--) { var k = localStorage.key(i); if (k && /^sb-[a-z0-9]+-auth-token$/.test(k)) localStorage.removeItem(k); } } catch (e) {}
  }
  function askContinue(email) {
    var chosen = false;
    window.addEventListener("pagehide", function () { if (!chosen) dropSessionNow(); });
    say("Your e-mail is confirmed", "Continue as " + (email || "this account") + " to start your free trial. Not you? Sign out and sign in with your own account.");
    var b0 = $("#switchBtn"), b = b0.cloneNode(false);   // a fresh button: no "Sign out and continue" listener left on it
    b0.parentNode.replaceChild(b, b0); b.hidden = false; b.disabled = false;
    b.textContent = "Continue as " + (email || "this account") + " →";
    b.addEventListener("click", function () { chosen = true; b.disabled = true; b.textContent = "Opening…"; handoff(); go(link.next); });
    var l = $("#toLogin"); l.textContent = "Not you? Sign out"; l.setAttribute("href", "/login?confirmed=1");
    l.addEventListener("click", async function (ev) {
      ev.preventDefault(); chosen = true;
      try { await BPStore.auth.signOut(); } catch (e) {}
      dropSessionNow();
      go("/login?confirmed=1");
    });
    setTimeout(function () { try { b.focus(); } catch (e) {} }, 30);
  }

  async function verify() {
    if (SIGNUP) say("Confirming your email…", "One moment — we're confirming your e-mail address.");
    else say("Opening your link…", "One moment — we're checking your e-mail link.");
    var res;
    try { res = await BPStore.auth.verifyEmailLink(link.tokenHash, link.type); }
    catch (e) {
      var code = String((e && (e.code || e.error_code)) || "").toLowerCase();
      var expired = /otp_expired|expired|invalid|not.?found|access_denied|403|already/.test(code + " " + String((e && e.message) || "").toLowerCase());
      // the landing page explains it and offers the next step (e.g. "Email me a new link" on the Join page)
      go(C.withParam(link.next, "error_code", expired ? "otp_expired" : "link_failed"));
      return;
    }
    var user = (res && res.user) || BPStore.auth.user() || {};
    if (link.type === "recovery") { go(link.next); return; }
    if (link.type === "invite" || link.type === "magiclink") {
      if (link.invite) {
        var need = link.type === "invite";
        var np = await BPStore.auth.needsPassword();
        if (np !== null) need = np;
        BPStore.auth.markInviteLinkSession(need);
        go(link.next);
        return;
      }
      // a sign-in link with no invitation behind it: never keep a session someone else could have made
      try { await BPStore.auth.signOut(); } catch (e) {}
      go("/login?confirmed=1");
      return;
    }
    if ((link.type === "signup" || link.type === "email") && BPStore.auth.signupStartedHere(user.email)) {
      say("Email confirmed", "Setting up your studio…"); handoff(); go(link.next); return; }
    // round 19: confirmed in another browser - never silently: "Continue as <e-mail>" (one click) or sign out
    if (SIGNUP && user && user.email) { askContinue(user.email); return; }
    try { await BPStore.auth.signOut(); } catch (e) {}
    go("/login?confirmed=" + (link.type === "email_change" ? "email_change" : "1"));
  }

  async function start() {
    if (!link.ok) { say("This link doesn't work", "The link is incomplete or was changed. Open the newest e-mail from Helm, or request a new link from the sign-in page."); return; }
    try { await BPStore.init(); } catch (e) {}
    if (!BPStore.auth.enabled || !BPStore.auth.enabled()) { say("Sign-in unavailable", "Accounts aren't enabled in this environment."); return; }
    var cur = BPStore.auth.user && BPStore.auth.user();
    if (cur) {
      // never swap the signed-in account for one carried in a link without asking
      say("You're already signed in", "You're signed in as " + (cur.email || "another account") + ". To open this link, sign out first.");
      var b = $("#switchBtn"); b.hidden = false;
      b.addEventListener("click", async function () {
        b.disabled = true; b.textContent = "Signing out…";
        try { await BPStore.auth.signOut(); } catch (e) {}
        b.hidden = true; verify();
      });
      $("#toLogin").setAttribute("href", "/dashboard"); $("#toLogin").textContent = "← Keep me signed in";
      return;
    }
    verify();
  }
  function run() { start().catch(function () { err("Something went wrong opening this link. Check your connection and try again."); }); }
  // store-api.js loads after this file: start once it is there (DOMContentLoaded = every script ran)
  if (window.BPStore) run(); else document.addEventListener("DOMContentLoaded", run);
})();
