/* enquiry.js - /<studio>/enquiry (0269). Anyone can send an enquiry to a studio without signing in; the studio gets a
   new lead (source "Enquiry form") and, when it switched it on, an instant thank-you e-mail goes to the client.
   Talks only to the public RPCs public_enquiry_info (the studio's NAME, nothing else) and public_enquiry_submit
   (answers ok or a plain-words reason; nothing is ever read back). The hidden "website" field is a bot trap.
   Text only (textContent), no inline script. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var cfg = window.SUPABASE_CONFIG || {};
  var base = String(cfg.url || "").replace(/\/+$/, "");
  // the studio's public link name: /<slug>/enquiry, or /enquiry?studio=<slug>
  var m = /^\/([a-z0-9][a-z0-9-]{1,62})\/enquir(?:y|e)\/?$/.exec(location.pathname);
  var slug = (m ? m[1] : String(new URLSearchParams(location.search).get("studio") || "")).trim().toLowerCase();
  var studio = "";

  function rpc(fn, body) {
    if (!base || !cfg.anonKey) return Promise.resolve({ ok: false, error: "config" });
    return fetch(base + "/rest/v1/rpc/" + fn, { method: "POST", credentials: "omit",
      headers: { "Content-Type": "application/json", apikey: cfg.anonKey, Authorization: "Bearer " + cfg.anonKey },
      body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (j) { return r.ok ? { ok: true, data: j } : { ok: false, error: "" }; }, function () { return { ok: false, error: "" }; }); })
      .catch(function () { return { ok: false, error: "network" }; });
  }
  function closed(title, msg) { $("eq-title").textContent = title; $("eq-msg").textContent = msg; $("eq-form").hidden = true; }
  function err(msg, field) {
    var e = $("eq-err"); e.textContent = msg || ""; e.hidden = !msg;
    ["eq-name", "eq-phone", "eq-email", "eq-date", "eq-guests", "eq-consent"].forEach(function (id) { $(id).removeAttribute("aria-invalid"); });
    var map = { name: "eq-name", phone: "eq-phone", email: "eq-email", event_date: "eq-date", guests: "eq-guests", consent: "eq-consent" };
    if (field && map[field]) { $(map[field]).setAttribute("aria-invalid", "true"); try { $(map[field]).focus(); } catch (x) {} }
  }
  function today() { var d = new Date(), p = function (n) { return (n < 10 ? "0" : "") + n; }; return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()); }

  function start() {
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) return closed("Enquiry form not found", "Please check the link the studio gave you.");
    rpc("public_enquiry_info", { p_slug: slug }).then(function (r) {
      var d = r.ok ? r.data : null;
      if (!d || d.ok !== true) {
        if (d && d.reason === "rate") return closed("Please wait a moment", "Too many tries from this network. Try again in a few minutes.");
        return closed("Enquiry form not open", "This studio is not taking enquiries online right now. Please contact them directly.");
      }
      studio = String(d.studio || "").slice(0, 80);
      document.title = "Send an enquiry · " + (studio || "Helm");
      $("eq-title").textContent = studio ? "Enquire with " + studio : "Send an enquiry";
      $("eq-msg").textContent = "Tell us about your event and we will get back to you.";
      $("eq-consent-t").textContent = "I agree that " + (studio || "this studio") + " may contact me about my enquiry.";
      $("eq-date").min = today();
      $("eq-form").hidden = false;
    });
  }

  $("eq-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var name = $("eq-name").value.trim(), phone = $("eq-phone").value.trim(), email = $("eq-email").value.trim();
    if (name.length < 2) return err("Please enter your name.", "name");
    if (!phone && !email) return err("Please give a phone number or an e-mail so the studio can reply.", "phone");
    if (phone && !/^\+?[0-9\s().-]{10,20}$/.test(phone)) return err("Please enter a valid phone number (10 digits).", "phone");
    if (email && !/^[^\s@<>"',;:\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(email)) return err("Please enter a valid e-mail address.", "email");
    var g = $("eq-guests").value.trim();
    if (g && !(/^[0-9]{1,6}$/.test(g) && +g >= 1 && +g <= 100000)) return err("Guests: a number from 1 to 100000.", "guests");
    if (!$("eq-consent").checked) return err("Please tick the box so the studio may contact you.", "consent");
    err("");
    var body = { name: name, phone: phone || null, email: email || null, event_type: $("eq-type").value.trim() || null,
      event_date: $("eq-date").value || null, guests: g || null, message: $("eq-message").value.trim() || null, consent: true };
    var trap = $("eq-website").value; if (trap) body.website = trap;
    var btn = $("eq-send"); btn.disabled = true; btn.textContent = "Sending…";
    rpc("public_enquiry_submit", { p_slug: slug, p: body }).then(function (r) {
      btn.disabled = false; btn.textContent = "Send enquiry";
      var d = r.ok ? r.data : null;
      if (d && d.ok === true) {
        $("eq-form").hidden = true;
        $("eq-title").textContent = "Thank you!";
        $("eq-msg").textContent = "";
        var done = document.createElement("p"); done.className = "eq-done";
        done.textContent = (studio || "The studio") + " has your enquiry and will get back to you soon.";
        $("eq-msg").appendChild(done);
        return;
      }
      if (d && d.reason === "closed") return closed("Enquiry form not open", String(d.message || "This studio is not taking enquiries online right now."));
      err(d && d.message ? String(d.message).slice(0, 200) : (r.error === "network" ? "No connection. Check your internet and try again." : "Something went wrong. Please try again."), d && d.field);
    });
  });
  start();
})();
