/* =========================================================================
   google-gis.js - r26: "Continue with Google" ON helm.events (free, no Supabase add-on).
   Google Identity Services (https://accounts.google.com/gsi/client) shows Google's own button; the person
   picks an account in Google's pop-up, which names helm.events (never the supabase.co project address the
   redirect flow showed). Google gives this page a signed ID token; BPStore.auth.signInWithGoogleIdToken()
   hands it to Supabase (signInWithIdToken) with the RAW nonce - Google only ever sees its SHA-256 (hex), as
   the Supabase docs require. login.html then reloads itself and finishes exactly like the redirect flow.

   Switch: window.HELM_FEATURES.googleGis (public/config.js; on for helm.events + www, off elsewhere) and
   window.HELM_GOOGLE.clientId (the PUBLIC OAuth web client ID). Off, or the Google script can't load
   (blocked / offline / 6 s timeout), or Supabase refuses the token -> the classic "Continue with Google"
   button (redirect flow) stays / comes back, so Google sign-in never just stops working.
   CSP: script-src https://accounts.google.com/gsi/client, frame-src + connect-src
   https://accounts.google.com/gsi/, style-src https://accounts.google.com/gsi/style - sign-in pages only
   (scripts/csp-hashes.cjs). DOM via createElement / textContent only.
   r26 hotfix: Google's script first draws an UNSTYLED placeholder (a page-sized "G" logo + "Continue with Google")
   because its inline <style> is refused by our CSP; its real button arrives later as an iframe. So Google's box stays
   invisible (still laid out, fixed 44px, clipped - "gis-wait") and OUR styled classic button stays in its place until
   that iframe has loaded; no iframe within 8 s -> the classic button simply stays (fallback).
   ========================================================================= */
(function (global) {
  "use strict";
  var doc = global.document;
  var SRC = "https://accounts.google.com/gsi/client";
  var LOAD_TIMEOUT_MS = 6000;
  var SHOW_TIMEOUT_MS = 8000;
  var CLIENT_ID_RE = /^[0-9]{6,20}-[a-z0-9]{10,64}\.apps\.googleusercontent\.com$/;

  // Pure: is the GIS button wanted? (flag on + a well-formed public client ID + the browser can hash)
  function enabled(features, clientId, cryptoObj) {
    if (!features || features.googleGis !== true) return false;
    if (!CLIENT_ID_RE.test(String(clientId || ""))) return false;
    return !!(cryptoObj && cryptoObj.getRandomValues && cryptoObj.subtle && cryptoObj.subtle.digest);
  }
  function b64url(bytes) {
    var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return global.btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function hex(buf) {
    var b = new Uint8Array(buf), out = "";
    for (var i = 0; i < b.length; i++) out += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return out;
  }
  // -> { raw, hashed }: raw (43 chars base64url, 32 random bytes) goes to Supabase; hashed = SHA-256 hex goes to Google
  function makeNonce(cryptoObj) {
    var c = cryptoObj || global.crypto;
    var raw = b64url(c.getRandomValues(new Uint8Array(32)));
    return Promise.resolve(c.subtle.digest("SHA-256", new global.TextEncoder().encode(raw)))
      .then(function (h) { return { raw: raw, hashed: hex(h) }; });
  }
  function gid() { try { return global.google && global.google.accounts && global.google.accounts.id; } catch (e) { return null; } }
  // Calls onLoad once Google's button iframe inside `slot` has loaded (MutationObserver + the iframe's load event;
  // a light poll where MutationObserver is missing). Returns stop().
  function whenIframeLoads(slot, onLoad) {
    var hooked = null, mo = null, timer = 0, stopped = false;
    function stop() { stopped = true; try { if (mo) mo.disconnect(); } catch (e) {} if (timer && global.clearInterval) global.clearInterval(timer); }
    function hook() {
      if (stopped || hooked) return;
      var f = null; try { f = slot.querySelector && slot.querySelector("iframe"); } catch (e) {}
      if (!f) return;
      hooked = f;
      if (mo) f.addEventListener("load", function () { if (!stopped) { stop(); onLoad(); } });
      else { stop(); onLoad(); }   // no MutationObserver: the poll found it late, show it
    }
    if (typeof global.MutationObserver === "function") {
      mo = new global.MutationObserver(hook);
      mo.observe(slot, { childList: true, subtree: true });
    } else if (global.setInterval) timer = global.setInterval(hook, 150);
    hook();
    return stop;
  }
  var loadPromise = null;
  function load(timeoutMs) {
    if (gid()) return Promise.resolve(true);
    if (loadPromise) return loadPromise;
    loadPromise = new Promise(function (resolve) {
      var done = false;
      var finish = function (ok) { if (done) return; done = true; if (!ok) loadPromise = null; resolve(ok); };
      var s = doc.createElement("script");
      s.src = SRC; s.async = true; s.defer = true;
      s.onload = function () { finish(!!gid()); };
      s.onerror = function () { finish(false); };
      global.setTimeout(function () { finish(!!gid()); }, timeoutMs || LOAD_TIMEOUT_MS);
      (doc.head || doc.documentElement).appendChild(s);
    });
    return loadPromise;
  }

  /* attach(opts) -> null (off: the classic button stays) or a controller { ready, refresh(), fallback(), active() }
     opts.button       the classic "Continue with Google" button (redirect flow) - the fallback; GIS sits right after it
     opts.root         element that gets class "gis-on" while Google's own button is shown (default document.body)
     opts.needsAgree() true while a NEW account still has to tick "I agree to the Terms" (a shield over Google's
                       button then calls opts.onBlocked() instead of opening Google)
     opts.onCredential(idToken, rawNonce) -> Promise   sign in with it (the page reloads on success)
     opts.oneTap / opts.isSignin()   optional Google One Tap prompt on plain sign-in (off by default) */
  function attach(opts) {
    opts = opts || {};
    var features = global.HELM_FEATURES || {}, g = global.HELM_GOOGLE || {};
    if (!opts.button || !enabled(features, g.clientId, global.crypto)) return null;
    var root = opts.root || doc.body;
    var wrap = doc.createElement("div"); wrap.className = "gis-wrap gis-wait"; wrap.hidden = true;
    var slot = doc.createElement("div"); slot.className = "gis-btn"; slot.id = "gisBtn";
    var shield = doc.createElement("button"); shield.type = "button"; shield.className = "gis-shield"; shield.hidden = true;
    shield.setAttribute("aria-label", "Continue with Google");
    shield.addEventListener("click", function () { if (opts.onBlocked) opts.onBlocked(); });
    wrap.appendChild(slot); wrap.appendChild(shield);
    if (opts.button.parentNode) opts.button.parentNode.insertBefore(wrap, opts.button.nextSibling);
    var state = "loading", busy = false, nonce = null, stopWatch = null, shown = null;
    var ctl = {
      active: function () { return state === "on"; },
      refresh: function () { shield.hidden = !(state === "on" && opts.needsAgree && opts.needsAgree()); },
      fallback: function () {
        state = "off"; wrap.hidden = true; wrap.className = "gis-wrap gis-wait";
        if (stopWatch) { stopWatch(); stopWatch = null; }
        if (root && root.classList) root.classList.remove("gis-on");
        if (shown) { shown(false); shown = null; }
      },
    };
    // ctl.shown: true once Google's real button is visible, false if the classic button stayed
    ctl.shown = new Promise(function (r) { shown = r; });
    function reveal() {
      if (state !== "wait") return;
      state = "on"; wrap.className = "gis-wrap";
      if (root && root.classList) root.classList.add("gis-on");
      ctl.refresh();
      if (shown) { shown(true); shown = null; }
    }
    function onResponse(resp) {
      var token = resp && resp.credential;
      if (busy || (state !== "on" && state !== "wait") || !token || !nonce) return;
      if (opts.needsAgree && opts.needsAgree()) { if (opts.onBlocked) opts.onBlocked(); ctl.refresh(); return; }
      busy = true;
      Promise.resolve().then(function () { return opts.onCredential(token, nonce.raw); })
        .catch(function () {}).then(function () { busy = false; });
    }
    ctl.ready = Promise.all([load(opts.timeoutMs), makeNonce(global.crypto).catch(function () { return null; })]).then(function (r) {
      var id = gid();
      if (state === "off") return false;
      if (!r[0] || !r[1] || !id) { ctl.fallback(); return false; }
      nonce = r[1];
      // laid out but invisible (gis-wait) while Google draws; our classic button stays visible + clickable meanwhile
      state = "wait"; wrap.hidden = false;
      stopWatch = whenIframeLoads(slot, reveal);
      global.setTimeout(function () { if (state === "wait") ctl.fallback(); }, opts.showTimeoutMs || SHOW_TIMEOUT_MS);
      try {
        id.initialize({
          client_id: g.clientId,
          callback: onResponse,
          nonce: nonce.hashed,
          context: "signin",
          ux_mode: "popup",
          auto_select: false,
          cancel_on_tap_outside: true,
          itp_support: true,
          use_fedcm_for_prompt: true,
          use_fedcm_for_button: true
        });
        var w = 0; try { w = Math.round(opts.button.getBoundingClientRect().width); } catch (e) {}
        id.renderButton(slot, { type: "standard", theme: "outline", size: "large", text: "continue_with", shape: "rectangular",
          logo_alignment: "center", width: Math.max(200, Math.min(400, w || 320)) });
      } catch (e) { ctl.fallback(); return false; }
      if (opts.oneTap === true && (!opts.isSignin || opts.isSignin())) { try { id.prompt(); } catch (e) {} }
      return true;
    });
    return ctl;
  }
  global.HelmGoogleGis = { attach: attach, enabled: enabled, makeNonce: makeNonce, load: load, _hex: hex, SRC: SRC };
})(typeof window !== "undefined" ? window : this);
