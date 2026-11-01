/* =========================================================================
   HELM - the ONE sign-up flow (r22, owner: "like Slack / Notion / Zoho"), on the sign-in page:
     step 1  Your account   - name, e-mail + password (or Google), "I agree to the Terms + Privacy Policy" (required)
     step 2  Verify e-mail  - the "Check your inbox" card (email sign-ups; Google is already verified)
     step 3  Your studio    - studio name (+ the link it gets), city, team size, event types
     step 4  How to start   - plan cards (plan-cards.js): "Pay now" (when switched on) / "Contact sales"; below the cards
             ONE "Start your free 8-day trial" (r105: one trial per account, not tied to a plan)
     then    Pay now -> /checkout -> studio setup wizard; free trial -> the dashboard's 2-step trial welcome;
             r105: Contact sales -> a sales request for the ACCOUNT (0315), NO studio, and the "our team will contact
             you" page (trial meanwhile, or "set up your studio" once sales agreed the plan -> /checkout pending).
   Pricing / landing links deep-link here: /signup?plan=studio&mode=paid (mode trial | paid | sales; /signup redirects to
   /login?signup=1 with the query kept), or login?plan=studio&mode=paid#signup; the old
   ?trial=1 / ?direct=1 links still work. The Terms are recorded on the server (accept_account_terms, 0255) at the
   first signed-in step, also when the confirm link is opened in another browser (the account carries the "agreed" note).
   r24: config.js HELM_FEATURES.payNow (false for now) hides "Pay now" on the plan cards; while it is off a ?mode=paid
   link reads as Contact sales (payGate) and every word about paying now is swapped for the sales wording.
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
  // r24: with Pay now switched off a "paid" link falls back to the sales framing
  function payGate(m, payOn) { m = mode(m); return m === "paid" && !payOn ? "sales" : m; }
  function payOn() { var P = global && global.HelmPlanCards; return !!(P && P.payNowOn ? P.payNowOn() : (global && global.HELM_FEATURES && global.HELM_FEATURES.payNow === true)); }
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
  // r105: d.country (IN / AE / US, default IN), d.state (required for India: GST), d.city (required: the trial welcome
  //   and Studio setup reuse it); inStates = the India state list (HelmCountry) when known - the server checks it too
  function detailsCheck(d, inStates) {
    d = d && typeof d === "object" ? d : {};
    var name = String(d.name == null ? "" : d.name).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    var city = String(d.city == null ? "" : d.city).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    var team = TEAM_SIZES.some(function (t) { return t[0] === d.teamSize; }) ? d.teamSize : "";
    var codes = EVENT_TYPES.map(function (e) { return e[0]; });
    var types = (Array.isArray(d.eventTypes) ? d.eventTypes : []).filter(function (t, i, a) { return codes.indexOf(t) >= 0 && a.indexOf(t) === i; });
    var errors = {};
    if (name.length < 2) errors.name = "Please enter your studio or business name (at least 2 characters).";
    else if (name.length > 80) errors.name = "Please keep the studio name to 80 characters or fewer.";
    var country = String(d.country == null || d.country === "" ? "IN" : d.country).trim().toUpperCase();
    if (!/^(IN|AE|US)$/.test(country)) { errors.country = "Please choose your country."; country = "IN"; }
    var state = String(d.state == null ? "" : d.state).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    if (country === "IN" && !state) errors.state = "Please choose your state (needed for GST).";
    else if (country === "IN" && Array.isArray(inStates) && inStates.length && inStates.indexOf(state) < 0) errors.state = "Please choose a state from the list.";
    if (city.length < 2) errors.city = "Please enter your city.";
    else if (city.length > 80) errors.city = "Please keep the city to 80 characters or fewer.";
    return { ok: !Object.keys(errors).length, errors: errors, clean: { name: name, city: city, state: state, country: country, teamSize: team, eventTypes: types } };
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
  function startError(e, pay) {
    var on = typeof pay === "boolean" ? pay : payOn();
    var hint = String((e && e.hint) || ""), m = String((e && e.message) || "");
    if (hint === "trial_used" || /already used your free/i.test(m))
      return { kind: "trial_used", text: on ? "You've already used your free Helm trial with this e-mail. Choose Pay now on a plan to open your studio, or contact sales."
        : "You've already used your free Helm trial with this e-mail. Choose Contact sales on a plan and our team sets up your studio with you." };
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

  // r25: the line under the cards - GST only for rupee prices
  function currencyNote(cur, pay) {
    if (cur && cur !== "INR") return "Prices are in US dollars. " + (pay ? "Pay now shows the exact amount before anything is charged."
      : "Our team confirms the exact amount before anything is charged. Nothing is paid on this page.");
    return pay ? "Prices are before GST. Pay now shows the exact amount, tax included, before anything is charged. While online payment is being switched on you pay by UPI or bank transfer and your studio opens as soon as our team confirms the payment."
      : "Prices are before GST. Our team confirms the exact amount, tax included, before anything is charged. Nothing is paid on this page.";
  }
  var api = { currencyNote: currencyNote, KEY: KEY, step1Copy: step1Copy, payGate: payGate, payOn: payOn, planName: planName, TERMS_KEY: TERMS_KEY, EVENT_TYPES: EVENT_TYPES, TEAM_SIZES: TEAM_SIZES, intentFrom: intentFrom, slugify: slugify,
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
  function wantMode() { return payGate(intent.mode || mode(metaOf().helm_signup_mode), payOn()); }
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
    var cs = $("#ob_country"), H = global.HelmCountry;
    if (cs && !cs.options.length) {
      (H && H.list ? H.list() : [{ code: "IN", name: "India" }]).forEach(function (c) { var o = el("option", null, c.name); o.value = c.code; cs.appendChild(o); });
      cs.value = "IN";
      cs.addEventListener("change", function () { locForm(cs.value); });
    }
    locForm(cs ? cs.value : "IN");
  }
  function inStates() { var H = global.HelmCountry; try { return H ? H.get("IN").regions.map(function (r) { return r.name; }) : []; } catch (e) { return []; } }
  // r105: India -> a State dropdown (GST); elsewhere a free-text region (Emirate / State)
  function locForm(cc) {
    var H = global.HelmCountry, sel = $("#ob_state"), txt = $("#ob_state_t"), lab = $("#ob_state_l"); if (!sel || !txt) return;
    var p = null; try { p = H ? H.get(cc) : null; } catch (e) { p = null; }
    if (lab && lab.firstChild) lab.firstChild.nodeValue = ((p && p.regionLabel) || "State") + " ";
    var india = cc === "IN";
    var rq = lab ? lab.querySelector(".req") : null; if (rq) rq.hidden = !india;   // the region is required only in India (GST)
    sel.hidden = !india; txt.hidden = india; sel.required = india; txt.required = false;
    if (india && !sel.options.length) {
      var o0 = el("option", null, "Choose your state"); o0.value = ""; sel.appendChild(o0);
      inStates().forEach(function (n) { var o = el("option", null, n); o.value = n; sel.appendChild(o); });
    }
    if (!india) { txt.placeholder = p && p.regions && p.regions[0] ? "e.g. " + p.regions[0].name : ""; }
  }
  var slugT = null, slugSeq = 0;
  function slugSoon() {
    var nm = $("#ob_name"), out = $("#ob_slug"); if (!nm || !out) return;
    // r23 (0257): the link shows twice - under the name and in "this name and your link can't be changed later"
    var paint = function (t) { out.textContent = t; var o2 = $("#ob_slug2"); if (o2) o2.textContent = t; };
    var guess = slugify(nm.value); paint("helm.events/" + guess);
    clearTimeout(slugT);
    if (String(nm.value).trim().length < 2) return;
    var my = ++slugSeq;
    slugT = setTimeout(function () {
      var B = S(); if (!B || !B.signup || !B.signup.slugPreview) return;
      B.signup.slugPreview(nm.value).then(function (s) { if (my === slugSeq && s) paint("helm.events/" + s); }, function () {});
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
    var cc = ($("#ob_country") || {}).value || "IN";
    var stv = cc === "IN" ? ($("#ob_state") || {}).value : ($("#ob_state_t") || {}).value;
    return detailsCheck({ name: ($("#ob_name") || {}).value, city: ($("#ob_city") || {}).value, country: cc, state: stv,
      teamSize: ($("#ob_team") || {}).value, eventTypes: types }, inStates());
  }
  function restoreDetails() {
    var s = null; try { s = JSON.parse(ssGet(DETAILS_KEY) || "null"); } catch (e) { s = null; }
    if (!s) return;
    // r110: the studio name comes back too (a reload on step 3 / 4 kept everything except the name)
    if (s.name && $("#ob_name") && !$("#ob_name").value) $("#ob_name").value = String(s.name).slice(0, 80);
    if (s.city && $("#ob_city") && !$("#ob_city").value) $("#ob_city").value = s.city;
    if (s.country && $("#ob_country")) { $("#ob_country").value = s.country; locForm(s.country); }
    if (s.state) { if (s.country === "IN" || !s.country) { if ($("#ob_state")) $("#ob_state").value = s.state; } else if ($("#ob_state_t")) $("#ob_state_t").value = s.state; }
    if (s.teamSize && $("#ob_team")) $("#ob_team").value = s.teamSize;
    (s.eventTypes || []).forEach(function (v) { var c = doc.querySelector('#ob_types input[value="' + String(v).replace(/[^a-z_]/g, "") + '"]'); if (c) c.checked = true; });
  }
  // r110: step-3 answers are kept in this tab while they are typed (sessionStorage, best effort), so a reload never loses
  // them; "at4" = step 3 was completed, so a reload on step 4 comes back to step 4 (Back clears it)
  function draftSave(extra) {
    var prev = null; try { prev = JSON.parse(ssGet(DETAILS_KEY) || "null"); } catch (e) { prev = null; }
    var types = []; Array.prototype.forEach.call(doc.querySelectorAll('#ob_types input[type="checkbox"]'), function (c) { if (c.checked) types.push(c.value); });
    var cc = ($("#ob_country") || {}).value || "IN";
    var d = { name: String(($("#ob_name") || {}).value || "").slice(0, 80), city: String(($("#ob_city") || {}).value || "").slice(0, 80), country: cc,
      state: String((cc === "IN" ? ($("#ob_state") || {}).value : ($("#ob_state_t") || {}).value) || "").slice(0, 60),
      teamSize: ($("#ob_team") || {}).value || "", eventTypes: types };
    ssSet(DETAILS_KEY, JSON.stringify(Object.assign({}, prev || {}, d, extra || {})));
  }
  var draftWired = false;
  // called by login.html showOnboarding()
  async function showStudio() {
    fillStudioForm(); restoreDetails(); slugSoon();
    var f = $("#onboardForm");
    if (f && !draftWired) { draftWired = true; f.addEventListener("input", function () { draftSave({ at4: false }); }); f.addEventListener("change", function () { draftSave({ at4: false }); }); }
    await termsCheck();
    var saved = null; try { saved = JSON.parse(ssGet(DETAILS_KEY) || "null"); } catch (e) { saved = null; }
    if (saved && saved.at4 === true && st.termsOk) {
      var v = readDetails();
      if (v.ok) { st.details = v.clean; await showStart(); }
    }
  }
  async function submitStudio() {
    var B = S(), err = $("#obErr"); err.hidden = true;
    var v = readDetails();
    var ferr = $("#ob_name_err"); if (ferr) { ferr.textContent = v.errors.name || ""; ferr.hidden = !v.errors.name; }
    var lerr = $("#ob_loc_err"), lmsg = v.errors.country || v.errors.state || v.errors.city || "";
    if (lerr) { lerr.textContent = lmsg; lerr.hidden = !lmsg; }
    if (!v.ok) {
      var f = v.errors.name ? $("#ob_name") : v.errors.country ? $("#ob_country") : v.errors.state ? ($("#ob_country").value === "IN" ? $("#ob_state") : $("#ob_state_t")) : $("#ob_city");
      if (f) f.focus(); return;
    }
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
    ssSet(DETAILS_KEY, JSON.stringify(Object.assign({}, v.clean, { at4: true })));
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
    var P = global.HelmPlanCards, tz = P.browserZone ? P.browserZone() : "";
    // r110 (QA B3): the country chosen in step 3 decides the currency (India -> INR), not the browser time zone
    if (P.zoneForCountry && st.details && st.details.country) tz = P.zoneForCountry(st.details.country, tz);
    var o = null; try { o = B.signup ? await B.signup.planOptions(tz) : null; } catch (e) { o = null; }
    st.opts = o || {};
    if (st.opts.terms_version && !st.termsVersion) st.termsVersion = String(st.opts.terms_version);
    // r25: the server says the currency (India -> INR, elsewhere -> USD); without a server answer, the browser time zone
    st.currency = P.cur ? (st.opts.currency ? P.cur(st.opts.currency) : P.currencyFor(tz)) : "INR";
    st.tz = tz;
    st.plans = P.plansOr(st.opts.plans, st.currency);
    st.plan = P.pickPlan(st.plans, wantPlan());
    var days = Number(st.opts.trial_days) > 0 ? Number(st.opts.trial_days) : ((global.HelmTrialFacts && global.HelmTrialFacts.DAYS) || 8);
    st.trialDays = days;
    var pay = payOn();
    $("#stLead").textContent = pay ? "Pay now to open your studio straight away, or try Helm free for " + days + " days - no payment needed."
      : "Contact sales and our team sets up your plan with you - no studio is opened and nothing is charged until you agree a plan. Or start your one free " + days + "-day trial below.";
    trialWords(days);
    var note = $("#stNote");
    if (note) note.textContent = currencyNote(st.currency, pay);
    var m = wantMode();
    if (m === "trial") { $("#stOk").textContent = "Your free trial is one tap away - choose “Start your free " + days + "-day trial” below the plans."; $("#stOk").hidden = false; }
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
    // r105: no trial button on the cards - the trial is ONE per account and not tied to a plan (#stTrial below the cards)
    P.render($("#stPlans"), { plans: st.plans, currency: st.currency, interval: st.interval, selected: st.plan, trial: false, trialDays: st.trialDays,
      onSelect: function (code) { if (st.busy) return; st.plan = code; renderCards(); },
      onPay: function (p, b) { go("pay", p, b); }, onTrial: function (p, b) { go("trial", p, b); }, onSales: function (p, b) { go("sales", p, b); } });
  }
  function busy(b, label) {
    st.busy = true;
    Array.prototype.forEach.call(doc.querySelectorAll(BUSY_SEL), function (x) { x.disabled = true; });
    if (b) { b.setAttribute("aria-busy", "true"); while (b.firstChild) b.removeChild(b.firstChild); b.appendChild(el("span", "spin")); b.appendChild(el("span", null, label)); }
  }
  var BUSY_SEL = "#stPlans button, #stTrial, #sdTrial, #sdSetup";
  function unbusy() {
    st.busy = false;
    Array.prototype.forEach.call(doc.querySelectorAll("#stTrial, #sdTrial, #sdSetup"), function (x) {
      x.disabled = false; x.removeAttribute("aria-busy"); if (x.getAttribute("data-label")) x.textContent = x.getAttribute("data-label"); });
    if (st.plans) renderCards();
  }
  // r105: the ONE trial button (step 4 + the "request received" page) - the trial is not tied to a plan
  function trialWords(days) {
    ["#stTrial", "#sdTrial"].forEach(function (id) { var b = $(id); if (b) { b.textContent = "Start your free " + days + "-day trial"; b.setAttribute("data-label", b.textContent); } });
  }
  function currentPlan() {
    var code = st.plan || wantPlan();
    var list = st.plans || (global.HelmPlanCards ? global.HelmPlanCards.plansOr([]) : []);
    return list.filter(function (p) { return p.code === code; })[0] || { code: CODE_RE.test(String(code || "")) ? String(code) : "studio", name: "" };
  }
  function onDone() { var c = $("#salesDoneCard"); return !!(c && !c.hidden); }
  // r105: "Contact sales" on the sign-up -> a sales request for the account; NO studio until the plan is agreed
  function showSalesDone(r) {
    var B = S(); ctx.showView("#salesDoneCard"); doc.body.classList.remove("su-wide");
    var u = (B.auth.user && B.auth.user()) || {}; $("#sdEmail").textContent = u.email || "";
    $("#sdErr").hidden = true;
    var plan = r && (r.plan_name || r.plan_code) ? String(r.plan_name || r.plan_code) : "";
    $("#sdLead").textContent = "We've got your request" + (plan ? " for the " + plan + " plan" : "") + (r && r.studio_name ? " for " + r.studio_name : "") +
      ". Our sales team will contact you within one working day to set up your plan. Nothing is charged and no payment is needed now.";
    var days = st.trialDays || (global.HelmTrialFacts && global.HelmTrialFacts.DAYS) || 8; trialWords(days);
    setTimeout(function () { try { $("#sdTitle").focus(); } catch (e) {} }, 60);
  }
  // called by login.html routeSignedIn() for a signed-in account with no studio: a saved sign-up sales request -> that page
  async function resumeSales() {
    var B = S(); if (!B || !B.signup || !B.signup.salesRequest || !ctx) return false;
    var r = null; try { r = await B.signup.salesRequest(); } catch (e) { r = null; }
    if (!r || !r.id) return false;
    var saved = null; try { saved = JSON.parse(ssGet(DETAILS_KEY) || "null"); } catch (e) { saved = null; }
    st.details = Object.assign({ city: "", teamSize: "", eventTypes: [] }, saved || {}, { name: String(r.studio_name || (saved && saved.name) || "") });
    if (CODE_RE.test(String(r.plan_code || ""))) st.plan = String(r.plan_code);
    if (r.billing_interval === "yearly") st.interval = "yearly";
    st.salesReq = r;
    try { st.tz = global.HelmPlanCards && global.HelmPlanCards.browserZone ? global.HelmPlanCards.browserZone() : ""; } catch (e) { st.tz = ""; }
    try { if (global.HelmPlanCards.zoneForCountry && st.details.country) st.tz = global.HelmPlanCards.zoneForCountry(st.details.country, st.tz); } catch (e) {}   // r110 B3
    showSalesDone(r);
    return true;
  }
  async function go(kind, p, b) {
    if (st.busy || !st.details) return;
    var B = S(), err = onDone() ? $("#sdErr") : $("#stErr"); err.hidden = true; $("#stOk").hidden = true;
    st.plan = p.code;
    var d = st.details;
    try {
      if (await B.auth.operatorToHq()) return;   // a Helm operator never gets a studio (the server refuses too)
      if (kind === "trial") {
        busy(b, "Setting up your free trial…");
        await global.BPTrialSignup.start(d.name);
        try { await B.signup.saveDetails(d); } catch (e) {}
        try { if (B.signup.saveLocation) await B.signup.saveLocation(d); } catch (e) {}   // r105: country / state / city, asked once
        try { if (B.signup.initCurrency) await B.signup.initCurrency(st.tz); } catch (e) {}   // r25: billing currency, set once
        try { if (B.referral && B.referral.attachPending) await B.referral.attachPending(); } catch (e) {}   // r29: the referral / partner code, once
        lsDel(KEY);
        await ctx.routeSignedIn();
        return;
      }
      if (kind === "pay" && !payOn()) kind = "sales";   // r24: Pay now switched off - never the payment path
      if (kind === "sales" && B.signup.requestSales) {
        // r105: no studio on "Contact sales" - only a sales request for this account (HQ Requests + e-mail to sales)
        busy(b, "Sending your request…");
        var sr = null;
        try { sr = await B.signup.requestSales({ plan: p.code, interval: st.interval, studio: d.name,
          message: [d.city, d.state, d.country].filter(Boolean).length ? "Location: " + [d.city, d.state, d.country].filter(Boolean).join(", ") : null }); }
        catch (e1) {
          if (!(e1 && (e1.code === "PGRST202" || /request_signup_sales/.test(String(e1.message || ""))))) throw e1;
          sr = false;   // a server without 0315: the older path below (studio waiting for payment + the checkout form)
        }
        if (sr !== false) {
          lsDel(KEY); unbusy();   // the referral code is attached later, when the studio exists (trial or set-up)
          showSalesDone({ plan_code: p.code, plan_name: p.name, studio_name: d.name });
          return;
        }
      }
      if (kind === "setup" && !st.termsVersion) {
        try { var oo = await B.signup.planOptions(st.tz || ""); if (oo && oo.terms_version) st.termsVersion = String(oo.terms_version); } catch (e) {}
      }
      busy(b, kind === "pay" ? "Creating your studio…" : kind === "setup" ? "Setting up your studio…" : "Opening contact sales…");
      var r = await B.signup.createDirect({ name: d.name, plan: p.code, interval: st.interval, termsVersion: st.termsVersion });
      try { await B.signup.saveDetails(d); } catch (e) {}
        try { if (B.signup.saveLocation) await B.signup.saveLocation(d); } catch (e) {}   // r105: country / state / city, asked once
      try { if (B.signup.initCurrency) await B.signup.initCurrency(st.tz); } catch (e) {}   // r25: billing currency, set once (never changes a set one)
      try { if (B.referral && B.referral.attachPending) await B.referral.attachPending(); } catch (e) {}   // r29: the referral / partner code, once
      lsDel(KEY);
      try { global.localStorage.setItem("bp_force_tour", "1"); } catch (e) {}
      if (r && r.result === "exists") { await ctx.routeSignedIn(); return; }
      global.location.replace(checkoutHref(p.code, st.interval, kind !== "pay"));
    } catch (e) {
      unbusy();
      var x = startError(e);
      ctx.showErr(err, x.text || (global.BPUI ? global.BPUI.friendlyError(e, { action: "create your studio" }) : "Something went wrong. Please try again."));
      if (x.kind === "trial_used") Array.prototype.forEach.call(doc.querySelectorAll("#stTrial, #sdTrial"), function (t) { t.disabled = true; });
    }
  }
  function wire(hooks) {
    ctx = hooks;
    Array.prototype.forEach.call(doc.querySelectorAll('#startCard input[name="st_interval"]'), function (r) {
      r.addEventListener("change", function () { if (!r.checked) return; st.interval = r.value === "yearly" ? "yearly" : "monthly";
        $("#stIvM").classList.toggle("on", st.interval === "monthly"); $("#stIvY").classList.toggle("on", st.interval === "yearly"); renderCards(); });
    });
    var tb = $("#stTrial"); if (tb) tb.addEventListener("click", function () { go("trial", currentPlan(), tb); });
    var sdt = $("#sdTrial"); if (sdt) sdt.addEventListener("click", function () { go("trial", currentPlan(), sdt); });
    var sds = $("#sdSetup"); if (sds) sds.setAttribute("data-label", sds.textContent);
    var sds = $("#sdSetup"); if (sds) sds.addEventListener("click", function () { go("setup", currentPlan(), sds); });
    var back = $("#stBack"); if (back) back.addEventListener("click", function () { doc.body.classList.remove("su-wide"); ctx.showView("#onboardForm");
      try { var d0 = JSON.parse(ssGet(DETAILS_KEY) || "null"); if (d0) { d0.at4 = false; ssSet(DETAILS_KEY, JSON.stringify(d0)); } } catch (e) {} });
  }

  // r23: called by login.html's setMode() after trial-signup.js has laid out step 1. Tailors the heading to
  // ?mode= (paid / trial / sales), shows the chosen plan as a chip with a "change" link back to /pricing, and on
  // mode=sales offers the no-account route (the public /contact-sales form, with the chosen plan when there is one).
  function applyStep1(m, joining) {
    var on = m === "signup" && !joining;
    var chip = doc.getElementById("planChip"), note = doc.getElementById("salesNote");
    if (!on) { if (chip) chip.hidden = true; if (note) note.hidden = true; return; }
    var plans = global.HelmPlanCards && global.HelmPlanCards.plansOr ? global.HelmPlanCards.plansOr([]) : [];
    // only what THIS link says (a bare /signup stays neutral even if an older pricing click is remembered)
    var name = intent.fromUrl ? planName(intent.plan, plans) : "";
    var days = global.HelmTrialFacts && global.HelmTrialFacts.DAYS;
    var c = step1Copy(intent.fromUrl ? payGate(intent.mode, payOn()) : "", name, days);
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
        var l = el("a", "", "Write to our sales team \u2192"); l.href = "/contact-sales" + (["starter", "studio", "enterprise"].indexOf(intent.plan) >= 0 ? "?plan=" + intent.plan : ""); note.appendChild(l);
        var anchor = chip && !chip.hidden ? chip : sub;
        anchor.parentNode.insertBefore(note, anchor.nextSibling);
      }
      note.hidden = false;
    } else if (note) note.hidden = true;
  }

  global.BPSignupFlow = Object.assign({}, api, { intent: function () { return intent; }, wantMode: wantMode, wantPlan: wantPlan, applyStep1: applyStep1,
    stashTerms: stashTerms, wire: wire, resumeSales: resumeSales, showStudio: showStudio, submitStudio: submitStudio, showStart: showStart,
    clearIntent: function () { lsDel(KEY); } });
})(typeof window !== "undefined" ? window : globalThis);
