/* =========================================================================
   HELM - the ONE sign-up flow (r22, owner: "like Slack / Notion / Zoho"), on the sign-in page:
     step 1  Your account   - name, e-mail + password (or Google), "I agree to the Terms + Privacy Policy" (required)
     step 2  Verify e-mail  - the "Check your inbox" card (email sign-ups; Google is already verified)
     step 3  Your studio    - studio name (+ the link it gets), city, team size, event types
     step 4  How to start   - plan cards (plan-cards.js): "Pay now" (primary) / "Try free for 8 days" / "Contact sales"
     then    Pay now / Contact sales -> /checkout (online payment, or UPI / bank details + payment pending until HQ
             activates) -> studio setup wizard; Try free -> the dashboard's 2-step trial welcome.
   Pricing / landing links deep-link here: /signup?plan=studio&mode=paid (mode trial | paid | sales; /signup redirects to
   /login?signup=1 with the query kept), or login?plan=studio&mode=paid#signup; the old
   ?trial=1 / ?direct=1 links still work. The Terms are recorded on the server (accept_account_terms, 0255) at the
   first signed-in step, also when the confirm link is opened in another browser (the account carries the "agreed" note).
   Every check that matters is on the server (0159 payment gate, 0186 one trial per e-mail, 0255 Terms + limits).
   CSP: DOM via createElement / textContent only.
   ========================================================================= */
(function (global) {
  "use strict";
  var KEY = "bp_signup_intent", TERMS_KEY = "bp_terms_agree", DETAILS_KEY = "bp_signup_details";
  var TTL = 2 * 24 * 3600 * 1000;
  var CODE_RE = /^[a-z0-9][a-z0-9_-]{1,39}$/;
  var EVENT_TYPES = [["wedding", "Weddings"], ["reception", "Receptions"], ["engagement", "Engagements"], ["birthday", "Birthdays"],
    ["corporate", "Corporate"], ["conference", "Conferences"], ["product_launch", "Product launches"], ["political", "Political"],
    ["concert", "Concerts"], ["festival", "Festivals"], ["other", "Other"]];
  var TEAM_SIZES = [["1", "Just me"], ["2-5", "2-5 people"], ["6-15", "6-15 people"], ["16-50", "16-50 people"], ["51+", "51+ people"]];

  // ---- pure helpers (unit-tested) ----
  function mode(v) { v = String(v || "").toLowerCase(); return v === "trial" || v === "paid" || v === "sales" ? v : ""; }
  // where the visitor came from: ?plan= & ?mode= (or the old ?trial=1 / ?direct=1), else a remembered choice (2 days)
  function intentFrom(search, hash, stored, now) {
    var q = new URLSearchParams(String(search || ""));
    var plan = String(q.get("plan") || "").toLowerCase(), m = mode(q.get("mode"));
    if (!m && q.get("trial") === "1") m = "trial";
    if (!m && q.get("direct") === "1") m = "paid";
    if (!CODE_RE.test(plan)) plan = "";
    var fromUrl = !!(plan || m);
    if (!fromUrl) {
      var s = null; try { s = JSON.parse(String(stored || "null")); } catch (e) { s = null; }
      if (s && typeof s === "object" && isFinite(Number(s.t)) && now - Number(s.t) >= 0 && now - Number(s.t) < TTL) {
        plan = CODE_RE.test(String(s.plan || "")) ? String(s.plan) : ""; m = mode(s.mode);
      }
    }
    // /signup redirects to /login?signup=1 (vercel.json + server.js keep the ?plan=&mode= query)
    var signup = String(hash || "").toLowerCase() === "#signup" || q.get("signup") === "1" || fromUrl;
    return { plan: plan, mode: m, signup: signup, fromUrl: fromUrl };
  }
  function onSignupPath(p) { return /^\/signup\/?$/.test(String(p || "")); }
  // the same rule as public.studio_slugify (the server then makes it unique: name-2, name-3 ...)
  function slugify(name) {
    var s = String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36).replace(/^-+|-+$/g, "");
    if (!s) return "studio";
    return s.length < 3 ? s + "-studio" : s;
  }
  function detailsCheck(d) {
    d = d && typeof d === "object" ? d : {};
    var name = String(d.name == null ? "" : d.name).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    var city = String(d.city == null ? "" : d.city).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    var team = TEAM_SIZES.some(function (t) { return t[0] === d.teamSize; }) ? d.teamSize : "";
    var codes = EVENT_TYPES.map(function (e) { return e[0]; });
    var types = (Array.isArray(d.eventTypes) ? d.eventTypes : []).filter(function (t, i, a) { return codes.indexOf(t) >= 0 && a.indexOf(t) === i; });
    var errors = {};
    if (name.length < 2) errors.name = "Please enter your studio or business name (at least 2 characters).";
    else if (name.length > 80) errors.name = "Please keep the studio name to 80 characters or fewer.";
    if (city.length > 80) errors.city = "Please keep the city to 80 characters or fewer.";
    return { ok: !Object.keys(errors).length, errors: errors, clean: { name: name, city: city, teamSize: team, eventTypes: types } };
  }
  // ticked "I agree" in THIS browser (stash) or on the account (sign-up note), within 2 days
  function agreedEarlier(stash, meta, now) {
    var s = null; try { s = JSON.parse(String(stash || "null")); } catch (e) { s = null; }
    if (s && isFinite(Number(s.t)) && now - Number(s.t) >= 0 && now - Number(s.t) < TTL) return s.src === "google" ? "google" : "signup";
    var at = meta && typeof meta === "object" ? Date.parse(String(meta.helm_terms_agreed_at || "")) : NaN;
    if (isFinite(at) && now - at >= -60000 && now - at < 30 * 24 * 3600 * 1000) return "signup";
    return "";
  }
  // a PAID studio (made with "Pay now" / "Contact sales") opens the studio setup once, after its plan is active:
  // not on a trial, created on the paid path, and the setup wizard never started -> its first page is the wizard
  function firstRun(org, account, inTrial) {
    if (inTrial || !org || typeof org !== "object") return null;
    if (!account || account.signup_source !== "direct") return null;
    var b = org.brand && typeof org.brand === "object" ? org.brand : {};
    var p = b.onboarding && typeof b.onboarding === "object" ? b.onboarding : {};
    if (p.completed_at || p.step || (Array.isArray(p.done) && p.done.length) || (Array.isArray(p.skipped) && p.skipped.length)) return null;
    return "onboarding.html?fresh=1";
  }
  // where "Pay now" / "Contact sales" go: /checkout with the plan picked (the page re-checks it), then the setup wizard
  function checkoutHref(plan, interval, sales) {
    var q = new URLSearchParams(); q.set("next", "onboarding.html?fresh=1");
    if (CODE_RE.test(String(plan || ""))) q.set("plan", String(plan));
    q.set("interval", interval === "yearly" ? "yearly" : "monthly");
    if (sales) q.set("sales", "signup");
    return "/checkout?" + q.toString();
  }
  // the trial / operator / limit answers the server gives, in plain words
  function startError(e) {
    var hint = String((e && e.hint) || ""), m = String((e && e.message) || "");
    if (hint === "trial_used" || /already used your free/i.test(m))
      return { kind: "trial_used", text: "You've already used your free Helm trial with this e-mail. Choose Pay now on a plan to open your studio, or contact sales." };
    if (hint === "rate_limited" || /too many attempts/i.test(m)) return { kind: "rate_limited", text: "Too many attempts - please wait a few minutes and try again." };
    if (hint === "terms_required" || hint === "terms_outdated" || /Terms/.test(m)) return { kind: "terms", text: "Please agree to the current Terms of Service and Privacy Policy, then try again." };
    if (/HQ accounts|operator/i.test(m)) return { kind: "operator", text: "Helm HQ accounts can't create a studio." };
    return { kind: "other", text: "" };
  }

  // r23: step 1's words follow where the visitor came from (?plan= & ?mode=) - pure, unit-tested.
  // planName: the plan's display name ("" = none/unknown); days: the trial length (trial-facts.js).
  // kind "neutral" = no mode: the caller keeps the generic words (trial-signup.js).
  var PLAN_NAMES = { starter: "Starter", studio: "Studio", enterprise: "Enterprise" };
  function planName(code, plans) {
    code = String(code || "").toLowerCase();
    if (!CODE_RE.test(code)) return "";
    var hit = (Array.isArray(plans) ? plans : []).filter(function (p) { return p && p.code === code; })[0];
    return hit && hit.name ? String(hit.name).slice(0, 60) : (PLAN_NAMES[code] || "");
  }
  function step1Copy(m, name, days) {
    m = mode(m); name = String(name || ""); days = Number(days) > 0 ? Math.round(Number(days)) : 8;
    var next = "Step 1 of 4: your account. Next you verify your e-mail and name your studio";
    if (m === "paid") return { kind: "paid", title: "Create your studio",
      sub: (name ? name + " plan" : "Your plan") + ", pay after setup. " + next + ", then pay to open it." };
    if (m === "trial") return { kind: "trial", title: "Start your " + days + "-day free trial",
      sub: "No payment needed. " + next + ", then your trial starts." };
    if (m === "sales") return { kind: "sales", title: "Talk to our sales team",
      sub: "Create a Helm account so our team can set up your " + (name ? name + " " : "") + "studio with you. " + next + ", then contact sales from the plan step." };
    return { kind: "neutral", title: "", sub: "" };
  }

  var api = { KEY: KEY, step1Copy: step1Copy, planName: planName, TERMS_KEY: TERMS_KEY, EVENT_TYPES: EVENT_TYPES, TEAM_SIZES: TEAM_SIZES, intentFrom: intentFrom, slugify: slugify,
    detailsCheck: detailsCheck, agreedEarlier: agreedEarlier, onSignupPath: onSignupPath, firstRun: firstRun, checkoutHref: checkoutHref, startError: startError, mode: mode };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (!global || !global.document) return;

  var doc = global.document;
  function $(s) { return doc.querySelector(s); }
  function el(tag, cls, text) { var n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function lsGet(k) { try { return global.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { global.localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { global.localStorage.removeItem(k); } catch (e) {} }
  function ssGet(k) { try { return global.sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { global.sessionStorage.setItem(k, v); } catch (e) {} }
  function S() { return global.BPStore; }

  var intent = intentFrom(global.location.search, global.location.hash, lsGet(KEY), Date.now());
  // /signup is a real address (vercel.json rewrite -> the sign-in page): it always opens the sign-up
  if (onSignupPath(global.location.pathname)) intent.signup = true;
  if (intent.fromUrl) lsSet(KEY, JSON.stringify({ plan: intent.plan, mode: intent.mode, t: Date.now() }));
  var ctx = null;          // hooks from login.html: { showView, routeSignedIn, showErr, hoEnd }
  var st = { details: null, plans: null, opts: null, interval: "monthly", plan: "", busy: false, termsOk: false, termsVersion: "" };

  function metaOf() { var u = (S() && S().auth.user && S().auth.user()) || {}; return u.user_metadata || {}; }
  function wantPlan() { return intent.plan || String(metaOf().helm_signup_plan || ""); }
  function wantMode() { return intent.mode || mode(metaOf().helm_signup_mode); }
  function stashTerms(src) { lsSet(TERMS_KEY, JSON.stringify({ t: Date.now(), src: src === "google" ? "google" : "signup" })); }

  // ---- step 3: your studio ----
  function fillStudioForm() {
    var f = $("#onboardForm"); if (!f || f.getAttribute("data-r22")) return;
    f.setAttribute("data-r22", "1");
    var ts = $("#ob_team"); if (ts && !ts.options.length) {
      var o0 = el("option", null, "Choose (optional)"); o0.value = ""; ts.appendChild(o0);
      TEAM_SIZES.forEach(function (t) { var o = el("option", null, t[1]); o.value = t[0]; ts.appendChild(o); });
    }
    var box = $("#ob_types"); if (box && !box.firstChild) {
      EVENT_TYPES.forEach(function (t) {
        var lab = el("label", "chip"); var cb = el("input"); cb.type = "checkbox"; cb.value = t[0]; cb.name = "event_type";
        lab.appendChild(cb); lab.appendChild(el("span", null, t[1])); box.appendChild(lab);
      });
    }
    var nm = $("#ob_name"); if (nm) nm.addEventListener("input", slugSoon);
  }
  var slugT = null, slugSeq = 0;
  function slugSoon() {
    var nm = $("#ob_name"), out = $("#ob_slug"); if (!nm || !out) return;
    var guess = slugify(nm.value); out.textContent = "helm.events/" + guess;
    clearTimeout(slugT);
    if (String(nm.value).trim().length < 2) return;
    var my = ++slugSeq;
    slugT = setTimeout(function () {
      var B = S(); if (!B || !B.signup || !B.signup.slugPreview) return;
      B.signup.slugPreview(nm.value).then(function (s) { if (my === slugSeq && s) out.textContent = "helm.events/" + s; }, function () {});
    }, 350);
  }
  async function termsCheck() {
    var B = S(), row = $("#obTermsRow"), cb = $("#ob_terms");
    st.termsOk = false;
    var t = null; try { t = B.signup ? await B.signup.termsStatus() : null; } catch (e) { t = null; }
    if (t && t.version) st.termsVersion = String(t.version);
    if (t && t.accepted === true) { st.termsOk = true; if (row) row.hidden = true; return; }
    var how = agreedEarlier(lsGet(TERMS_KEY), metaOf(), Date.now());
    if (t && how) {
      try { var r = await B.signup.acceptTerms(t.version, how); if (r && r.accepted) { st.termsOk = true; lsDel(TERMS_KEY); if (row) row.hidden = true; return; } } catch (e) {}
    }
    if (row) row.hidden = false; if (cb) cb.checked = !!how;
  }
  function readDetails() {
    var types = []; Array.prototype.forEach.call(doc.querySelectorAll('#ob_types input[type="checkbox"]'), function (c) { if (c.checked) types.push(c.value); });
    return detailsCheck({ name: ($("#ob_name") || {}).value, city: ($("#ob_city") || {}).value, teamSize: ($("#ob_team") || {}).value, eventTypes: types });
  }
  function restoreDetails() {
    var s = null; try { s = JSON.parse(ssGet(DETAILS_KEY) || "null"); } catch (e) { s = null; }
    if (!s) return;
    if (s.city && $("#ob_city") && !$("#ob_city").value) $("#ob_city").value = s.city;
    if (s.teamSize && $("#ob_team")) $("#ob_team").value = s.teamSize;
    (s.eventTypes || []).forEach(function (v) { var c = doc.querySelector('#ob_types input[value="' + String(v).replace(/[^a-z_]/g, "") + '"]'); if (c) c.checked = true; });
  }
  // called by login.html showOnboarding()
  async function showStudio() {
    fillStudioForm(); restoreDetails(); slugSoon();
    await termsCheck();
  }
  async function submitStudio() {
    var B = S(), err = $("#obErr"); err.hidden = true;
    var v = readDetails();
    var ferr = $("#ob_name_err"); if (ferr) { ferr.textContent = v.errors.name || ""; ferr.hidden = !v.errors.name; }
    if (!v.ok) { $("#ob_name").focus(); return; }
    if (!st.termsOk) {
      var cb = $("#ob_terms");
      if (!cb || !cb.checked) { ctx.showErr(err, "Please agree to the Terms of Service and Privacy Policy to continue."); if (cb) cb.focus(); return; }
      if (st.termsVersion && B.signup) {
        try { var r = await B.signup.acceptTerms(st.termsVersion, "signup"); if (r && r.accepted) st.termsOk = true; }
        catch (e) { ctx.showErr(err, startError(e).text || "We couldn't save your agreement - please try again."); return; }
      }
      if (!st.termsVersion) st.termsOk = true;   // older server (no 0255): the Terms are taken again on /checkout
    }
    st.details = v.clean;
    ssSet(DETAILS_KEY, JSON.stringify(v.clean));
    await showStart();
  }

  // ---- step 4: how to start ----
  async function showStart() {
    var B = S();
    ctx.showView("#startCard");
    doc.body.classList.add("su-wide");
    $("#stErr").hidden = true; $("#stOk").hidden = true;
    var u = (B.auth.user && B.auth.user()) || {}; $("#stEmail").textContent = u.email || "";
    $("#stStudio").textContent = st.details ? st.details.name : "";
    var o = null; try { o = B.signup ? await B.signup.planOptions() : null; } catch (e) { o = null; }
    st.opts = o || {};
    if (st.opts.terms_version && !st.termsVersion) st.termsVersion = String(st.opts.terms_version);
    var P = global.HelmPlanCards;
    st.plans = P.plansOr(st.opts.plans);
    st.plan = P.pickPlan(st.plans, wantPlan());
    var days = Number(st.opts.trial_days) > 0 ? Number(st.opts.trial_days) : ((global.HelmTrialFacts && global.HelmTrialFacts.DAYS) || 8);
    st.trialDays = days;
    $("#stLead").textContent = "Pay now to open your studio straight away, or try Helm free for " + days + " days - no payment needed.";
    var m = wantMode();
    if (m === "trial") { $("#stOk").textContent = "Your free trial is one tap away - choose “Try free for " + days + " days” on any plan."; $("#stOk").hidden = false; }
    renderCards();
    var rules = $("#stTrialRules");
    if (rules && !rules.getAttribute("data-on") && global.BPTrialSignup && global.BPTrialSignup.termsPanel) {
      rules.setAttribute("data-on", "1"); rules.appendChild(global.BPTrialSignup.termsPanel("stTrialTerms"));
    }
    setTimeout(function () { try { $("#stTitle").focus(); } catch (e) {} }, 60);
    if (m === "sales") salesPrompt();
  }
  // mode=sales (the pricing page's "Contact sales"): one clear button that opens the saved contact-sales form for that plan
  function salesPrompt() {
    var ok = $("#stOk"), P = global.HelmPlanCards, code = wantPlan();
    var plan = st.plans.filter(function (p) { return p.code === code; })[0] || P.plansOr([]).filter(function (p) { return p.code === code; })[0] || null;
    if (!plan) plan = st.plans.filter(function (p) { return p.code === st.plan; })[0] || st.plans[0];
    while (ok.firstChild) ok.removeChild(ok.firstChild);
    ok.appendChild(doc.createTextNode("Want to talk to our team first? We'll help you choose and set up " + plan.name + ". "));
    var b = el("button", "linkbtn st-sales", "Contact sales about " + plan.name + " \u2192"); b.type = "button"; b.id = "stSales";
    b.addEventListener("click", function () { go("sales", plan, null); });
    ok.appendChild(b); ok.hidden = false;
  }
  function renderCards() {
    var P = global.HelmPlanCards;
    P.render($("#stPlans"), { plans: st.plans, interval: st.interval, selected: st.plan, trial: true, trialDays: st.trialDays,
      onSelect: function (code) { if (st.busy) return; st.plan = code; renderCards(); },
      onPay: function (p, b) { go("pay", p, b); }, onTrial: function (p, b) { go("trial", p, b); }, onSales: function (p, b) { go("sales", p, b); } });
  }
  function busy(b, label) {
    st.busy = true;
    Array.prototype.forEach.call(doc.querySelectorAll("#stPlans button"), function (x) { x.disabled = true; });
    if (b) { b.setAttribute("aria-busy", "true"); while (b.firstChild) b.removeChild(b.firstChild); b.appendChild(el("span", "spin")); b.appendChild(el("span", null, label)); }
  }
  function unbusy() { st.busy = false; renderCards(); }
  async function go(kind, p, b) {
    if (st.busy || !st.details) return;
    var B = S(), err = $("#stErr"); err.hidden = true; $("#stOk").hidden = true;
    st.plan = p.code;
    var d = st.details;
    try {
      if (await B.auth.operatorToHq()) return;   // a Helm operator never gets a studio (the server refuses too)
      if (kind === "trial") {
        busy(b, "Setting up your free trial…");
        await global.BPTrialSignup.start(d.name);
        try { await B.signup.saveDetails(d); } catch (e) {}
        lsDel(KEY);
        await ctx.routeSignedIn();
        return;
      }
      busy(b, kind === "pay" ? "Creating your studio…" : "Opening contact sales…");
      var r = await B.signup.createDirect({ name: d.name, plan: p.code, interval: st.interval, termsVersion: st.termsVersion });
      try { await B.signup.saveDetails(d); } catch (e) {}
      lsDel(KEY);
      try { global.localStorage.setItem("bp_force_tour", "1"); } catch (e) {}
      if (r && r.result === "exists") { await ctx.routeSignedIn(); return; }
      global.location.replace(checkoutHref(p.code, st.interval, kind === "sales"));
    } catch (e) {
      unbusy();
      var x = startError(e);
      ctx.showErr(err, x.text || (global.BPUI ? global.BPUI.friendlyError(e, { action: "create your studio" }) : "Something went wrong. Please try again."));
      if (x.kind === "trial_used") Array.prototype.forEach.call(doc.querySelectorAll("#stPlans .pc-trial"), function (t) { t.disabled = true; });
    }
  }
  function wire(hooks) {
    ctx = hooks;
    Array.prototype.forEach.call(doc.querySelectorAll('#startCard input[name="st_interval"]'), function (r) {
      r.addEventListener("change", function () { if (!r.checked) return; st.interval = r.value === "yearly" ? "yearly" : "monthly";
        $("#stIvM").classList.toggle("on", st.interval === "monthly"); $("#stIvY").classList.toggle("on", st.interval === "yearly"); renderCards(); });
    });
    var back = $("#stBack"); if (back) back.addEventListener("click", function () { doc.body.classList.remove("su-wide"); ctx.showView("#onboardForm"); });
  }

  // r23: called by login.html's setMode() after trial-signup.js has laid out step 1. Tailors the heading to
  // ?mode= (paid / trial / sales), shows the chosen plan as a chip with a "change" link back to /pricing, and on
  // mode=sales offers the no-account route (the home page's contact form, which only opens the visitor's e-mail app).
  function applyStep1(m, joining) {
    var on = m === "signup" && !joining;
    var chip = doc.getElementById("planChip"), note = doc.getElementById("salesNote");
    if (!on) { if (chip) chip.hidden = true; if (note) note.hidden = true; return; }
    var plans = global.HelmPlanCards && global.HelmPlanCards.plansOr ? global.HelmPlanCards.plansOr([]) : [];
    // only what THIS link says (a bare /signup stays neutral even if an older pricing click is remembered)
    var name = intent.fromUrl ? planName(intent.plan, plans) : "";
    var days = global.HelmTrialFacts && global.HelmTrialFacts.DAYS;
    var c = step1Copy(intent.fromUrl ? intent.mode : "", name, days);
    var sub = $("#formSub");
    if (c.kind !== "neutral") {
      var t = $("#formTitle"); if (t) t.textContent = c.title;
      if (sub) sub.textContent = c.sub;
    }
    if (!sub || !sub.parentNode) return;
    if (name) {
      if (!chip) {
        chip = el("p", "plan-chip"); chip.id = "planChip";
        chip.appendChild(el("span", "plan-chip-l", "Plan"));
        chip.appendChild(el("b", "plan-chip-n"));
        var a = el("a", "plan-chip-x", "change"); a.href = "/pricing"; a.setAttribute("aria-label", "Change plan (opens the pricing page)");
        chip.appendChild(a);
        sub.parentNode.insertBefore(chip, sub.nextSibling);
      }
      chip.querySelector(".plan-chip-n").textContent = name + (c.kind === "trial" ? " · free trial" : c.kind === "sales" ? " · talk to sales" : "");
      chip.hidden = false;
    } else if (chip) chip.hidden = true;
    if (c.kind === "sales") {
      if (!note) {
        note = el("p", "sales-note"); note.id = "salesNote";
        note.appendChild(doc.createTextNode("Rather talk first, without an account? "));
        var l = el("a", "", "Write to our sales team \u2192"); l.href = "/#contact"; note.appendChild(l);
        var anchor = chip && !chip.hidden ? chip : sub;
        anchor.parentNode.insertBefore(note, anchor.nextSibling);
      }
      note.hidden = false;
    } else if (note) note.hidden = true;
  }

  global.BPSignupFlow = Object.assign({}, api, { intent: function () { return intent; }, wantMode: wantMode, wantPlan: wantPlan, applyStep1: applyStep1,
    stashTerms: stashTerms, wire: wire, showStudio: showStudio, submitStudio: submitStudio, showStart: showStart,
    clearIntent: function () { lsDel(KEY); } });
})(typeof window !== "undefined" ? window : globalThis);
