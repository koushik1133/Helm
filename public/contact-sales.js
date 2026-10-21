/* contact-sales.js - r24 (0271): the public Contact sales page (/contact-sales?plan=starter|studio|enterprise).
   Anyone can write to Helm sales without an account. Talks only to the anonymous RPC submit_sales_enquiry (answers ok or
   a plain-words reason; nothing is ever read back). The enquiry lands in Helm HQ -> Requests -> Sales enquiries and an
   e-mail is queued to the HQ address (default notifications@helm.events). The hidden "website" field is a bot trap.
   r26: when config.js has a Turnstile site key, a security check shows above the button; its one-use pass (captcha.js ->
   captcha-verify) goes in the "captcha" field. No key = the form works exactly as before.
   Text only (textContent), no inline script. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var cfg = window.SUPABASE_CONFIG || {};
  var base = String(cfg.url || "").replace(/\/+$/, "");
  var PLANS = { starter: 1, studio: 1, enterprise: 1, not_sure: 1 };
  var EMAIL = /^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
  var FIELDS = { name: "cs-name", email: "cs-email", phone: "cs-phone", company: "cs-company", plan: "cs-plan",
    team_size: "cs-team", events_per_year: "cs-events", consent: "cs-consent" };

  function rpc(fn, body) {
    if (!base || !cfg.anonKey) return Promise.resolve({ ok: false, error: "config" });
    return fetch(base + "/rest/v1/rpc/" + fn, { method: "POST", credentials: "omit",
      headers: { "Content-Type": "application/json", apikey: cfg.anonKey, Authorization: "Bearer " + cfg.anonKey },
      body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return r.ok ? { ok: true, data: j } : { ok: false, error: "" }; }, function () { return { ok: false, error: "" }; }); })
      .catch(function () { return { ok: false, error: "network" }; });
  }
  function err(msg, field) {
    var e = $("cs-err"); e.textContent = msg || ""; e.hidden = !msg;
    Object.keys(FIELDS).forEach(function (k) { $(FIELDS[k]).removeAttribute("aria-invalid"); });
    if (field && FIELDS[field]) { var el = $(FIELDS[field]); el.setAttribute("aria-invalid", "true"); try { el.focus(); } catch (x) {} }
  }

  // r26: the security check (null = off)
  var cap = window.HelmCaptcha ? window.HelmCaptcha.guard($("cs-captcha"), "contact") : null;

  // ?plan=starter|studio|enterprise picks the plan
  try {
    var plan = String(new URLSearchParams(location.search).get("plan") || "").trim().toLowerCase();
    if (PLANS[plan]) $("cs-plan").value = plan;
  } catch (x) {}

  $("cs-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var name = $("cs-name").value.trim(), email = $("cs-email").value.trim(), phone = $("cs-phone").value.trim(),
        company = $("cs-company").value.trim();
    if (name.length < 2) return err("Please enter your name.", "name");
    if (!EMAIL.test(email)) return err("Please enter a valid work e-mail.", "email");
    if (phone && !/^\+?[0-9\s().-]{10,20}$/.test(phone)) return err("Please enter a valid phone number (10 digits).", "phone");
    if (company.length < 2) return err("Please enter your company or studio name.", "company");
    if (!$("cs-consent").checked) return err("Please tick the box so we may contact you.", "consent");
    err("");
    var body = { name: name, email: email, phone: phone || null, company: company, city: $("cs-city").value.trim() || null,
      team_size: $("cs-team").value || null, events_per_year: $("cs-events").value || null, plan: $("cs-plan").value || null,
      message: $("cs-message").value.trim() || null, consent: true, source: "contact_page" };
    var trap = $("cs-website").value; if (trap) body.website = trap;
    var btn = $("cs-send"); btn.disabled = true; btn.textContent = "Sending…";
    (cap ? cap.pass() : Promise.resolve({ ok: true, pass: null })).then(function (c) {
      if (!c.ok) return { ok: false, captcha: c.message };
      if (c.pass) body.captcha = c.pass;
      return rpc("submit_sales_enquiry", { p: body });
    }).then(function (r) {
      if (r.captcha) { btn.disabled = false; btn.textContent = "Send to sales"; return err(r.captcha); }
      btn.disabled = false; btn.textContent = "Send to sales";
      var d = r.ok ? r.data : null;
      if (d && d.ok === true) {
        $("cs-form").hidden = true; $("cs-form-h").hidden = true; $("cs-done").hidden = false;
        try { $("cs-done").scrollIntoView({ block: "center" }); } catch (x) {}
        return;
      }
      err(d && d.message ? String(d.message).slice(0, 200)
        : (r.error === "network" ? "No connection. Check your internet and try again."
          : "Something went wrong. Please try again, or e-mail sales@helm.events."), d && d.field);
    });
  });
})();
