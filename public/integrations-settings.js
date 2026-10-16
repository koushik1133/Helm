/* integrations-settings.js — "Connect Razorpay / Connect WhatsApp" card (0117). DORMANT:
   saving only stores the studio's keys (secrets go to Supabase Vault through the admin-only
   save RPCs) and marks them "pending"; nothing goes live until Helm validates + connects
   the account server-side and the live channel flags are flipped.
   Self-contained: builds every element with the DOM API (no HTML strings, no inline
   styles), CSP-safe. Mount:  HelmIntegrationsSettings.mount(containerEl[, { rpc }])
   rpc(name, args) -> Promise. Defaults to BPStore.integrations (if the store exposes it).
   Hidden when the server has no 0117 (my_integration_accounts missing) or the user is
   not the studio admin. Secret inputs are never pre-filled, never logged, cleared after save. */
(function (global) {
  "use strict";
  if (typeof document === "undefined") return;

  var RZP_KEY = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/;
  var DIGITS = /^[0-9]{5,30}$/;

  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function field(id, label, type, hint, attrs) {
    var w = el("div", "its-field");
    var l = el("label", "its-lbl", label); l.htmlFor = id; w.appendChild(l);
    var i = el("input", "its-in"); i.id = id; i.type = type; i.autocomplete = type === "password" ? "new-password" : "off";
    i.spellcheck = false; Object.keys(attrs || {}).forEach(function (k) { i.setAttribute(k, attrs[k]); });
    w.appendChild(i);
    if (hint) { var h = el("p", "its-hint", hint); h.id = id + "_hint"; i.setAttribute("aria-describedby", h.id); w.appendChild(h); }
    return { wrap: w, input: i };
  }
  var STATUS_TXT = { connected: "Connected", pending: "Saved - waiting for Helm to verify", disabled: "Paused", error: "Needs attention" };
  function badge(st) {
    var s = st && st.status ? st.status : "none";
    var b = el("span", "its-badge its-" + s, s === "none" ? "Not connected" : (STATUS_TXT[s] || s));
    return b;
  }
  // pure: validation (exported for tests)
  function validateRazorpay(v) {
    if (!RZP_KEY.test(String(v.keyId || "").trim())) return "Key ID should look like rzp_test_... or rzp_live_....";
    if (String(v.keySecret || "").length < 8) return "Enter the Key Secret from Razorpay Dashboard -> Account & Settings -> API keys.";
    if (String(v.webhookSecret || "").length < 8) return "Enter a webhook secret of at least 8 characters (you will paste the same one into Razorpay).";
    return "";
  }
  function validateWhatsapp(v) {
    if (!DIGITS.test(String(v.wabaId || "").trim())) return "WhatsApp Business Account ID is a number from WhatsApp Manager.";
    if (!DIGITS.test(String(v.phoneId || "").trim())) return "Phone number ID is a number from Meta app -> WhatsApp -> API setup.";
    if (String(v.token || "").length < 20) return "Paste the permanent System User access token.";
    return "";
  }
  function friendly(e) {
    var m = String((e && (e.message || e.code)) || "");
    if (/vault_unavailable/.test(m)) return "Secure key storage is not switched on for this workspace yet. Ask Helm support.";
    if (/not_allowed|42501/.test(m)) return "Only the studio admin can change this.";
    if (/phone_in_use/.test(m)) return "That WhatsApp number is already connected to another studio.";
    if (/invalid_/.test(m)) return "Some details look wrong - please check and try again.";
    return "Could not save right now. Please try again.";
  }

  function defaultRpc() {
    var I = global.BPStore && global.BPStore.integrations;
    if (!I) return null;
    return function (name, args) {
      if (name === "my_integration_accounts") return I.mine();
      if (name === "save_org_payment_account") return I.saveRazorpay(args);
      if (name === "save_org_whatsapp_account") return I.saveWhatsapp(args);
      if (name === "set_org_integration_status") return I.setStatus(args);
      return Promise.reject(new Error("bad call"));
    };
  }

  function section(title, sub, state) {
    var fs = el("fieldset", "its-set");
    var lg = el("legend", null, title); fs.appendChild(lg);
    var head = el("div", "its-head"); head.appendChild(el("p", "its-sub", sub)); head.appendChild(badge(state)); fs.appendChild(head);
    return fs;
  }
  function msgBox() { var m = el("p", "its-msg"); m.setAttribute("role", "status"); m.setAttribute("aria-live", "polite"); return m; }
  function say(m, t, kind) { m.textContent = t || ""; m.dataset.kind = kind || ""; }

  function razorpayForm(root, S, rpc, refresh) {
    var st = S.razorpay;
    var fs = section("Online payments - Razorpay", "Your clients pay into YOUR Razorpay account. Helm never holds the money.", st);
    if (st && st.key_id) fs.appendChild(el("p", "its-meta", "Key ID " + st.key_id + " - " + (st.mode === "live" ? "live mode" : "test mode")));
    var grid = el("div", "its-grid");
    var k = field("its_rzp_key", "Key ID", "text", null, { maxlength: "60", placeholder: "rzp_test_..." });
    var s = field("its_rzp_secret", "Key Secret", "password", null, { maxlength: "200" });
    var w = field("its_rzp_whsec", "Webhook secret", "password", "Make up a long random secret; you will paste the same value into your payment dashboard.", { maxlength: "200" });
    [k, s, w].forEach(function (f) { grid.appendChild(f.wrap); });
    fs.appendChild(grid);
    fs.appendChild(el("p", "its-hint", "After you save, Helm support sends you the webhook address for your studio and checks the keys in test mode first."));
    var m = msgBox(), foot = el("div", "its-foot"), btn = el("button", "btn primary", st ? "Update keys" : "Connect Razorpay");
    btn.type = "button"; foot.appendChild(m); foot.appendChild(btn); fs.appendChild(foot);
    btn.addEventListener("click", function () {
      var v = { keyId: k.input.value.trim(), keySecret: s.input.value, webhookSecret: w.input.value };
      var bad = validateRazorpay(v); if (bad) { say(m, bad, "err"); return; }
      btn.disabled = true; say(m, "Saving...", "");
      rpc("save_org_payment_account", { p_key_id: v.keyId, p_key_secret: v.keySecret, p_webhook_secret: v.webhookSecret })
        .then(function () { s.input.value = ""; w.input.value = ""; say(m, "Saved. Helm will verify the keys before any payment link uses them.", "ok"); refresh(); })
        .catch(function (e) { say(m, friendly(e), "err"); })
        .then(function () { btn.disabled = false; });
    });
    root.appendChild(fs);
  }

  function whatsappForm(root, S, rpc, refresh) {
    var st = S.whatsapp;
    var fs = section("WhatsApp - your own number", "Messages to clients come from your studio's WhatsApp Business number.", st);
    if (st && st.phone_number_id) fs.appendChild(el("p", "its-meta", (st.display_phone || "Number") + " - phone ID " + st.phone_number_id + (st.quality ? " - quality " + st.quality : "")));
    var grid = el("div", "its-grid");
    var a = field("its_wa_waba", "WhatsApp Business Account ID", "text", null, { inputmode: "numeric", maxlength: "30" });
    var p = field("its_wa_phone", "Phone number ID", "text", null, { inputmode: "numeric", maxlength: "30" });
    var d = field("its_wa_disp", "Display number (optional)", "text", null, { maxlength: "30", placeholder: "+91 ..." });
    var t = field("its_wa_token", "Access token", "password", "Permanent System User token with whatsapp_business_messaging.", { maxlength: "1000" });
    [a, p, d, t].forEach(function (f) { grid.appendChild(f.wrap); });
    fs.appendChild(grid);
    var m = msgBox(), foot = el("div", "its-foot"), btn = el("button", "btn primary", st ? "Update number" : "Connect WhatsApp");
    btn.type = "button"; foot.appendChild(m); foot.appendChild(btn); fs.appendChild(foot);
    btn.addEventListener("click", function () {
      var v = { wabaId: a.input.value.trim(), phoneId: p.input.value.trim(), token: t.input.value, disp: d.input.value.trim() };
      var bad = validateWhatsapp(v); if (bad) { say(m, bad, "err"); return; }
      btn.disabled = true; say(m, "Saving...", "");
      rpc("save_org_whatsapp_account", { p_waba_id: v.wabaId, p_phone_number_id: v.phoneId, p_token: v.token, p_display_phone: v.disp || null })
        .then(function () { t.input.value = ""; say(m, "Saved. Helm will verify the number before any message uses it.", "ok"); refresh(); })
        .catch(function (e) { say(m, friendly(e), "err"); })
        .then(function () { btn.disabled = false; });
    });
    root.appendChild(fs);
  }

  function mount(container, opts) {
    if (!container) return Promise.resolve(false);
    var rpc = (opts && typeof opts.rpc === "function") ? opts.rpc : defaultRpc();
    if (!rpc) { container.hidden = true; return Promise.resolve(false); }
    function render() {
      return Promise.resolve().then(function () { return rpc("my_integration_accounts", {}); })
        .catch(function () { return null; })
        .then(function (S) {
          clear(container);
          if (!S || !S.is_admin) { container.hidden = true; return false; }
          container.hidden = false; container.classList.add("its-card");
          container.appendChild(el("h3", "its-title", "Payments & WhatsApp"));
          container.appendChild(el("p", "its-note", "Not live yet - saving your keys does not switch anything on. Helm verifies them first."));
          razorpayForm(container, S, rpc, render);
          whatsappForm(container, S, rpc, render);
          return true;
        });
    }
    return render();
  }

  global.HelmIntegrationsSettings = { mount: mount, _validateRazorpay: validateRazorpay, _validateWhatsapp: validateWhatsapp, _friendly: friendly };
})(typeof window !== "undefined" ? window : globalThis);
