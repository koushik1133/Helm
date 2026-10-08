/* reset-password.js — the "choose a new password" page (audit Phase 3-4 follow-up).
   Two ways in:
     1. the link from a "Forgot password?" email (PKCE: ?code= exchanged for a
        recovery session in the same browser that requested it) → set a new password → every session is signed
        out → back to the sign-in page;
     2. Account → "Change password" (?mode=change, already signed in) → confirm the
        current password (+ CAPTCHA when on) → set a new one → other devices are
        signed out, this one stays signed in.
   Accounts with two-step verification enter their 6-digit code before the password
   can change (Supabase requires an aal2 session for that). External file — no
   inline script, so the hash-based CSP needs no change for this page's logic. */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  // PKCE flow: the reset email link lands here as ?code=… (never tokens in the
  // fragment). store-api init exchanges it using the code verifier saved in the
  // browser that REQUESTED the reset; read the query BEFORE init cleans it up.
  var qp = new URLSearchParams(location.search || "");
  var RECOVERY_LINK = !!qp.get("code");
  var LINK_ERROR = qp.get("error_code") || qp.get("error") || "";
  var MODE_CHANGE = new URLSearchParams(location.search).get("mode") === "change";
  var recovering = false, cap = null;

  function show(id) { ["#vCurrent", "#vMfa", "#vSet", "#vDone"].forEach(function (s) { $(s).hidden = s !== id; }); }
  function err(t) { var e = $("#err"); e.textContent = t; e.hidden = !t; }
  function ok(t) { var e = $("#ok"); e.textContent = t; e.hidden = !t; }
  function sub(t) { $("#sub").textContent = t; }
  function friendly(e, action) {
    if (e && (/^(mfa_invalid|bad_current_password|captcha_|rate_limited)/.test(e.code || "") ||
        /^(Use at least|Include at least|Enter the 6-digit|Choose a password)/.test(e.message || ""))) return e.message;
    if (/captcha/i.test((e && e.message) || "")) return "The security check failed or expired — please try again.";
    return (window.BPUI && BPUI.friendlyError) ? BPUI.friendlyError(e, { action: action }) : ((e && e.message) || "Something went wrong.");
  }
  function guard(btn, fn) { return (window.BPUI && BPUI.guard) ? BPUI.guard(btn, fn) : fn(); }

  async function needsCode() {
    try { var lv = await BPStore.auth.mfa.level(); return !!(lv && lv.nextLevel === "aal2" && lv.currentLevel !== "aal2"); }
    catch (e) { return false; }
  }
  async function toNewPassword() {
    if (await needsCode()) { show("#vMfa"); sub("Your account uses two-step verification. Enter your code to continue."); setTimeout(function () { $("#mfa_code").focus(); }, 50); return; }
    show("#vSet"); sub(recovering ? "Choose a new password for your Helm account." : "Choose your new password.");
    setTimeout(function () { $("#new_pw").focus(); }, 50);
  }

  async function start() {
    await BPStore.init();
    if (!BPStore.auth.enabled()) { $("#title").textContent = "Password reset unavailable"; sub("Accounts aren't enabled in this environment."); return; }
    if (!LINK_ERROR && RECOVERY_LINK && BPStore.auth.linkError && BPStore.auth.linkError() && !BPStore.auth.pendingUser()) {
      // the code could not be exchanged: almost always a different browser / device
      $("#title").textContent = "Open the link in the same browser";
      sub("Open the link in the same browser you requested it from. If you did, the link may have been used or expired — request a new one.");
      $("#toLogin").setAttribute("href", "login#forgot"); $("#toLogin").textContent = "Request a new link →";
      return;
    }
    if (LINK_ERROR) {
      $("#title").textContent = "This link has expired";
      sub("Reset links work once and expire after a short time. Request a new one from the sign-in page.");
      $("#toLogin").setAttribute("href", "login#forgot"); $("#toLogin").textContent = "Request a new link →";
      return;
    }
    var u = BPStore.auth.pendingUser();
    if (!u) {
      if (MODE_CHANGE) { location.replace("login?next=dashboard"); return; }
      $("#title").textContent = "Open the link from your email";
      sub("To reset your password, use the link we emailed you. No email? Request a new link.");
      $("#toLogin").setAttribute("href", "login#forgot"); $("#toLogin").textContent = "Request a reset link →";
      return;
    }
    $("#acct_email").value = u.email || "";
    // "?code=" in the URL is NOT proof (anyone can type it): only a session
    // whose signed token says it came from a reset link skips the current-password step.
    var realRecovery = await BPStore.auth.isRecoverySession();
    if (RECOVERY_LINK && realRecovery) BPStore.auth.recovery.mark(u.id);
    recovering = realRecovery;
    if (recovering) { await toNewPassword(); return; }
    if (RECOVERY_LINK || BPStore.auth.pendingStep() === "recovery") {
      // a stale / spoofed reset marker: fall back to the normal signed-in change flow
      BPStore.auth.recovery.clear();
      try { await BPStore.auth.resolveGate(); } catch (x) {}
    }
    // change mode: the session must be fully signed in (two-step done etc.)
    var step = BPStore.auth.pendingStep();
    if (step) { location.replace("login"); return; }
    $("#title").textContent = "Change your password";
    $("#toLogin").setAttribute("href", "dashboard"); $("#toLogin").textContent = "← Back to Helm";
    if (BPStore.auth.hasPassword && !BPStore.auth.hasPassword()) {
      // Google-only account: there is no Helm password to confirm or change
      sub("You sign in to Helm with Google, so there's no Helm password to change. Manage your password in your Google account.");
      return;
    }
    sub("Signed in as " + (u.email || "") + ". First confirm your current password.");
    show("#vCurrent");
    $("#toLogin").setAttribute("href", "dashboard"); $("#toLogin").textContent = "← Back to Helm";
    if (window.HelmAuthUI) cap = HelmAuthUI.mountCaptcha($("#captcha"), { action: "reauth" });
    setTimeout(function () { $("#cur_pw").focus(); }, 50);
  }

  $("#vCurrent").addEventListener("submit", function (e) {
    e.preventDefault();
    guard($("#cur_go"), async function () {
      err(""); ok("");
      if (!$("#cur_pw").value) { err("Enter your current password."); return; }
      if (cap && !cap.token()) { err("Please complete the security check."); return; }
      try {
        await BPStore.auth.reverifyPassword($("#cur_pw").value, { captchaToken: cap ? cap.token() : undefined });
        $("#cur_pw").value = "";
        await toNewPassword();
      } catch (x) { err(friendly(x, "check your password")); }
      finally { if (cap) cap.reset(); }
    });
  });

  $("#vMfa").addEventListener("submit", function (e) {
    e.preventDefault();
    guard($("#mfa_go"), async function () {
      err("");
      try { await BPStore.auth.mfa.challenge($("#mfa_code").value); await toNewPassword(); }
      catch (x) { err(friendly(x, "verify the code")); $("#mfa_code").select(); }
    });
  });

  if (BPStore.auth.passwordRule && BPStore.auth.passwordRule.attachChecklist) BPStore.auth.passwordRule.attachChecklist($("#new_pw"), $("#newRules"));
  $("#vSet").addEventListener("submit", function (e) {
    e.preventDefault();
    guard($("#set_go"), async function () {
      err(""); ok("");
      var a = $("#new_pw").value, b = $("#new_pw2").value;
      var bad = BPStore.auth.passwordRule.problem(a);
      if (bad) { err(bad); $("#new_pw").focus(); return; }
      if (a !== b) { err("The two passwords don't match."); $("#new_pw2").focus(); return; }
      try {
        await BPStore.auth.updatePassword(a);   // also signs out every OTHER session
        $("#new_pw").value = ""; $("#new_pw2").value = "";
        if (recovering) {
          // reset via email: end this session too and sign in fresh with the new password
          BPStore.auth.recovery.clear();
          try { await BPStore.auth.signOut(); } catch (x) {}
          location.replace("login?reset=1");
          return;
        }
        show("#vDone"); $("#title").textContent = "Password changed";
        sub(""); ok("Your password was changed and your other devices were signed out.");
      } catch (x) { err(friendly(x, "save your new password")); }
    });
  });

  if (window.BPUI && BPUI.boot) BPUI.boot(start); else start();
})();
