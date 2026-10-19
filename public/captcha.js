/* =========================================================================
   captcha.js - r21: the Cloudflare Turnstile widget for pages that do not load auth-ui.js
   (today: checkout "Contact sales"). OFF while public/config.js captcha.siteKey is empty:
   mount() returns null, nothing is loaded, the form works exactly as before.
   The token is checked on the SERVER (captcha-verify edge function -> one-use pass the
   database needs while HQ's rpc_captcha_required switch is on, migration 0249).
   CSP: script + frame from https://challenges.cloudflare.com are allowed on /checkout only
   (scripts/csp-hashes.cjs). DOM via createElement / textContent only.
   ========================================================================= */
(function (global) {
  "use strict";
  var doc = global.document;
  var tsPromise = null;
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
  function enabled() {
    try { var S = global.BPStore; return !!(S && S.auth && S.auth.captcha && S.auth.captcha.enabled()); } catch (e) { return false; }
  }
  // -> null when CAPTCHA is off; else { ready, token(), reset() }
  function mount(host, opts) {
    if (!host || !enabled()) return null;
    var token = null, wid = null, S = global.BPStore;
    host.hidden = false;
    var ready = load().then(function (ok) {
      if (!ok || !global.turnstile) { host.textContent = "The security check couldn't load. Check your connection (or pause content blockers) and reload the page."; return false; }
      wid = global.turnstile.render(host, {
        sitekey: S.auth.captcha.siteKey(),
        action: (opts && opts.action) || "form",
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
  global.HelmCaptcha = { mount: mount, enabled: enabled };
})(window);
