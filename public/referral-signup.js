/* referral-signup.js - r29 referrals PHASE 1 (UI only) on the sign-up page (/signup, login.html).
   - Shows the optional "Referral or partner code" field only while the page is in owner sign-up mode (it follows
     #agreeRow, which login.html shows only then; never on sign-in or on a team-invite join).
   - A link with ?ref=CODE (helm.events/r/CODE redirects to /signup?ref=CODE; partner codes use ?ref= too) fills the
     field and shows a banner. Never ?code= : that name belongs to the sign-in provider's callback (PKCE auth code). The code is kept for this browser tab only (sessionStorage "helm.signup.ref") so it survives the e-mail
     confirm step; phase 2 sends it with the sign-up and the SERVER decides if it counts (never this file).
   - Demo (localhost + ?demo=1, referral-demo.js): recognises DEMO123 / SHAADISQ-7K2Q and the demo partner codes.
     Anywhere else a well-formed code is shown as "saved, checked after you verify your e-mail" - no network call.
   DOM via textContent only. */
(function () {
  "use strict";
  var R = window.HelmReferral; if (!R) return;
  var D = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(String(location.hostname || "")) ? window.HelmReferralDemo || null : null;
  var KEY = "helm.signup.ref";
  function $(id) { return document.getElementById(id); }
  var row = $("rfsRow"), inp = $("rfsCode"), msg = $("rfsMsg"), clr = $("rfsClear"), cRow = $("rfsConsentRow"), cBox = $("rfsConsent");
  var banner = $("rfsBanner"), bT = $("rfsBannerT"), bS = $("rfsBannerS"), agree = $("agreeRow");
  if (!row || !inp || !agree) return;

  function ssGet() { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) { return null; } }
  function ssSet(v) { try { if (v) sessionStorage.setItem(KEY, JSON.stringify(v)); else sessionStorage.removeItem(KEY); } catch (e) {} }
  var qs = new URLSearchParams(location.search);
  var fromLink = R.normalizeCode(qs.get("ref") || "");
  var saved = ssGet();
  var start = fromLink || (saved && R.normalizeCode(saved.code)) || "";

  function look(code) {
    if (!code) return null;
    if (D) return D.lookup[code] || { kind: "unknown" };
    return { kind: "pending" };
  }
  function say(text, tone) { msg.textContent = text; msg.className = "rfs-msg" + (tone ? " " + tone : ""); }
  function check() {
    var raw = inp.value.trim();
    clr.hidden = !raw;
    if (!raw) { say(""); cRow.hidden = true; ssSet(null); paintBanner(null, ""); return; }
    var code = R.normalizeCode(raw);
    if (!code) { say("Codes use letters, numbers, - and _ (3 to 24 characters).", "bad"); cRow.hidden = true; ssSet(null); return; }
    var hit = look(code);
    if (hit.kind === "referral") {
      say("Applied: 1 month free after your first payment. Referred by " + hit.studio + ".", "good");
      cRow.hidden = false;
    } else if (hit.kind === "partner") {
      var ok = R.partnerUsable(hit.partner, D && D.now);
      if (!ok.ok) { say(ok.why + " You can still sign up without it.", "bad"); cRow.hidden = true; ssSet(null); paintBanner(null, code); return; }
      var offer = R.partnerOffer(hit.partner);
      say(offer ? "Applied: " + offer + "." : "Code saved. Thanks for telling us where you heard about Helm.", "good");
      cRow.hidden = true;
    } else if (hit.kind === "unknown") {
      say("We don't recognise this code. Check the spelling, or sign up without it.", "bad"); cRow.hidden = true; ssSet(null); paintBanner(null, code); return;
    } else {
      say("Code saved. We check it after you verify your e-mail; if it is valid you get 1 month free after your first payment.", "");
      cRow.hidden = false;
    }
    ssSet({ code: code, consent: !!(cBox && cBox.checked && !cRow.hidden), at: Date.now(), via: code === fromLink ? "link" : "typed" });
    paintBanner(hit, code);
  }
  function paintBanner(hit, code) {
    if (!banner) return;
    var signup = !agree.hidden;
    if (!signup || !hit || !code || hit.kind === "unknown") { banner.hidden = true; return; }
    if (hit.kind === "referral") { bT.textContent = hit.studio + " invited you to Helm"; bS.textContent = "8 days free, then your first paid month free."; }
    else if (hit.kind === "partner") { bT.textContent = "Partner offer: " + code; bS.textContent = R.partnerOffer(hit.partner) || "Thanks for coming via " + hit.partner.name + "."; }
    else { bT.textContent = "Signing up with code " + code; bS.textContent = "If it is valid: 8 days free, then your first paid month free."; }
    banner.hidden = false;
  }
  function sync() {   /* show only in owner sign-up mode (agreeRow visible) */
    var signup = !agree.hidden;
    row.hidden = !signup;
    if (!signup) { banner.hidden = true; return; }
    check();
  }
  inp.value = start;
  inp.addEventListener("input", function () { var p = inp.selectionStart; inp.value = inp.value.toUpperCase(); try { inp.setSelectionRange(p, p); } catch (e) {} });
  inp.addEventListener("change", check);
  inp.addEventListener("blur", check);
  clr.addEventListener("click", function () { inp.value = ""; check(); inp.focus(); });
  if (cBox) cBox.addEventListener("change", check);
  new MutationObserver(sync).observe(agree, { attributes: true, attributeFilter: ["hidden"] });
  sync();
})();
