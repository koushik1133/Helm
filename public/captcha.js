/* =========================================================================
   captcha.js - r21: the Cloudflare Turnstile widget for pages that do not load auth-ui.js
   (checkout "Contact sales"); r26: also the PUBLIC forms a signed-out visitor sends -
   /contact-sales + the home page form (submit_sales_enquiry), /<studio>/enquiry
   (public_enquiry_submit) and /suggest (submit_suggestion).
   OFF while public/config.js captcha.siteKey is empty: mount() returns null, nothing is loaded,
   publicPass() answers { ok: true, pass: null } and every form works exactly as before.
   The token is checked on the SERVER (captcha-verify edge function):
     - signed in (checkout): a one-use pass for that user (migration 0249);
     - signed out (r26, migration 0276): a one-use pass id the form sends as its "captcha" field;
       the database asks for it only while HQ's rpc_captcha_required switch is on.
   CSP: script + frame from https://challenges.cloudflare.com are allowed on these pages only
   (scripts/csp-hashes.cjs). DOM via createElement / textContent only.
   ========================================================================= */
(function (global) {
  "use strict";
  var doc = global.document;
  var tsPromise = null;
  var KEY_RE = /^[0-9A-Za-z_-]{8,128}$/;
  function load() {
    if (global.turnstile) return Promise.resolve(true);
    if (tsPromise) return tsPromise;
    tsPromise = new Promise(function (resolve) {
      var s = doc.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      s.async = true;
      s.onload = function () { resolve(!!global.turnstile); };
      s.onerror = function () { tsPromise = null; resolve(false); };
      (doc.head || doc.documentElement).appendChild(s);
    });
    return tsPromise;
  }
  // the app's store (signed-in pages) or, on the public pages without it, config.js directly
  function cfgKey() {
    try {
      var c = (global.SUPABASE_CONFIG && global.SUPABASE_CONFIG.captcha) || {};
      var k = typeof c.siteKey === "string" ? c.siteKey.trim() : "";
      return c.provider === "turnstile" && KEY_RE.test(k) ? k : "";
    } catch (e) { return ""; }
  }
  function siteKey() {
    try { var S = global.BPStore; if (S && S.auth && S.auth.captcha) return S.auth.captcha.enabled() ? S.auth.captcha.siteKey() : ""; } catch (e) {}
    return cfgKey();
  }
  function enabled() { return !!siteKey(); }
  // -> null when CAPTCHA is off; else { ready, token(), reset() }
  function mount(host, opts) {
    if (!host || !enabled()) return null;
    var token = null, wid = null;
    host.hidden = false;
    var ready = load().then(function (ok) {
      if (!ok || !global.turnstile) { host.textContent = "The security check couldn't load. Check your connection (or pause content blockers) and reload the page."; return false; }
      wid = global.turnstile.render(host, {
        sitekey: siteKey(),
        action: (opts && opts.action) || "form",
        // r26: the normal check is 300px wide - on a narrow phone form use Cloudflare's compact one
        size: host.clientWidth && host.clientWidth < 300 ? "compact" : "normal",
        callback: function (t) { token = t; },
        "expired-callback": function () { token = null; },
        "error-callback": function () { token = null; },
      });
      return true;
    });
    return {
      ready: ready,
      token: function () { return token; },
      reset: function () { token = null; try { if (wid !== null && global.turnstile) global.turnstile.reset(wid); } catch (e) {} },
    };
  }

  // r26: signed-out forms. Turnstile token -> captcha-verify -> a one-use pass id (uuid) for this form.
  //   { ok: true, pass: null }       CAPTCHA off here, or the server has no secret yet (send the form as today)
  //   { ok: true, pass: "<uuid>" }   put it in the form's "captcha" field
  //   { ok: false, message }         show the message; the person tries the check again
  var ACTIONS = { contact: 1, enquiry: 1, suggest: 1 };
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var FAILED = "The security check failed. Please tick it again and send.";
  function publicPass(action, token) {
    if (!enabled()) return Promise.resolve({ ok: true, pass: null });
    if (!ACTIONS[action]) return Promise.resolve({ ok: false, message: FAILED });
    if (!token) return Promise.resolve({ ok: false, message: "Please complete the security check first." });
    var cfg = global.SUPABASE_CONFIG || {}, base = String(cfg.url || "").replace(/\/+$/, "");
    if (!base || !cfg.anonKey) return Promise.resolve({ ok: true, pass: null });
    return global.fetch(base + "/functions/v1/captcha-verify", { method: "POST", credentials: "omit",
      headers: { "Content-Type": "application/json", apikey: cfg.anonKey, Authorization: "Bearer " + cfg.anonKey },
      body: JSON.stringify({ action: action, token: token }) })
      .then(function (r) {
        return r.json().then(function (j) { return { status: r.status, j: j || {} }; }, function () { return { status: r.status, j: {} }; });
      })
      .then(function (x) {
        if (x.status === 200 && x.j.ok === true) {
          if (x.j.configured === false) return { ok: true, pass: null };
          return UUID.test(String(x.j.pass || "")) ? { ok: true, pass: String(x.j.pass) } : { ok: true, pass: null };
        }
        if (x.status === 429) return { ok: false, message: "Too many tries. Please wait a minute and try again." };
        if (x.status === 403) return { ok: false, message: FAILED };
        return { ok: false, message: "The security check couldn't be confirmed just now. Please try again." };
      }, function () { return { ok: false, message: "No connection. Check your internet and try again." }; });
  }
  // One widget for one public form: guard(host, action) -> null when off; else { pass() -> Promise<publicPass answer> }.
  // pass() uses the current token once and resets the widget (Cloudflare tokens are single-use).
  function guard(host, action) {
    var cap = mount(host, { action: action });
    if (!cap) return null;
    return {
      ready: cap.ready,
      pass: function () {
        var t = cap.token();
        return publicPass(action, t).then(function (r) { if (t) cap.reset(); return r; });
      },
    };
  }
  global.HelmCaptcha = { mount: mount, enabled: enabled, siteKey: siteKey, publicPass: publicPass, guard: guard };
})(window);
