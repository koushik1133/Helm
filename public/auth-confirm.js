/* auth-confirm.js — /auth/confirm (0204): opens every Helm auth e-mail link on www.helm.events.
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
   External file: no inline script, so the hash-based CSP needs no change for this page's logic. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var C = window.HelmAuthConfirm;
  var link = C ? C.parse(location.search || "", location.origin) : { ok: false, reason: "bad_link" };
  // the one-time token never stays in the address bar / history
  try { if (window.history && history.replaceState) history.replaceState(null, "", location.pathname); } catch (e) {}

  function say(title, sub) { $("#title").textContent = title; $("#sub").textContent = sub || ""; }
  function err(t) { var e = $("#err"); e.textContent = t; e.hidden = !t; }
  function go(path) { location.replace(path); }

  async function verify() {
    say("Opening your link…", "One moment — we're checking your e-mail link.");
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
    if ((link.type === "signup" || link.type === "email") && BPStore.auth.signupStartedHere(user.email)) { go(link.next); return; }
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
  start().catch(function () { err("Something went wrong opening this link. Check your connection and try again."); });
})();
