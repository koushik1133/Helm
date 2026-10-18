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
  // Trial terms: "What's in your free trial" - shown on the trial sign-up screen BEFORE the account is made.
  // Plain words for docs/trial/POST-TRIAL-POLICY.md + docs/trial/TRIAL-END-TO-END.md (same rules as
  // terms.html #trial). KEY = the 4 lines always visible; ALL = the "See all trial rules" list.
  var KEEP_DAYS = 60, TEAM_EXTRA = 2, CREATE_CAP = 2;
  var TRIAL_KEY = [
    { t: DAYS + " days free, no card", s: "An India studio: prices in ₹, times in IST." },
    { t: "Ready-made sample data", s: "Sample events, leads, inventory, vendors, staff, venues, menus and layouts, all marked “Demo”." },
    { t: "You + up to " + TEAM_EXTRA + " teammates", s: "No real messages go to clients during the trial (test mode)." },
    { t: "After " + DAYS + " days: read-only", s: "Your data is kept " + KEEP_DAYS + " days, then deleted (we remind you first). Choose a plan anytime to keep everything." }
  ];
  var TRIAL_ALL = [
    DAYS + " days free. No card needed to start.",
    "Your trial studio is set up for India: prices in ₹ (INR), times in IST (Asia/Kolkata).",
    "It starts with ready-made sample data: sample events, leads, inventory, vendors, staff, venues, menus and layouts. Every sample record is marked “Demo”.",
    "You plus up to " + TEAM_EXTRA + " teammates can use the trial studio.",
    "You can add up to " + CREATE_CAP + " new records of each kind (leads, events, inventory items, vendors, staff and venues). Sample records do not count, and deleting a record does not free a slot.",
    "Menu prices are editable. New dishes, menu packages, chair or plate types cannot be added during the trial.",
    "Test mode: no real e-mails, WhatsApp or SMS messages are sent to clients during the trial.",
    "Downloads (PDF, CSV, prints), imports and photo renders unlock on a paid plan.",
    "After " + DAYS + " days the studio becomes read-only: you and your teammates can still look, but nobody can add or change anything until you choose a plan.",
    "Your trial data is kept for " + KEEP_DAYS + " days after the trial ends, then permanently deleted. We e-mail you reminders before that (30, 7 and 1 day before).",
    "One free trial per e-mail address.",
    "Choose a plan anytime to keep everything and carry on where you left off."
  ];
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
    var show = mode === "signup" && !joining && !direct;
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

  // called by login.html's setMode(m) after it has laid out the form
  function apply(mode, joining) {
    var link = doc.getElementById("trialLink");
    if (link) link.hidden = mode === "signup" || !!joining;
    if (joining) { trialTerms(mode, joining); return; }
    var tab = doc.querySelector('.mtab[data-mode="signup"]'); if (tab) tab.textContent = direct ? "Create studio" : "Start free trial";
    pathLink(mode);
    trialTerms(mode, joining);   // after pathLink: the panel sits right under the "Ready to subscribe?" link
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
    // QA B26: the new studio IS a free trial - the very first app page is locked before first paint
    // (trial-early.js / shell-proto.js read this cached flag; trial-lock.js clears it if the server says otherwise)
    try { global.localStorage.setItem("helm.trial", "1"); } catch (e) {}
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
    // Trial terms: a Google sign-up lands here before the studio is made: the same trial rules + consent line
    var obForm = doc.getElementById("onboardForm"), obBtn = $("#ob_submit");
    if (obForm && obBtn && !doc.getElementById("obTrialTerms")) {
      obForm.insertBefore(termsPanel("obTrialTerms"), obBtn);
      var ag = el("p", "tt-agree"); ag.id = "obAgree";
      ag.appendChild(doc.createTextNode(AGREE_TRIAL + " "));
      ag.appendChild(aLink("/terms", "Terms")); ag.appendChild(doc.createTextNode(" & "));
      ag.appendChild(aLink("/privacy", "Privacy Policy")); ag.appendChild(doc.createTextNode("."));
      obForm.insertBefore(ag, obBtn.nextSibling);
    }
  }
  if (doc.readyState === "loading") doc.addEventListener("DOMContentLoaded", mountLinks); else mountLinks();

  global.BPTrialSignup = { wanted: function () { return !direct; }, direct: function () { return direct; }, linked: function () { return linked; },
    apply: apply, start: start, clear: lsDel, clearDirect: dDel, intentFrom: intentFrom, directFrom: directFrom, localeFor: localeFor };
})(typeof window !== "undefined" ? window : globalThis);
