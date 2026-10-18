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
  var DAYS = 8;

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
  var api = { TRIAL_TZ: TRIAL_TZ, TRIAL_CUR: TRIAL_CUR, intentFrom: intentFrom, directFrom: directFrom, localeFor: localeFor, KEY: KEY, DKEY: DKEY, DAYS: DAYS };
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

  // called by login.html's setMode(m) after it has laid out the form
  function apply(mode, joining) {
    var link = doc.getElementById("trialLink");
    if (link) link.hidden = mode === "signup" || !!joining;
    if (joining) return;
    var tab = doc.querySelector('.mtab[data-mode="signup"]'); if (tab) tab.textContent = direct ? "Create studio" : "Start free trial";
    pathLink(mode);
    if (mode !== "signup") return;
    if (direct) {
      // 0159: the paid path - studio name required, the plan + payment come next on /checkout
      setText("#formTitle", "Create your studio");
      setText("#formSub", "Name your studio, then choose a plan and complete payment to start using Helm.");
      var ds = $("#studio"); if (ds) ds.required = true;
      var db = $("#submit"); if (db) db.textContent = "Create studio →";
      return;
    }
    var studio = $("#studio");
    if (studio) { studio.required = false; studio.placeholder = "e.g. Aurora Events — or leave empty"; if (studio.value === "Demo trial") studio.value = ""; }
    var lbl = doc.querySelector('label[for="studio"]');
    if (lbl) {
      while (lbl.firstChild) lbl.removeChild(lbl.firstChild);
      lbl.appendChild(doc.createTextNode("Studio / business name "));
      lbl.appendChild(el("span", "opt", "(optional)"));
    }
    setText("#formTitle", "Start your free trial");
    setText("#formSub", DAYS + " days free, no card needed. Leave the studio name empty and we'll call it “Demo N” — rename it any time.");
    var sb = $("#submit"); if (sb) sb.textContent = "Start free trial →";
  }

  // 0159: under the sign-up heading, a quiet link to the other way in
  function pathLink(mode) {
    var p = doc.getElementById("pathLink");
    if (!p) {
      var sub = $("#formSub"); if (!sub || !sub.parentNode) return;
      p = el("p", "sub path-link"); p.id = "pathLink";
      p.appendChild(el("a"));
      sub.parentNode.insertBefore(p, sub.nextSibling);
    }
    var a = p.querySelector("a");
    a.textContent = direct ? "Want to try Helm first? Start the " + DAYS + "-day free trial instead →"
      : "Ready to subscribe? Create your studio and choose a plan →";
    a.href = direct ? "login.html?trial=1#signup" : "login.html?direct=1#signup";
    p.hidden = mode !== "signup";
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
    return r;
  }

  function mountLinks() {
    var tabs = $(".modetabs");
    if (!tabs || doc.getElementById("trialLink")) return;
    var p = el("p", "sub"); p.id = "trialLink";
    var a = el("a", null, "New to Helm? Start your " + DAYS + "-day free trial →");
    a.href = "login.html?trial=1#signup";
    p.appendChild(a);
    tabs.parentNode.insertBefore(p, tabs.nextSibling);
    var signup = (global.location.hash || "").toLowerCase() === "#signup";
    // an invitee joins an existing studio: never offer them a new trial
    var invited = !!new URLSearchParams(global.location.search).get("invite");
    try { invited = invited || !!global.sessionStorage.getItem("bp_pending_invite"); } catch (e) {}
    p.hidden = signup || invited;
    if (direct) { setText("#obSub", "Name your studio, then choose a plan and complete payment to start using Helm."); return; }
    setText("#obTitle", "Start your free trial");
    var ob = $("#ob_submit"); if (ob) ob.textContent = "Start free trial →";
    var obl = doc.querySelector('label[for="ob_name"]');
    if (obl) { obl.appendChild(doc.createTextNode(" ")); obl.appendChild(el("span", "opt", "(optional)")); }
    var obn = $("#ob_name"); if (obn) { obn.required = false; obn.placeholder = "e.g. Aurora Events — or leave empty"; }
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mountLinks); else mountLinks();

  global.BPTrialSignup = { wanted: function () { return !direct; }, direct: function () { return direct; }, linked: function () { return linked; },
    apply: apply, start: start, clear: lsDel, clearDirect: dDel, intentFrom: intentFrom, directFrom: directFrom, localeFor: localeFor };
})(typeof window !== "undefined" ? window : globalThis);
