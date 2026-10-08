/* =========================================================================
   /checkout — onboarding step 3 (0056): plan → tax preview → billing → Terms →
   Razorpay Standard Checkout (its own modal) or, while online payment is dormant,
   a 14-day free trial. The page gate in store-api.js has already decided this
   account must be here (new studio owner, no subscription) before anything paints.
   Every value from the server is rendered with textContent / DOM nodes — no HTML.
   Prices, tax and totals come ONLY from the server (my_checkout_preview).
   ========================================================================= */
(function () {
  "use strict";
  var $ = function (s) { return document.querySelector(s); };
  var S = window.BPStore;
  var COUNTRIES = [["IN", "India"], ["AE", "United Arab Emirates"], ["AU", "Australia"], ["CA", "Canada"], ["DE", "Germany"],
    ["FR", "France"], ["GB", "United Kingdom"], ["MY", "Malaysia"], ["NL", "Netherlands"], ["NZ", "New Zealand"], ["QA", "Qatar"],
    ["SA", "Saudi Arabia"], ["SG", "Singapore"], ["LK", "Sri Lanka"], ["US", "United States"], ["ZA", "South Africa"]];
  var FIELDS = { legal_business_name: "f_legal", gstin: "f_gstin", billing_address: "f_addr", city: "f_city", state: "f_state", country: "f_country" };
  var ERRS = { legal_business_name: "e_legal", gstin: "e_gstin", billing_address: "e_addr", city: "e_city", state: "e_state", country: "e_country" };
  var st = { opts: null, plan: null, interval: "monthly", preview: null, seq: 0, busy: false, live: false, next: "dashboard.html", touched: {} };

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function money(v, cur) {
    var n = Number(v); if (!isFinite(n)) return "—";
    try { return new Intl.NumberFormat(cur === "INR" ? "en-IN" : undefined, { style: "currency", currency: cur || "INR", maximumFractionDigits: 2 }).format(n); }
    catch (e) { return (cur || "") + " " + n.toFixed(2); }
  }
  function showErr(msg, kind) {
    var b = $("#coErr"); b.className = "alert " + (kind === "ok" ? "ok" : kind === "info" ? "info" : "err");
    b.textContent = msg || ""; b.hidden = !msg;
    if (msg) try { b.scrollIntoView({ block: "nearest", behavior: "smooth" }); } catch (e) {}
  }
  function plansList() { return (st.opts && Array.isArray(st.opts.plans)) ? st.opts.plans : []; }
  function planBy(code) { return plansList().filter(function (p) { return p.code === code; })[0] || null; }

  /* ---------------- plans ---------------- */
  function renderPlans() {
    var box = $("#coPlans"); clear(box);
    var list = plansList();
    if (!list.length) { box.appendChild(el("p", "hint", "No plans are available right now. Please contact Helm support.")); return; }
    var anyYearly = list.some(function (p) { return p.yearly != null; });
    $("#ivYearlyL").hidden = !anyYearly;
    $("#coSave").hidden = !list.some(function (p) { return p.yearly != null && Number(p.yearly) < Number(p.monthly) * 12; });
    list.forEach(function (p) {
      var price = st.interval === "yearly" ? p.yearly : p.monthly;
      var off = price == null;
      var lab = el("label", "plan" + (st.plan === p.code ? " on" : "") + (off ? " off" : ""));
      var inp = el("input"); inp.type = "radio"; inp.name = "plan"; inp.value = p.code; inp.checked = st.plan === p.code; inp.disabled = off;
      inp.setAttribute("aria-describedby", "pd_" + p.code.replace(/[^a-z0-9_-]/g, ""));
      inp.addEventListener("change", function () { if (inp.checked) { st.plan = p.code; renderPlans(); refreshPreview(); } });
      lab.appendChild(inp);
      var pn = el("div", "pn"); pn.appendChild(el("span", null, p.name)); pn.appendChild(el("span", "tick")); lab.appendChild(pn);
      var pd = el("div", "pd", p.description || ""); pd.id = "pd_" + p.code.replace(/[^a-z0-9_-]/g, ""); lab.appendChild(pd);
      var pp = el("div", "pp");
      if (off) { pp.textContent = "—"; pp.appendChild(el("small", null, "monthly only")); }
      else { pp.textContent = money(price, st.opts.currency); pp.appendChild(el("small", null, st.interval === "yearly" ? "/year" : "/month")); }
      lab.appendChild(pp);
      lab.appendChild(el("div", "px", off ? "Yearly billing isn't offered for this plan" :
        st.interval === "yearly" ? "≈ " + money(Number(price) / 12, st.opts.currency) + " a month, plus tax" : "plus applicable tax"));
      var feats = Array.isArray(p.features) ? p.features : [];
      if (feats.length) {
        lab.appendChild(el("h3", null, "What's included"));
        var ul = el("ul"); feats.forEach(function (f) { ul.appendChild(el("li", null, f)); }); lab.appendChild(ul);
      }
      box.appendChild(lab);
    });
  }
  function setInterval_(v) {
    st.interval = v === "yearly" ? "yearly" : "monthly";
    $("#ivMonthlyL").classList.toggle("on", st.interval === "monthly");
    $("#ivYearlyL").classList.toggle("on", st.interval === "yearly");
    var p = planBy(st.plan);
    if (p && (st.interval === "yearly" ? p.yearly : p.monthly) == null) {
      var alt = plansList().filter(function (x) { return (st.interval === "yearly" ? x.yearly : x.monthly) != null; })[0];
      st.plan = alt ? alt.code : st.plan;
    }
    renderPlans(); refreshPreview();
  }

  /* ---------------- summary (server-computed) ---------------- */
  function row(label, value, cls) { var r = el("div", "row" + (cls ? " " + cls : "")); r.appendChild(el("span", null, label)); r.appendChild(el("b", null, value)); return r; }
  function renderSummary() {
    var box = $("#coSummary"); clear(box);
    var q = st.preview;
    if (!q) { box.appendChild(el("div", "skel")); return; }
    var cur = q.currency;
    box.appendChild(row("Plan", q.plan_name + " · " + (q.interval === "yearly" ? "Yearly" : "Monthly")));
    box.appendChild(row("Subtotal", money(q.net, cur)));
    var comps = Array.isArray(q.components) ? q.components : [];
    if (comps.length) comps.forEach(function (c) { box.appendChild(row(c.name + " (" + Number(c.rate) + "%)", money(c.amount, cur))); });
    else box.appendChild(row("Tax", money(0, cur)));
    box.appendChild(row("Total due " + (q.interval === "yearly" ? "each year" : "each month"), money(q.total, cur), "tot"));
    var notes = [];
    if (q.regime === "EXPORT_LUT_ZERO") notes.push("Export of services — zero-rated under LUT.");
    if (q.reverse_charge) notes.push("Reverse charge applies: you account for VAT/GST in your country.");
    if (q.note && notes.indexOf(q.note) < 0) notes.push(q.note);
    if (q.place_of_supply) notes.push("Place of supply: " + q.place_of_supply + ".");
    notes.push("Tax is worked out by Helm from your billing country and state, and shown on your invoice.");
    box.appendChild(el("p", "note", notes.join(" ")));
    updateButton();
  }
  var pvTimer = null;
  function refreshPreview() {
    if (!st.plan) return;
    st.preview = null; renderSummary(); updateButton();
    clearTimeout(pvTimer);
    pvTimer = setTimeout(function () {
      var my = ++st.seq;
      S.checkout.preview(st.plan, st.interval).then(function (q) {
        if (my !== st.seq) return;   // a newer choice is in flight
        st.preview = q; renderSummary();
      }, function (e) {
        if (my !== st.seq) return;
        var c = S.checkout.classify(e); showErr(c.message);
      });
    }, 120);
  }

  /* ---------------- billing details (inline errors on blur) ---------------- */
  function readFields() { var o = {}; Object.keys(FIELDS).forEach(function (k) { o[k] = $("#" + FIELDS[k]).value; }); return o; }
  function paintErrors(errors, only) {
    Object.keys(FIELDS).forEach(function (k) {
      if (only && !only[k]) return;
      var msg = errors[k] || "";
      var f = $("#" + FIELDS[k]); var wrap = f.closest(".fld");
      $("#" + ERRS[k]).textContent = msg; wrap.classList.toggle("bad", !!msg);
      if (msg) f.setAttribute("aria-invalid", "true"); else f.removeAttribute("aria-invalid");
    });
  }
  function onBlur(k) {
    st.touched[k] = true;
    var f = $("#" + FIELDS[k]);
    if (f.tagName !== "SELECT") f.value = k === "billing_address" ? f.value.trim() : f.value.replace(/\s+/g, " ").trim();
    if (k === "gstin") f.value = f.value.toUpperCase().replace(/\s+/g, "");
    paintErrors(S.checkout.validate(readFields()).errors, st.touched);
  }
  // billing country / state drive the tax: re-preview after a change (the server reads
  // the SAVED account, so save the location part first when it's valid)
  var locTimer = null;
  function onLocationChange() {
    clearTimeout(locTimer);
    locTimer = setTimeout(function () {
      var v = S.checkout.validate(readFields());
      if (v.errors.country || v.errors.state) return;
      S.subscription.updateAccount({ country: v.clean.country, state: v.clean.state }).then(refreshPreview, function () {});
    }, 400);
  }
  function termsOk(mark) {
    var ok = $("#coTerms").checked;
    if (mark) { $("#e_terms").textContent = ok ? "" : "Please accept the Terms to continue"; $("#coTermsBox").classList.toggle("bad", !ok); }
    return ok;
  }

  /* ---------------- pay / trial ---------------- */
  function updateButton() {
    var b = $("#coPay");
    if (st.busy) return;
    b.disabled = !st.preview;
    b.textContent = !st.preview ? "Continue" : st.live ? "Pay " + money(st.preview.total, st.preview.currency) + " securely" : "Start 14-day free trial";
  }
  function setBusy(on, label) {
    st.busy = on;
    var b = $("#coPay"), k = $("#coSkip");
    b.disabled = on; if (k) k.disabled = on;
    b.setAttribute("aria-busy", on ? "true" : "false");
    if (on) { clear(b); b.appendChild(el("span", "spin")); b.appendChild(el("span", null, label)); }
    else updateButton();
  }
  function validateAll() {
    var v = S.checkout.validate(readFields());
    Object.keys(FIELDS).forEach(function (k) { st.touched[k] = true; });
    paintErrors(v.errors);
    var t = termsOk(true);
    if (!v.ok) { var first = Object.keys(FIELDS).filter(function (k) { return v.errors[k]; })[0]; $("#" + FIELDS[first]).focus(); }
    else if (!t) $("#coTerms").focus();
    return v.ok && t;
  }
  function finish(msg) {
    showErr(msg, "ok");
    setTimeout(function () { location.replace(st.next); }, 700);
  }
  function fail(e) {
    var c = S.checkout.classify(e);
    if (c.kind === "dormant") { goDormant(); showErr(c.message, "info"); }
    else if (c.kind === "cancelled") showErr(c.message, "info");
    else showErr(c.message);
    if (e && e.fields) paintErrors(e.fields);
    setBusy(false);
  }
  function goDormant() { st.live = false; $("#coDormant").hidden = false; updateButton(); }

  async function submit(ev) {
    if (ev) ev.preventDefault();
    if (st.busy || !st.preview) return;
    showErr("");
    if (!validateAll()) { showErr("Please fix the highlighted fields."); return; }
    setBusy(true, st.live ? "Processing payment…" : "Starting your trial…");
    try {
      await S.checkout.saveBilling(readFields(), st.opts.terms_version);   // also records the Terms (server time)
      if (st.live) {
        var p = (st.opts.prefill || {});
        var v = await S.checkout.pay(st.plan, st.interval, { name: $("#f_legal").value, email: p.email || "", contact: p.contact || "" });
        if (v && v.verified) finish("Payment received — welcome to Helm! Taking you to your dashboard…");
        else throw Object.assign(new Error("We couldn't confirm the payment yet. If money was taken it will show up shortly."), { kind: "declined" });
      } else {
        await S.checkout.startTrial("payment_pending", st.plan);
        finish("Your 14-day free trial has started. Taking you to your dashboard…");
      }
    } catch (e) { fail(e); }
  }
  async function skip() {
    if (st.busy) return;
    showErr("");
    if (!termsOk(true)) { $("#coTerms").focus(); showErr("Accept the Terms first — they apply to trials too."); return; }
    setBusy(true, "Starting your trial…");
    var k = $("#coSkip"); k.textContent = "Starting trial…";
    try {
      var v = S.checkout.validate(readFields());
      var patch = v.ok ? v.clean : {};
      await S.subscription.updateAccount(Object.assign({}, patch, { terms_version_accepted: st.opts.terms_version }));
      await S.checkout.startTrial("bypass", st.plan);
      finish("Trial started (testing bypass). Taking you to your dashboard…");
    } catch (e) { k.textContent = "Skip payment (testing only)"; fail(e); }
  }

  /* ---------------- boot ---------------- */
  function fillCountries(sel, current) {
    var o0 = el("option", null, "Select a country"); o0.value = ""; sel.appendChild(o0);
    var has = false;
    COUNTRIES.forEach(function (c) { var o = el("option", null, c[1]); o.value = c[0]; if (c[0] === current) { o.selected = true; has = true; } sel.appendChild(o); });
    if (current && !has && /^[A-Z]{2}$/.test(current)) { var o = el("option", null, current); o.value = current; o.selected = true; sel.appendChild(o); }
  }
  function wire() {
    $("#coForm").addEventListener("submit", submit);
    Array.prototype.forEach.call(document.querySelectorAll('input[name="interval"]'), function (r) {
      r.addEventListener("change", function () { if (r.checked) setInterval_(r.value); });
    });
    Object.keys(FIELDS).forEach(function (k) {
      var f = $("#" + FIELDS[k]);
      f.addEventListener("blur", function () { onBlur(k); });
      f.addEventListener("input", function () { if (st.touched[k]) paintErrors(S.checkout.validate(readFields()).errors, st.touched); });
    });
    $("#f_country").addEventListener("change", function () { onBlur("country"); onLocationChange(); });
    $("#f_state").addEventListener("change", onLocationChange);
    $("#coTerms").addEventListener("change", function () { termsOk(true); });
    $("#coSkip").addEventListener("click", skip);
    $("#coSignOut").addEventListener("click", async function () { try { await S.auth.signOut(); } catch (e) {} location.replace("login.html"); });
  }

  BPUI.boot(async function () {
    await S.init();
    S.auth.required();
    var u = S.auth.user() || {};
    $("#coEmail").textContent = u.email || "";
    st.next = S.checkout.next();
    wire();
    var acct = {};
    try {
      var both = await Promise.all([S.checkout.options(), S.subscription.account().catch(function () { return null; })]);
      st.opts = both[0] || {}; acct = both[1] || {};
    } catch (e) { showErr(S.checkout.classify(e).message); $("#coPlans").textContent = ""; return; }
    st.opts.prefill = { email: u.email || "", contact: acct.primary_contact_phone || "" };
    $("#coCur").textContent = st.opts.currency || "INR";
    // prefill billing details from the studio account (trimmed server values)
    $("#f_legal").value = acct.legal_business_name || "";
    $("#f_gstin").value = acct.gstin || "";
    $("#f_addr").value = acct.billing_address || "";
    $("#f_city").value = acct.city || "";
    $("#f_state").value = acct.state || "";
    fillCountries($("#f_country"), acct.country || "IN");
    st.live = S.checkout.payLive(st.opts);
    $("#coDormant").hidden = st.live;
    $("#coSecure").hidden = !st.live;
    $("#coTest").hidden = !(S.checkout.bypassEnabled() && st.opts.bypass_allowed === true);
    var list = plansList();
    st.plan = list.length ? list[Math.min(1, list.length - 1)].code : null;   // middle-of-range default
    renderPlans();
    if (st.plan) refreshPreview(); else renderSummary();
    try { $("#coTitle").focus({ preventScroll: true }); } catch (e) {}
  });
})();
