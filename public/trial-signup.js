/* =========================================================================
   HELM — the ONE self-serve free trial on the sign-in page (0116 → 0119)
   -------------------------------------------------------------------------
   Every new studio (Create-studio tab, ?trial=1 links, Google sign-up) gets the
   same 8-day free trial, no card:
     1. account created (studio name OPTIONAL — empty → the database names it "Demo N")
     2. 0180: no "demo or own data" question any more - every trial starts WITH the sample
        studio (every row "Demo ·"); the server ignores any other mode.
     3. start_self_serve_trial(name, Asia/Kolkata, INR, "demo") creates the studio + the
        trial; then the dashboard (welcome + tour; the profile step is not forced on a trial).
   An invitee (JOINING) never sees any of this. CSP: no inline styles / handlers;
   DOM via createElement/textContent.
   0159: the OTHER way in - "Create studio" directly (?direct=1, remembered like the trial
   link): no trial; after the studio exists the owner picks a plan and pays on /checkout
   before the app opens. The two sign-up forms link to each other.
   ========================================================================= */
(function (global) {
  "use strict";
  var KEY = "bp_trial_intent";
  var DKEY = "bp_direct_intent";   // 0159: "Create studio" directly (plan + payment, no trial)
  var TTL = 2 * 24 * 3600 * 1000;
  // 0207: the shared trial facts (public/trial-facts.js, loaded before this file; require() under node tests)
  var F = (typeof module !== "undefined" && module.exports && typeof require === "function") ? require("./trial-facts.js") : (global && global.HelmTrialFacts);
  var DAYS = F ? F.DAYS : 8;   // the fallback only keeps sign-up working if trial-facts.js failed to load

  // Pure (unit-tested): was the visitor sent here by a "Start free trial" link?
  //   search: location.search; stored: the localStorage value; now: Date.now()
  function intentFrom(search, stored, now) {
    var q = new URLSearchParams(String(search || ""));
    if (q.get("trial") === "1") return true;
    if (q.get("trial") === "0") return false;
    var t = Number(stored);
    return isFinite(t) && t > 0 && now - t >= 0 && now - t < TTL;
  }

  // 0159 (pure, unit-tested): did the visitor choose "Create studio" directly (no trial)?
  //   ?direct=1 → yes; ?trial=1 → no (the trial link wins); else a remembered choice within TTL
  function directFrom(search, stored, now) {
    var q = new URLSearchParams(String(search || ""));
    if (q.get("direct") === "1") return true;
    if (q.get("trial") === "1" || q.get("direct") === "0") return false;
    var t = Number(stored);
    return isFinite(t) && t > 0 && now - t >= 0 && now - t < TTL;
  }

  // 0180 (pure, unit-tested): the free trial is India only, so the currency is INR whatever the
  // browser time zone (no USD / AED / GBP guess any more); the server enforces the same.
  function localeFor() { return "INR"; }

  var TRIAL_TZ = "Asia/Kolkata", TRIAL_CUR = "INR";
  // Trial terms: "What's in your free trial" - shown on the trial sign-up screen BEFORE the account is made.
  // 0207: every number and rule comes from ONE shared module, public/trial-facts.js (HelmTrialFacts), the same
  // source as the welcome step "Your 8-day free trial" and terms.html #trial, so they never drift apart.
  // KEY = the 4 lines always visible; ALL = the "See all trial rules" list.
  var KEEP_DAYS = F ? F.KEEP_DAYS : 60;
  var TRIAL_KEY = F ? F.SIGNUP_KEY : [];
  var TRIAL_ALL = F ? F.SIGNUP_ALL : [];
  var api = { TRIAL_TZ: TRIAL_TZ, TRIAL_CUR: TRIAL_CUR, intentFrom: intentFrom, directFrom: directFrom, localeFor: localeFor, KEY: KEY, DKEY: DKEY, DAYS: DAYS,
    KEEP_DAYS: KEEP_DAYS, TRIAL_KEY: TRIAL_KEY, TRIAL_ALL: TRIAL_ALL };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  if (!global || !global.document) return;

  var doc = global.document;
  function lsGet() { try { return global.localStorage.getItem(KEY); } catch (e) { return null; } }
  function lsSet(v) { try { global.localStorage.setItem(KEY, v); } catch (e) {} }
  function lsDel() { try { global.localStorage.removeItem(KEY); } catch (e) {} }
  function dGet() { try { return global.localStorage.getItem(DKEY); } catch (e) { return null; } }
  function dSet(v) { try { global.localStorage.setItem(DKEY, v); } catch (e) {} }
  function dDel() { try { global.localStorage.removeItem(DKEY); } catch (e) {} }

  // a "Start free trial" link is remembered (survives the e-mail confirm / Google redirect)
  // only so the page opens on the sign-up tab; the trial itself is the same for everyone
  var linked = intentFrom(global.location.search, lsGet(), Date.now());
  if (new URLSearchParams(global.location.search).get("trial") === "1") lsSet(String(Date.now()));
  // 0159: remembered across the e-mail confirm / Google redirect, like the trial link
  var direct = directFrom(global.location.search, dGet(), Date.now());
  if (new URLSearchParams(global.location.search).get("direct") === "1") { dSet(String(Date.now())); lsDel(); }
  if (!direct) dDel();

  function $(s) { return doc.querySelector(s); }
  function setText(sel, t) { var el = $(sel); if (el) el.textContent = t; }
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  // Trial terms: the "What's in your free trial" panel (DOM only; styles in trial-terms.css)
  var SVGNS = "http://www.w3.org/2000/svg";
  function tick() {
    var s = doc.createElementNS(SVGNS, "svg"); s.setAttribute("viewBox", "0 0 16 16"); s.setAttribute("aria-hidden", "true"); s.setAttribute("focusable", "false");
    var pth = doc.createElementNS(SVGNS, "path"); pth.setAttribute("d", "M3.5 8.5l3 3 6-7"); s.appendChild(pth);
    var w = el("span", "tt-ic"); w.appendChild(s); return w;
  }
  function aLink(href, text) { var a = el("a", null, text); a.href = href; return a; }
  function termsPanel(id) {
    var box = el("section", "tt"); box.id = id; box.setAttribute("aria-labelledby", id + "H");
    var h = el("h2", "tt-h", "What’s in your free trial"); h.id = id + "H"; box.appendChild(h);
    var ul = el("ul", "tt-key");
    TRIAL_KEY.forEach(function (k) {
      var li = el("li"); li.appendChild(tick());
      var tx = el("span"); tx.appendChild(el("b", null, k.t)); tx.appendChild(el("span", null, k.s)); li.appendChild(tx);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    var det = el("details", "tt-more"); det.appendChild(el("summary", null, "See all trial rules"));
    var all = el("ul", "tt-all"); TRIAL_ALL.forEach(function (r) { all.appendChild(el("li", null, r)); });
    det.appendChild(all); box.appendChild(det);
    var lk = el("p", "tt-links"); lk.appendChild(doc.createTextNode("Full rules: "));
    lk.appendChild(aLink("/terms#trial", "Terms")); lk.appendChild(doc.createTextNode(" · "));
    lk.appendChild(aLink("/privacy", "Privacy Policy")); box.appendChild(lk);
    return box;
  }
  // the consent line under the form: same pattern as the page's "By continuing you agree to …" line
  var AGREE_TRIAL = "By starting the free trial you agree to the trial rules above, our";
  function agreeLead(on) {
    var a = doc.getElementById("agreeLead");
    if (!a) return;
    if (!a.getAttribute("data-default")) a.setAttribute("data-default", a.textContent);
    a.textContent = on ? AGREE_TRIAL : a.getAttribute("data-default");
  }
  function trialTerms(mode, joining) {
    var show = mode === "signup" && !joining && !direct && TRIAL_KEY.length > 0;
    var box = doc.getElementById("trialTerms");
    if (!box && show) {
      var after = doc.getElementById("pathLink") || $("#formSub");
      if (!after || !after.parentNode) return;
      box = termsPanel("trialTerms");
      after.parentNode.insertBefore(box, after.nextSibling);
    }
    if (box) box.hidden = !show;
    agreeLead(show);
  }

  // called by login.html's setMode(m) after it has laid out the form.
  // r22: ONE sign-up flow - step 1 is the account only (the studio, the plan and "free trial or pay now" come after the
  // e-mail is verified, signup-flow.js), so this only sets the step-1 words. The trial rules show on the plan step.
  function apply(mode, joining) {
    var link = doc.getElementById("trialLink");
    if (link) link.hidden = true;
    if (joining) { trialTerms(mode, joining); return; }
    trialTerms("signin", joining);   // never on step 1
    var pl = doc.getElementById("pathLink"); if (pl) pl.hidden = true;
    if (mode !== "signup") return;
    setText("#formTitle", "Create your Helm account");
    setText("#formSub", "Step 1 of 4. Next you verify your e-mail, name your studio and choose how to start: pay now, or try Helm free for " + DAYS + " days.");
    var sb = $("#submit"); if (sb) sb.textContent = "Create account →";
  }

  // 0177: the free trial is India only (INR, Asia/Kolkata, GST) whatever the visitor's browser says;
  // the server (start_self_serve_trial) enforces the same, this only keeps the request honest
  function visitorLocale() { return { timezone: TRIAL_TZ, currency: TRIAL_CUR }; }

  // makeStudio() in login.html: ONE call creates studio + trial + sample data (0180: there is no
  // "demo or own data" choice any more - every free trial starts with the sample studio)
  async function start(name) {
    var loc = visitorLocale();
    var r = await global.BPStore.trialOrg.startSelfServe({
      name: String(name || "").trim(), mode: "demo",
      timezone: loc.timezone, currency: loc.currency });
    lsDel();
    try { global.localStorage.setItem("bp_force_tour", "1"); } catch (e) {}
    // 0167: the dashboard first shows the short 2-step welcome (name the studio, invite up to 2), then the tour.
    // 0180: the server flags it too (organizations.trial_welcome_pending), so it also shows when the
    // e-mail confirm link is opened on another device; this browser flag is only the fallback.
    try { global.localStorage.setItem("bp_trial_welcome", String(Date.now())); } catch (e) {}
    // QA B26: the new studio IS a free trial - the very first app page is locked before first paint
    // (trial-early.js / shell-proto.js read this cached flag; trial-lock.js clears it if the server says otherwise)
    try { global.localStorage.setItem("helm.trial", "1"); } catch (e) {}
    return r;
  }

  // r22: no "Start your free trial" link and no trial-only studio form any more - one sign-up flow (signup-flow.js)
  function mountLinks() {}
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mountLinks); else mountLinks();

  global.BPTrialSignup = { termsPanel: termsPanel, wanted: function () { return !direct; }, direct: function () { return direct; }, linked: function () { return linked; },
    apply: apply, start: start, clear: lsDel, clearDirect: dDel, intentFrom: intentFrom, directFrom: directFrom, localeFor: localeFor };
})(typeof window !== "undefined" ? window : globalThis);
