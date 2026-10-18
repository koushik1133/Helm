/* =========================================================================
   HELM — the ONE self-serve free trial on the sign-in page (0116 → 0119)
   -------------------------------------------------------------------------
   Every new studio (Create-studio tab, ?trial=1 links, Google sign-up) gets the
   same 8-day free trial, no card:
     1. account created (studio name OPTIONAL — empty → the database names it "Demo N")
     2. FIRST, right after the account exists: "How would you like to start?"
          Try with demo data  → the sample studio is seeded (every row "Demo ·")
          Start with my own data → nothing is seeded
     3. start_self_serve_trial(name, visitor time zone, currency, mode) creates the
        studio + the trial; then the usual profile step and the dashboard.
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

  // Visitor's own time zone + a currency guessed from it (0118). Unknown -> USD.
  function localeFor(tz) {
    tz = String(tz || "");
    if (/^Asia\/(Kolkata|Calcutta)$/.test(tz)) return "INR";
    if (/^Asia\/(Dubai|Muscat)$/.test(tz)) return "AED";
    if (/^Europe\/(London|Belfast)$/.test(tz)) return "GBP";
    if (/^Asia\/Singapore$/.test(tz)) return "SGD";
    if (/^Australia\//.test(tz)) return "AUD";
    if (/^America\/(Toronto|Vancouver|Edmonton|Winnipeg|Halifax|St_Johns|Regina)$/.test(tz)) return "CAD";
    if (/^Europe\//.test(tz)) return "EUR";
    return "USD";
  }

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

  /* ---- step 1 after the account exists: demo data or own data ---------------- */
  var chosen = null;
  function chooseStart() {
    if (chosen) return Promise.resolve(chosen);
    return new Promise(function (resolve) {
      var main = $("main") || doc.body;
      var shown = Array.prototype.filter.call(main.querySelectorAll(":scope > .card"), function (c) { return !c.hidden; });
      shown.forEach(function (c) { c.hidden = true; c.setAttribute("data-tc-hid", ""); });
      var card = el("section", "card tc-card"); card.id = "trialChoice";
      card.setAttribute("aria-labelledby", "tcTitle");
      card.appendChild(el("div", "mmk"));
      card.appendChild(el("span", "tc-tag", "Free trial · " + DAYS + " days"));
      var h = el("h1", null, "How would you like to start?"); h.id = "tcTitle"; h.tabIndex = -1; card.appendChild(h);
      card.appendChild(el("p", "sub", "Your account is ready. You can switch at any time during your " + DAYS + "-day free trial."));
      var err = el("div", "err"); err.setAttribute("role", "alert"); err.hidden = true; err.id = "tcErr"; card.appendChild(err);
      function opt(mode, title, body) {
        var b = el("button", "tc-opt"); b.type = "button"; b.setAttribute("data-mode", mode);
        b.appendChild(el("b", null, title)); b.appendChild(el("span", null, body));
        b.addEventListener("click", function () {
          if (card.getAttribute("aria-busy") === "true") return;
          card.setAttribute("aria-busy", "true");
          Array.prototype.forEach.call(card.querySelectorAll(".tc-opt"), function (x) { x.disabled = true; });
          b.classList.add("on");
          var t = b.querySelector("b"); if (t) t.textContent = "Setting up your studio…";
          chosen = mode; resolve(mode);
        });
        return b;
      }
      card.appendChild(opt("demo", "Try with demo data",
        "Explore a ready sample studio: leads, quotes in every stage, a confirmed wedding, venues, menu packages, stock, staff and vendors. Everything is marked “Demo ·” and nothing is sent to anyone."));
      card.appendChild(opt("own", "Start with my own data",
        "An empty studio with Helm's default templates and catalogs — add your own events, clients and team."));
      main.appendChild(card);
      try { h.focus(); } catch (e) {}
    });
  }
  // after a failure: put the page back the way it was (the caller shows the error)
  function undoChoice() {
    chosen = null;
    var card = doc.getElementById("trialChoice"); if (card) card.remove();
    Array.prototype.forEach.call(doc.querySelectorAll("[data-tc-hid]"), function (c) { c.hidden = false; c.removeAttribute("data-tc-hid"); });
  }

  // makeStudio() in login.html: choose first, then ONE call creates studio + trial (+ sample)
  async function start(name, opts) {
    opts = opts || {};
    var mode = await chooseStart();
    var loc = visitorLocale();
    try {
      var r = await global.BPStore.trialOrg.startSelfServe({
        name: String(name || "").trim(), mode: mode,
        timezone: loc.timezone, currency: loc.currency });
      lsDel();
      try { global.localStorage.setItem("bp_force_tour", "1"); } catch (e) {}
      // 0167: the dashboard first shows the short 2-step welcome (name the studio, invite up to 2), then the tour
      // 0177: every trial (demo OR own data) gets it; trials never go through the full studio setup
      try { global.localStorage.setItem("bp_trial_welcome", String(Date.now())); } catch (e) {}
      return r;
    } catch (e) { undoChoice(); throw e; }
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
    apply: apply, start: start, chooseStart: chooseStart, clear: lsDel, clearDirect: dDel, intentFrom: intentFrom, directFrom: directFrom, localeFor: localeFor };
})(typeof window !== "undefined" ? window : globalThis);
