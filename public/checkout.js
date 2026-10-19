/* =========================================================================
   /checkout — onboarding step 3 (0056): plan → tax preview → billing → Terms →
   Razorpay Standard Checkout (its own modal) or, while online payment is dormant,
   an 8-day free trial. The page gate in store-api.js has already decided this
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
  var st = { upgrade: false, opts: null, plan: null, interval: "monthly", preview: null, seq: 0, busy: false, live: false, next: "dashboard.html", touched: {},
    pending: false, catalog: false, sales: false };
  /* 0159: shown only when the server has no plan yet (display only - never payable; the server
     list replaces it as soon as HQ / 0159 adds plans). Same plans as the public pricing page. */
  var CATALOG = [
    { code: "starter", name: "Starter", description: "Solo planners and decorators", monthly: 1999, yearly: 19990,
      features: ["Up to 3 team members", "Leads, clients and follow-ups (CRM)", "2D layout builder and 3D view", "Quotes with tax and client approval links", "Tasks and event calendar"] },
    { code: "studio", name: "Studio", description: "Growing event companies", monthly: 4999, yearly: 49990,
      features: ["Everything in Starter", "Up to 15 team members", "Roles and access matrix", "Inventory, stock check-out and shortages", "Client portal, booklet and invitation site"] },
    // r20: no monthly / yearly price = "Price on request" (selectable; only ever reached through Contact sales)
    { code: "enterprise", name: "Enterprise", description: "Multi-city teams and corporate studios", monthly: null, yearly: null,
      features: ["Everything in Studio", "Unlimited team members", "Multiple branches and countries, local tax rules", "Priority onboarding and data import help", "Audit log review and custom roles"] }
  ];

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
  function plansList() {
    var l = (st.opts && Array.isArray(st.opts.plans)) ? st.opts.plans : [];
    return l.length ? l : (st.catalog ? CATALOG : l);
  }
  function curOf() { return st.catalog ? "INR" : (st.opts && st.opts.currency) || "INR"; }
  function planBy(code) { return plansList().filter(function (p) { return p.code === code; })[0] || null; }
  // the middle-of-range plan gets the "Most studios" badge (only when there are 2+ plans)
  // r20: a plan with no price at all is "Price on request"; offered() = can be picked for this billing period
  function onRequest(p) { return !!p && p.monthly == null && p.yearly == null; }
  function offered(p) { return onRequest(p) || (st.interval === "yearly" ? p.yearly : p.monthly) != null; }
  function recommended() { var l = plansList(); return l.length > 1 ? l[Math.min(1, l.length - 1)].code : ""; }

  /* ---------------- plans ---------------- */
  function renderPlans() {
    var box = $("#coPlans"); clear(box);
    var list = plansList();
    if (!list.length) list = CATALOG;   // r20: never an empty box - the display-only plans instead
    var anyYearly = list.some(function (p) { return p.yearly != null; });
    $("#ivYearlyL").hidden = !anyYearly;
    $("#coSave").hidden = !list.some(function (p) { return p.yearly != null && Number(p.yearly) < Number(p.monthly) * 12; });
    list.forEach(function (p) {
      var price = st.interval === "yearly" ? p.yearly : p.monthly;
      var ask = onRequest(p), off = !offered(p);
      var lab = el("label", "plan" + (st.plan === p.code ? " on" : "") + (off ? " off" : ""));
      var inp = el("input"); inp.type = "radio"; inp.name = "plan"; inp.value = p.code; inp.checked = st.plan === p.code; inp.disabled = off;
      inp.setAttribute("aria-describedby", "pd_" + p.code.replace(/[^a-z0-9_-]/g, ""));
      inp.addEventListener("change", function () { if (inp.checked) { st.plan = p.code; renderPlans(); refreshPreview(); } });
      if (p.code === recommended()) lab.classList.add("rec");
      lab.appendChild(inp);
      var pn = el("div", "pn"); pn.appendChild(el("span", null, p.name));
      if (p.code === recommended()) pn.appendChild(el("span", "badge", "Most studios"));
      pn.appendChild(el("span", "tick")); lab.appendChild(pn);
      var pd = el("div", "pd", p.description || ""); pd.id = "pd_" + p.code.replace(/[^a-z0-9_-]/g, ""); lab.appendChild(pd);
      var pp = el("div", "pp");
      if (ask) { pp.classList.add("req"); pp.textContent = "Price on request"; }
      else if (off) { pp.textContent = "—"; pp.appendChild(el("small", null, "monthly only")); }
      else { pp.textContent = money(price, curOf()); pp.appendChild(el("small", null, st.interval === "yearly" ? "/year" : "/month")); }
      lab.appendChild(pp);
      lab.appendChild(el("div", "px", ask ? "Custom pricing for larger teams. Talk to our team" : off ? "Yearly billing isn't offered for this plan" :
        st.interval === "yearly" ? "≈ " + money(Number(price) / 12, curOf()) + " a month, plus tax" : "plus applicable tax"));
      // r22: the same action row as every plan card (plan-cards.js): Pay now (primary) / Try free (waiting studio,
      // payment off) / Contact sales. A button inside the card never toggles the radio by itself.
      if (window.HelmPlanCards && !off) lab.appendChild(window.HelmPlanCards.actions(p, { interval: st.interval,
        trial: st.pending && !st.live && !st.upgrade, trialDays: trialDays(), onPay: cardPay, onTrial: cardTrial, onSales: cardSales }));
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
    if (p && !offered(p)) {
      var alt = plansList().filter(offered)[0];
      st.plan = alt ? alt.code : st.plan;
    }
    renderPlans(); refreshPreview();
  }

  /* ---------------- summary (server-computed) ---------------- */
  function row(label, value, cls) { var r = el("div", "row" + (cls ? " " + cls : "")); r.appendChild(el("span", null, label)); r.appendChild(el("b", null, value)); return r; }
  function renderSummary() {
    var box = $("#coSummary"); clear(box);
    var q = st.preview;
    var cp = planBy(st.plan);
    if (!q && onRequest(cp)) {
      box.appendChild(row("Plan", cp.name));
      box.appendChild(row("Price", "On request", "tot"));
      box.appendChild(el("p", "note", "Our team prepares a quote for your studio's size and locations."));
      updateButton(); return;
    }
    if (!q && st.catalog) {
      if (cp) {
        box.appendChild(row("Plan", cp.name + " · " + (st.interval === "yearly" ? "Yearly" : "Monthly")));
        box.appendChild(row("Price before tax", money(st.interval === "yearly" ? cp.yearly : cp.monthly, "INR"), "tot"));
        box.appendChild(el("p", "note", "Proposed price. Tax is worked out from your billing country and state and shown before you pay."));
      }
      updateButton(); return;
    }
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
    if (st.catalog || onRequest(planBy(st.plan))) { st.preview = null; renderSummary(); return; }   // display-only plans: nothing to price on the server
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
    if (st.sales) { b.disabled = false; b.textContent = onRequest(planBy(st.plan)) || st.catalog && !planBy(st.plan) ? "Contact sales" : "Pay now"; return; }   // r20 / r22: online payment not live - Pay now = UPI / bank transfer
    if (st.catalog || (st.pending && !st.live)) { b.disabled = true; b.textContent = "Online payment coming soon"; return; }
    b.disabled = !st.preview || (st.upgrade && !st.live);
    b.textContent = !st.preview ? "Continue" : st.upgrade && !st.live ? "Online payment coming soon" : st.live ? "Pay " + money(st.preview.total, st.preview.currency) + " securely" : "Start 8-day free trial";
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
    if (st.sales) { var sp = planBy(st.plan); if (sp && !onRequest(sp)) cardPay(sp); else cardSales(sp); return; }   // r20 / r22: no online payment yet - the team activates the plan
    if (st.busy || !st.preview || st.catalog || (st.pending && !st.live)) return;
    showErr("");
    if (!validateAll()) { showErr("Please fix the highlighted fields."); return; }
    setBusy(true, st.live ? "Processing payment…" : "Starting your trial…");
    try {
      await S.checkout.saveBilling(readFields(), st.opts.terms_version);   // also records the Terms (server time)
      if (st.upgrade && !st.live) throw Object.assign(new Error("Online payment isn't switched on yet — contact Helm to activate your plan."), { kind: "validation" });
      if (st.live) {
        var p = (st.opts.prefill || {});
        var v = await S.checkout.pay(st.plan, st.interval, { name: $("#f_legal").value, email: p.email || "", contact: p.contact || "" });
        if (v && v.verified) { if (!(await offerDemoChoice())) finish("Payment received — welcome to Helm! Taking you to your dashboard…"); }
        else throw Object.assign(new Error("We couldn't confirm the payment yet. If money was taken it will show up shortly."), { kind: "declined" });
      } else {
        await S.checkout.startTrial("payment_pending", st.plan);
        finish("Your 8-day free trial has started. Taking you to your dashboard…");
      }
    } catch (e) { fail(e); }
  }
  /* 0185 — after a trial studio pays, its admin chooses once: keep the sample data (default), remove
     only the sample data, or start completely clean (own records archived, never deleted; asked twice).
     trial-upgrade.js renders the choice; resolves false when there is nothing to choose (or the plan
     is not active yet - the dashboard asks then), so the normal redirect runs. */
  async function offerDemoChoice() {
    var U = window.HelmTrialUpgrade;
    if (!U || typeof U.offer !== "function") return false;
    try {
      return await U.offer($("#coDemoChoice"), {
        before: function () { showErr("Payment received — welcome to Helm!", "ok"); },
        onDone: function () { setTimeout(function () { location.replace(st.next); }, 900); }
      });
    } catch (e) { return false; }
  }
  /* 0159: "Payments are being set up" - a directly created studio switches to the normal free
     trial (own data). Server-side: only while online payment is off; nothing is charged. */
  async function switchToTrial() {
    if (st.busy) return;
    showErr("");
    var b = $("#coSwitch"), m = $("#coSwitchMsg");
    st.busy = true; b.disabled = true; b.setAttribute("aria-busy", "true");
    clear(b); b.appendChild(el("span", "spin")); b.appendChild(el("span", null, "Starting your trial…"));
    try {
      await S.checkout.switchToTrial();
      m.textContent = "";
      finish("Your " + trialDays() + "-day free trial has started. Taking you to your studio…");
    } catch (e) {
      st.busy = false; b.disabled = false; b.removeAttribute("aria-busy");
      b.textContent = "Start " + trialDays() + "-day free trial instead";
      m.textContent = S.checkout.classify(e).message;
    }
  }
  function trialDays() { var d = st.opts && Number(st.opts.trial_days); return d > 0 && d < 61 ? d : 8; }
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

  /* ---------------- r20 / r21: Contact sales ----------------
     While online payment is not live the plan button is "Contact sales": a small form prefilled with
     the studio, the admin, the chosen plan + billing period. r21 (0244): the request is SAVED in Helm
     (request_plan_activation: HQ "Requests" + an e-mail alert to sales@helm.events) and the page says
     "Request received - we'll contact you within one working day". The visitor's own email app is only a
     fallback LINK (prefilled mailto, never opened by itself) for when saving fails. Nothing is charged.
     Pure helpers (salesCheck / salesMail / salesSource / payDetails) are unit-tested. */
  var SALES_TO = (S && S.checkout && S.checkout.SALES_EMAIL) || "sales@helm.events";
  var who = { studio: "", name: "", email: "", phone: "" };
  function salesCheck(f) {
    f = f && typeof f === "object" ? f : {};
    var one = function (k, n) { return String(f[k] == null ? "" : f[k]).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n); };
    var c = { studio: one("studio", 160), name: one("name", 80), email: one("email", 200), phone: one("phone", 20),
      plan: one("plan", 60), interval: f.interval === "yearly" ? "yearly" : "monthly",
      message: String(f.message == null ? "" : f.message).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim().slice(0, 1000) };
    var errors = {};
    if (!c.studio) errors.studio = "Enter your studio name";
    if (!c.name) errors.name = "Enter your name";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.email)) errors.email = "Enter a valid email address";
    if (c.phone && !/^\+?[0-9][0-9 ()-]{5,19}$/.test(c.phone)) errors.phone = "Enter a valid phone number";
    if (!c.plan) errors.plan = "Choose a plan";
    return { ok: !Object.keys(errors).length, errors: errors, clean: c };
  }
  function salesMail(c, to) {
    var iv = c.interval === "yearly" ? "Yearly" : "Monthly";
    var subject = "Helm plan request: " + c.plan + " (" + iv + ")" + (c.studio ? " - " + c.studio : "");
    var body = ["Hello Helm sales,", "", "I'd like to activate a Helm plan for my studio.", "",
      "Studio: " + c.studio, "Name: " + c.name, "Email: " + c.email, "Phone: " + (c.phone || "-"),
      "Plan: " + c.plan, "Billing: " + iv, "", "Message:", c.message || "-"].join("\n");
    return "mailto:" + (to || "sales@helm.events") + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
  }
  var SD = { studio: "sd_studio", name: "sd_name", email: "sd_email", phone: "sd_phone" };
  function openSales() {
    var d = $("#coSalesDlg"); if (!d) return;
    var ps = $("#sd_plan"); clear(ps);
    plansList().forEach(function (p) { var o = el("option", null, p.name); o.value = p.code; if (p.code === st.plan) o.selected = true; ps.appendChild(o); });
    $("#sd_iv").value = st.interval;
    if (!who.studio && $("#f_legal").value) who.studio = $("#f_legal").value;
    Object.keys(SD).forEach(function (k) { var f = $("#" + SD[k]); if (!f.value && who[k]) f.value = who[k]; f.closest(".fld").classList.remove("bad"); });
    $("#sdErr").textContent = ""; $("#sdMailWrap").hidden = true; $("#coSalesForm").hidden = false; $("#sdDone").hidden = true;
    // r21: Cloudflare Turnstile (only when config.js has a site key; null = off, the form works as before)
    if (!salesCap && window.HelmCaptcha) salesCap = window.HelmCaptcha.mount($("#sdCaptcha"), { action: "sales" });
    try { if (typeof d.showModal === "function") { if (!d.open) d.showModal(); } else d.setAttribute("open", ""); } catch (e) { d.setAttribute("open", ""); }
    var first = Object.keys(SD).map(function (k) { return $("#" + SD[k]); }).filter(function (f) { return f.required && !f.value; })[0] || $("#sd_msg");
    try { first.focus(); } catch (e) {}
  }
  function closeSales() {
    var d = $("#coSalesDlg"); if (!d) return;
    try { if (typeof d.close === "function" && d.open) d.close(); else d.removeAttribute("open"); } catch (e) { d.removeAttribute("open"); }
    try { $("#coPay").focus(); } catch (e) {}
  }
  // r21: where the request came from - the read-only banner's "Talk to us" opens this page with ?sales=banner
  function salesSource(search) { return /(?:^|[?&])sales=banner(?:&|$)/.test(String(search || "")) ? "read_only_banner" : "checkout"; }
  var SALES_OK = "Request received — we'll contact you within one working day";
  var salesSending = false, salesCap = null;
  function salesFallback(c) {
    var a = $("#sdMail"); if (!a) return;
    a.href = salesMail(c, SALES_TO); $("#sdMailWrap").hidden = false;
  }
  async function sendSales(ev) {
    if (ev) ev.preventDefault();
    if (salesSending) return;
    var plan = planBy($("#sd_plan").value);
    var v = salesCheck({ studio: $("#sd_studio").value, name: $("#sd_name").value, email: $("#sd_email").value, phone: $("#sd_phone").value,
      plan: plan ? plan.name : "", interval: $("#sd_iv").value, message: $("#sd_msg").value });
    Object.keys(SD).forEach(function (k) { $("#" + SD[k]).closest(".fld").classList.toggle("bad", !!v.errors[k]); });
    if (!v.ok) {
      $("#sdErr").textContent = Object.keys(v.errors).map(function (k) { return v.errors[k]; }).join(". ") + ".";
      var bad = Object.keys(SD).filter(function (k) { return v.errors[k]; })[0]; if (bad) try { $("#" + SD[bad]).focus(); } catch (e) {}
      return;
    }
    $("#sdErr").textContent = ""; $("#sdMailWrap").hidden = true;
    // r21: the security check first (one-use token -> captcha-verify -> a pass the database asks for)
    if (salesCap) {
      var capTok = salesCap.token();
      if (!capTok) { $("#sdErr").textContent = "Please complete the security check."; return; }
      try { await S.checkout.captchaPass("sales", capTok); }
      catch (e) { salesCap.reset(); $("#sdErr").textContent = String((e && e.message) || "The security check failed - please try again."); return; }
      salesCap.reset();
    }
    if (plan) { st.plan = plan.code; if (st.interval !== v.clean.interval) setInterval_(v.clean.interval); else { renderPlans(); refreshPreview(); } }
    var b = $("#sdSend"); salesSending = true; b.disabled = true; b.setAttribute("aria-busy", "true");
    var r = null, err = null;
    try {
      r = await S.checkout.requestSales({ plan: plan ? plan.code : "", interval: v.clean.interval, studio: v.clean.studio, name: v.clean.name,
        email: v.clean.email, phone: v.clean.phone, message: v.clean.message, source: salesSource(location.search) });
    } catch (e) { err = e; }
    salesSending = false; b.disabled = false; b.removeAttribute("aria-busy");
    if (!r || r.status !== "received") {
      // not saved (older server / network / refused): say so and offer the e-mail fallback link
      $("#sdErr").textContent = (err && err.message ? String(err.message).slice(0, 200) + ". " : "We couldn't save your request just now. ")
        + "You can e-mail our sales team instead.";
      salesFallback(v.clean);
      return;
    }
    $("#coSalesForm").hidden = true; $("#sdDone").hidden = false;
    try { $("#sdDone").focus(); } catch (e) {}
    showErr(SALES_OK + ".", "ok");
    // r22: never a fake "paid" - the studio stays payment pending until HQ confirms the payment and activates the plan
    if (st.pending || st.payRef) { $("#coPayPending").hidden = false; }
  }

  /* ---------------- r21: pay by UPI / bank transfer (while online payment is off) ----------------
     Values come ONLY from window.HELM_PAY_MANUAL (config.js - the owner fills them in). An empty value is
     not shown; with nothing filled the block says the team sends the details with the invoice. */
  var PAY_FIELDS = [["upiId", "UPI ID"], ["payeeName", "Payee name"], ["accountName", "Account name"], ["accountNumber", "Account number"],
    ["ifsc", "IFSC"], ["bankName", "Bank"], ["branch", "Branch"]];
  function payDetails(cfg) {
    var c = cfg && typeof cfg === "object" ? cfg : {};
    var rows = [];
    PAY_FIELDS.forEach(function (f) {
      var v = String(c[f[0]] == null ? "" : c[f[0]]).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
      if (v && !/^\[.*\]$/.test(v)) rows.push([f[1], v]);   // "[FILL ME]"-style placeholders are never shown
    });
    var note = String(c.note == null ? "" : c.note).replace(/\s+/g, " ").trim().slice(0, 240);
    return { rows: rows, note: note || (rows.length
      ? "After paying, send us the UTR / reference number (reply to our e-mail or add it in Contact sales). We activate your plan the same working day and e-mail your GST invoice."
      : "Our team sends Helm's UPI ID and bank details with your plan confirmation. We activate your plan the same working day after payment and e-mail your GST invoice.") };
  }
  function renderPayDetails() {
    var box = $("#coPayDetails"); if (!box) return;
    var d = payDetails(window.HELM_PAY_MANUAL), dl = $("#coPayList"); clear(dl);
    d.rows.forEach(function (r) { dl.appendChild(el("dt", null, r[0])); dl.appendChild(el("dd", null, r[1])); });
    dl.hidden = !d.rows.length;
    $("#coPayNote").textContent = d.note;
    box.hidden = false;
  }
  function wireSales() {
    var d = $("#coSalesDlg"); if (!d) return;
    $("#coSalesForm").addEventListener("submit", function (e) { sendSales(e); });
    $("#sdClose").addEventListener("click", closeSales);
    $("#sdDoneClose").addEventListener("click", closeSales);
    $("#coSalesLink").addEventListener("click", function () { cardSales(planBy(st.plan)); });
    var paid = $("#coPaid"); if (paid) paid.addEventListener("click", paidRef);
    d.addEventListener("click", function (e) { if (e.target === d) closeSales(); });   // backdrop
  }

  /* ---------------- r22: card actions (plan-cards.js) ----------------
     Pay now      online payment live -> the normal pay path (billing + Terms, Razorpay); otherwise the UPI / bank details
                  open with "I've paid - send the reference" (saved to HQ Requests). The studio stays PAYMENT PENDING until
                  HQ confirms and activates the plan - nothing on this page ever marks a payment as done.
     Try free     a waiting studio while payment is off (my_pending_start_trial)
     Contact sales  the saved Contact-sales form
     The Terms are agreed + recorded first every time (studio + person; the server asks for them too, 0255). */
  function pickFrom(search, list) {
    var q = new URLSearchParams(String(search || "")), want = String(q.get("plan") || "").toLowerCase();
    return { plan: (list || []).some(function (p) { return p.code === want; }) ? want : "", interval: q.get("interval") === "yearly" ? "yearly" : "monthly" };
  }
  async function recordTerms() {
    if (!termsOk(true)) { try { $("#coTerms").focus(); $("#coTermsCard").scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {} return false; }
    var v = st.opts && st.opts.terms_version;
    if (!v || st.termsSaved) return true;
    try { await S.subscription.updateAccount({ terms_version_accepted: v }); } catch (e) {
      // a server older than 0255 refuses this for a waiting studio (read-only guard); it does not ask for the Terms either
      if (!(e && (e.code === "25006" || /read-only|Choose a plan/i.test(String(e.message || ""))))) { showErr(S.checkout.classify(e).message); return false; }
    }
    try { if (S.signup) await S.signup.acceptTerms(v, "checkout"); } catch (e) {}
    st.termsSaved = true; st.opts.terms_accepted = true;
    return true;
  }
  function selectPlan(p) { if (p && p.code && st.plan !== p.code) { st.plan = p.code; renderPlans(); refreshPreview(); } }
  async function cardPay(p) {
    if (st.busy) return;
    selectPlan(p); showErr("");
    if (st.live && !st.catalog) { submit(); return; }   // the normal pay path (validates billing + Terms itself)
    if (!(await recordTerms())) { showErr("Please accept the Terms to continue."); return; }
    renderPayDetails();
    var box = $("#coPayDetails"); $("#coPaidWrap").hidden = false;
    $("#coPayPending").hidden = false;
    try { box.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
    try { $("#coPaid").focus({ preventScroll: true }); } catch (e) {}
  }
  async function cardSales(p) {
    if (st.busy) return;
    if (p) selectPlan(p);
    if (!(await recordTerms())) { showErr("Please accept the Terms to continue."); return; }
    openSales();
  }
  async function cardTrial(p) {
    if (st.busy) return;
    if (p) selectPlan(p);
    if (!(await recordTerms())) { $("#coSwitchMsg").textContent = "Please accept the Terms first."; return; }
    switchToTrial();
  }
  // "I've paid - send the reference": the saved Contact-sales form, prefilled; the plan stays pending until HQ activates it
  function paidRef() {
    openSales();
    var m = $("#sd_msg");
    if (m && !m.value) m.value = "I'm paying by UPI / bank transfer. Payment reference (UTR): ";
    st.payRef = true;
    try { m.focus(); m.setSelectionRange(m.value.length, m.value.length); } catch (e) {}
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
    $("#coSwitch").addEventListener("click", switchToTrial);
    wireSales();
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
    } catch (e) { showErr(S.checkout.classify(e).message); st.opts = {}; acct = {}; }   // r20: still show the plans (display only) + Contact sales
    st.opts.prefill = { email: u.email || "", contact: acct.primary_contact_phone || "" };
    who = { studio: acct.legal_business_name || "", name: acct.primary_contact_name || "", email: acct.primary_contact_email || u.email || "",
      phone: acct.primary_contact_phone || "" };
    // r22: a trial admin has no billing contact yet - Contact sales still opens with the studio name
    // (organization row) and your name (profile, else the sign-up name in auth user_metadata).
    var meta = u.user_metadata && typeof u.user_metadata === "object" ? u.user_metadata : {};
    if (!who.name) who.name = String(meta.full_name || meta.name || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (S.profile && typeof S.profile.mine === "function")
      S.profile.mine().then(function (p) { var n = p && String(p.full_name || "").trim(); if (n && !acct.primary_contact_name) who.name = n; }, function () {});
    if (!who.studio && S.org && typeof S.org.identity === "function")
      Promise.resolve(S.org.identity()).then(function (d) { if (d && d.name && !who.studio) who.studio = String(d.name); }, function () {});
    st.pending = st.opts.pending_payment === true;
    st.catalog = !(Array.isArray(st.opts.plans) && st.opts.plans.length);
    $("#coCur").textContent = curOf();
    // prefill billing details from the studio account (trimmed server values)
    $("#f_legal").value = acct.legal_business_name || "";
    $("#f_gstin").value = acct.gstin || "";
    $("#f_addr").value = acct.billing_address || "";
    $("#f_city").value = acct.city || "";
    $("#f_state").value = acct.state || "";
    fillCountries($("#f_country"), acct.country || "IN");
    st.live = S.checkout.payLive(st.opts);
    $("#coDormant").hidden = st.live || st.pending;
    $("#coSecure").hidden = !st.live;
    if (st.pending) {
      // 0159: a studio created directly (not a trial) opens after its plan is paid
      $("#coTitle").textContent = "Choose a plan to open your studio";
      $("#coLead").textContent = "Your studio is ready. Pick the plan that fits, add your billing details and complete payment to start using Helm. You'll see exactly what you pay, tax included, before anything is charged.";
    }
    // 0058: a studio already on (or just past) its free trial is upgrading — pay only, no new trial
    st.upgrade = st.opts.status === "trial" || st.opts.status === "past_due";
    // r20: nothing payable online (display-only plans, or online payment not live for an upgrade /
    // a studio waiting for its first payment) → the plan button is "Contact sales"
    st.sales = st.catalog || (!st.live && (st.upgrade || st.pending));
    var setupOn = st.sales;
    $("#coSetup").hidden = !setupOn;
    $("#coSalesAlt").hidden = !st.sales;
    $("#coSalesLinkWrap").hidden = st.sales || st.live;   // fresh studio starting its trial: a quiet way to ask first
    $("#coBilling").hidden = st.sales;                    // billing details + Terms are taken when the plan is activated
    $("#coTermsCard").hidden = false;                     // r22: the Terms are always agreed + recorded before Pay now / Contact sales / trial
    if (st.sales) {
      $("#sumH").textContent = "Your plan";
      $("#coLead").textContent = "Compare the plans and pick the one that fits your studio. You can change plans later.";
    }
    $("#coSwitchWrap").hidden = !(st.pending && !st.live);
    $("#coSwitch").textContent = "Start " + trialDays() + "-day free trial instead";
    if (setupOn) $("#coDormant").hidden = true;
    if (st.sales) renderPayDetails();   // r21: UPI / bank transfer details while online payment is off
    $("#coTest").hidden = st.upgrade || !(S.checkout.bypassEnabled() && st.opts.bypass_allowed === true);
    if (st.upgrade) {
      $("#coDormant").hidden = true;
      var up = $("#coUpgrade"); up.hidden = false;
      up.textContent = st.opts.status === "trial" ? "You're on the free trial. Choose a plan now — your trial days are not lost."
        : "Your free trial has ended. Choose a plan to keep using Helm. Your data is kept for 60 days after the trial ends, and we remind you before anything is deleted.";
      // 0185: what happens to the trial data is decided right after the plan is active
      up.textContent += " After upgrading you choose what happens to the sample data: keep it (default), remove it, or start completely clean.";
    }
    var list = plansList();
    st.plan = list.length ? list[Math.min(1, list.length - 1)].code : null;   // middle-of-range default
    // r22: the plan picked on the sign-up / pricing page (?plan=&interval=) - only when it is one of these plans
    var pick = pickFrom(location.search, list);
    if (pick.plan) st.plan = pick.plan;
    if (pick.interval === "yearly" && list.some(function (p) { return p.yearly != null; })) {
      st.interval = "yearly"; var yr = document.querySelector('input[name="interval"][value="yearly"]'); if (yr) yr.checked = true;
      $("#ivMonthlyL").classList.remove("on"); $("#ivYearlyL").classList.add("on");
    }
    $("#coPendingNote").hidden = !st.pending;
    // r22: Terms already agreed on the sign-up (recorded for this studio, current version): shown ticked, not asked twice
    if (st.opts.terms_accepted === true) { $("#coTerms").checked = true; st.termsSaved = true; }
    if (st.catalog && !st.upgrade) $("#coTest").hidden = true;
    renderPlans();
    if (st.plan) refreshPreview(); else renderSummary();
    updateButton();
    try { $("#coTitle").focus({ preventScroll: true }); } catch (e) {}
    // r21: "Talk to us" from the read-only banner opens Contact sales straight away
    if (salesSource(location.search) === "read_only_banner") openSales();
    if (/(?:^|[?&])sales=signup(?:&|$)/.test(location.search || "")) cardSales(planBy(st.plan));   // r22: "Contact sales" on the sign-up step
  });
})();
