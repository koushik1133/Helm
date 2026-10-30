/* referral-signup.js - r29 referrals on the sign-up page (/signup, login.html). Phase 2: the SERVER checks the code.
   - Shows the optional "Referral or partner code" field only while the page is in owner sign-up mode (it follows
     #agreeRow, which login.html shows only then; never on sign-in or on a team-invite join).
   - A link with ?ref=CODE (helm.events/r/CODE redirects to /signup?ref=CODE; partner codes use ?ref= too) fills the
     field and shows a banner. Never ?code= : that name belongs to the sign-in provider's callback (PKCE auth code).
   - The last link opened is remembered in THIS browser for 60 days (localStorage "helm.ref.link" = {code, at}; listed in
     the Cookie Policy as needed to deliver the referral the visitor asked for). A code TYPED in the field beats a link.
     The form's code + the consent box are kept for this tab (sessionStorage "helm.signup.ref") so they survive the
     e-mail confirm step; store-api.js sends them with the sign-up and attaches them once the studio exists
     (BPStore.referral.attachPending -> referral_attach). The server decides whether it counts - never this file.
   - The look-up (referral_lookup) works signed out and is rate-limited. r82 (0306): for a working STUDIO code it also
     returns the referring studio's name, shown as "You were referred by <studio>" (textContent only); partner codes never.
   - Opening a link counts one click (referral_click: a number per code per day, nothing about the person).
   - Demo (localhost + ?demo=1, referral-demo.js): recognises DEMO123 / SHAADISQ-7K2Q and the demo partner codes.
   DOM via textContent only. */
(function (run) { var g = window.HelmReferralDemoGate; if (g && g.wanted) g.ready.then(run); else run(); })(function () {
  "use strict";
  var R = window.HelmReferral; if (!R) return;
  var D = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(String(location.hostname || "")) ? window.HelmReferralDemo || null : null;
  var KEY = "helm.signup.ref", LINK = "helm.ref.link", DAY = 864e5;
  function $(id) { return document.getElementById(id); }
  var row = $("rfsRow"), inp = $("rfsCode"), msg = $("rfsMsg"), clr = $("rfsClear"), cRow = $("rfsConsentRow"), cBox = $("rfsConsent");
  var banner = $("rfsBanner"), bT = $("rfsBannerT"), bS = $("rfsBannerS"), agree = $("agreeRow");
  if (!row || !inp || !agree) return;

  function ssGet() { try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (e) { return null; } }
  function ssSet(v) { try { if (v) sessionStorage.setItem(KEY, JSON.stringify(v)); else sessionStorage.removeItem(KEY); } catch (e) {} }
  function lkGet() {
    try {
      var v = JSON.parse(localStorage.getItem(LINK) || "null");
      if (v && R.normalizeCode(v.code) && typeof v.at === "number" && Date.now() - v.at < R.RULES.linkDays * DAY) return v;
      localStorage.removeItem(LINK);
    } catch (e) {}
    return null;
  }
  function lkSet(code) { try { localStorage.setItem(LINK, JSON.stringify({ code: code, at: Date.now() })); } catch (e) {} }

  var qs = new URLSearchParams(location.search);
  var fromLink = R.normalizeCode(qs.get("ref") || "");
  if (fromLink) {
    lkSet(fromLink);   /* the last link opened wins */
    var ck = "helm.ref.clicked." + fromLink, seen = false;
    try { seen = sessionStorage.getItem(ck) === "1"; sessionStorage.setItem(ck, "1"); } catch (e) {}
    if (!seen && !D && window.BPStore && BPStore.referral) { try { BPStore.referral.click(fromLink); } catch (e) {} }
  }
  var link = lkGet();
  var linkCode = fromLink || (link && link.code) || "";
  var saved = ssGet();
  var start = (saved && R.normalizeCode(saved.code)) || linkCode || "";
  if (fromLink && !(saved && saved.via === "typed")) start = fromLink;

  var seq = 0;
  /* -> Promise<{kind: referral|partner|unknown|pending|refused, offer, why}> */
  function look(code) {
    if (!code) return Promise.resolve(null);
    if (D) {
      var h = D.lookup[code];
      if (!h) return Promise.resolve({ kind: "unknown" });
      if (h.kind === "partner") { var u = R.partnerUsable(h.partner, D.now); return Promise.resolve(u.ok ? { kind: "partner", offer: R.partnerOffer(h.partner), name: h.partner.name } : { kind: "refused", why: u.why }); }
      return Promise.resolve({ kind: "referral", offer: "1 free month after your first payment" });
    }
    if (!window.BPStore || !BPStore.referral) return Promise.resolve({ kind: "pending" });
    function once() { return BPStore.referral.lookup(code).catch(function () { return { ok: false, reason: "pending" }; }); }
    return once().then(function (r) {
      if (r && r.reason === "pending") return new Promise(function (res) { setTimeout(function () { once().then(res); }, 800); });
      return r;
    }).then(function (r) {
      r = r || {};
      if (r.ok) return { kind: r.kind === "partner" ? "partner" : "referral", offer: r.offer || "", terms: r.terms || "",
                        referrer: r.kind === "partner" ? "" : String(r.referrer || "").slice(0, 80) };   /* r82 (0306): who referred you */
      var why = { expired: "This code has expired.", full: "This code has reached its limit.", inactive: "This code is no longer active.",
                  off: "Referral codes are not open yet." }[r.reason];
      if (why) return { kind: "refused", why: why };
      if (r.reason === "unknown" || r.reason === "shape") return { kind: "unknown" };
      return { kind: "pending" };
    });
  }
  function say(text, tone) { msg.textContent = text; msg.className = "rfs-msg" + (tone ? " " + tone : ""); }
  function remember(code) {
    ssSet({ code: code, consent: !!(cBox && cBox.checked && !cRow.hidden), at: Date.now(), via: code === linkCode ? "link" : "typed" });
  }
  function check() {
    var raw = inp.value.trim();
    clr.hidden = !raw;
    if (!raw) { say(""); cRow.hidden = true; ssSet(null); paintBanner(null, ""); return; }
    var code = R.normalizeCode(raw);
    if (!code) { say("Codes use letters, numbers, - and _ (3 to 24 characters).", "bad"); cRow.hidden = true; ssSet(null); paintBanner(null, ""); return; }
    var my = ++seq;
    remember(code);
    look(code).then(function (hit) {
      if (my !== seq || !hit) return;
      if (hit.kind === "referral") {
        say("Applied: " + (hit.offer || "1 free month after your first payment") + ".", "good");
        cRow.hidden = false;
      } else if (hit.kind === "partner") {
        say(hit.offer ? "Applied: " + hit.offer + "." : "Code saved. Thanks for telling us where you heard about Helm.", "good");
        cRow.hidden = false;
      } else if (hit.kind === "refused") {
        say(hit.why + " You can still sign up without it.", "bad"); cRow.hidden = true; ssSet(null); paintBanner(null, code); return;
      } else if (hit.kind === "unknown") {
        say("We don't recognise this code. Check the spelling, or sign up without it.", "bad"); cRow.hidden = true; ssSet(null); paintBanner(null, code); return;
      } else {
        say("Code saved. We check it after you verify your e-mail; if it is valid you get 1 month free after your first payment.", "");
        cRow.hidden = false;
      }
      remember(code);
      paintBanner(hit, code);
    });
  }
  function paintBanner(hit, code) {
    if (!banner) return;
    var signup = !agree.hidden;
    if (!signup || !hit || !code || hit.kind === "unknown" || hit.kind === "refused") { banner.hidden = true; return; }
    if (hit.kind === "referral") { bT.textContent = hit.referrer ? "You were referred by " + hit.referrer : "A Helm studio invited you"; bS.textContent = "8 days free, then 1 free month after your first payment."; }
    else if (hit.kind === "partner") { bT.textContent = "Partner offer: " + code; bS.textContent = hit.offer ? hit.offer.charAt(0).toUpperCase() + hit.offer.slice(1) + "." : "Thanks for coming via this partner."; }
    else { bT.textContent = "Signing up with code " + code; bS.textContent = "If it is valid: 8 days free, then 1 free month after your first payment."; }
    banner.hidden = false;
  }
  function sync() {   /* show only in owner sign-up mode (agreeRow visible) */
    var signup = !agree.hidden;
    row.hidden = !signup;
    if (!signup) { banner.hidden = true; return; }
    check();
  }
  inp.value = start;
  if (saved && cBox) cBox.checked = saved.consent === true;
  inp.addEventListener("input", function () { var p = inp.selectionStart; inp.value = inp.value.toUpperCase(); try { inp.setSelectionRange(p, p); } catch (e) {} });
  inp.addEventListener("change", check);
  inp.addEventListener("blur", check);
  clr.addEventListener("click", function () { inp.value = ""; linkCode = ""; try { localStorage.removeItem(LINK); } catch (e) {} check(); inp.focus(); });
  if (cBox) cBox.addEventListener("change", function () { var c = R.normalizeCode(inp.value); if (c) remember(c); });
  new MutationObserver(sync).observe(agree, { attributes: true, attributeFilter: ["hidden"] });
  sync();
});
