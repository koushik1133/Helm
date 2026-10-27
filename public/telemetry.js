/* ============================================================================
 * telemetry.js — bounded, env-aware client error reporting (OBS-01).
 * ---------------------------------------------------------------------------
 * The app is a static site talking directly to Supabase, so there is no server
 * to collect errors. This module is the INTEGRATION POINT for a browser error
 * reporter (e.g. Sentry) plus a global error/rejection capture. It is a NO-OP
 * until a DSN is provided at runtime — NO secret/DSN is committed here.
 *
 * STATUS: code-ready, NOT live. Monitoring is not "on" until an operator sets a
 * DSN (see docs/RUNBOOK.md). Do not claim monitoring is active without it.
 *
 * Enable by setting BEFORE this script loads:
 *     window.HELM_TELEMETRY = { dsn: 'https://…', env: 'production', release: 'YYYY-MM-DD' };
 * and (optionally) loading a reporter SDK that exposes window.Sentry.
 *
 * SAFETY: never logs access tokens, the anon/JWT key, OTP codes, or full PII.
 * ========================================================================== */
(function () {
  'use strict';
  // r21: read LAZILY - config.js (which sets window.HELM_TELEMETRY) loads right AFTER this file on every page,
  // so the DSN is looked up when a report is sent / at DOMContentLoaded, not only at parse time.
  var CFG = {}, ENABLED = false;
  function refresh() {
    var c = (typeof window !== 'undefined' && window.HELM_TELEMETRY) || {};
    CFG = (c && typeof c === 'object') ? c : {};
    ENABLED = typeof CFG.dsn === 'string' && /^https:\/\/[0-9A-Za-z]{1,64}@o\d{1,12}\.ingest(\.[a-z]{2})?\.sentry\.io\/\d{1,12}$/.test(CFG.dsn)
      // r26: never from a developer's own machine (config.js sets env "development" on localhost) unless asked
      && !(CFG.env === 'development' && !CFG.allowDev);
    return ENABLED;
  }
  refresh();

  // Redact anything that looks like a token/JWT/OTP/email/phone from a string.
  // Client links carry bearer tokens in the URL itself, so these are scrubbed too
  // (audit Phase 9): the <ref> of /<studio>/<invite|quote|proposal|portal|work|booklet>/<ref>,
  // the slug of /i/<slug>, query/fragment tokens (?token= &t= #access_token= …) and
  // any bare UUID (approval / portal / crew / proposal tokens are UUIDs).
  var LINK_PATH = /(\/[a-z0-9-]{1,40}\/(?:invite|quote|proposal|portal|work|booklet)\/)[^\/?#\s"'<>]+/gi;
  var INVITE_PATH = /(\/i\/)[^\/?#\s"'<>]+/g;
  // r26: + quote / invite / lead ids, e-mail / phone / OTP / captcha pass values passed in a query
  var QUERY_TOKEN = /([?&#;](?:token|t|k|ref|slug|code|key|access_token|refresh_token|provider_token|provider_refresh_token|quote|quote_id|q|invite|lead|lead_id|pass|captcha|otp|email|phone|mobile)=)[^&#\s"'<>]*/gi;
  // r26: money - an amount with its currency (Rs / INR / USD / AED / symbols) never leaves the browser
  var MONEY = /(?:\u20b9|\bRs\.?|\bINR|\bUSD|\bAED|\bUS\$|\$|\u20ac|\u00a3)\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:INR|USD|AED|rupees)\b/gi;
  var UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  function redact(s) {
    if (s == null) return s;
    try {
      return String(s)
        .replace(LINK_PATH, '$1[REDACTED]')
        .replace(INVITE_PATH, '$1[REDACTED]')
        .replace(QUERY_TOKEN, '$1[REDACTED]')
        .replace(UUID, '[UUID_REDACTED]')
        .replace(/eyJ[A-Za-z0-9._-]{10,}/g, '[JWT_REDACTED]')
        .replace(/(access_token|refresh_token|apikey|api_key|authorization|bearer)["':=\s]+[^\s"'&]+/gi, '$1=[REDACTED]')
        .replace(/\b\d{6}\b(?=.*\botp\b)/gi, '[OTP_REDACTED]')
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL_REDACTED]')
        .replace(MONEY, '[AMOUNT_REDACTED]')
        .replace(/\b(?:\+?\d[ -]?){9,13}\d\b/g, '[PHONE_REDACTED]');
    } catch (e) { return '[unredactable]'; }
  }

  // r26: a URL FIELD (request url, navigation from/to, fetch/xhr url) loses its whole query string and
  // fragment - only an asset version "?v=N" is kept (it names the file, not a person). Free text keeps
  // ordinary queries (redact() above still scrubs token-like values in them).
  function stripUrl(u) {
    if (typeof u !== 'string') return u;
    var m = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(u);
    if (!m) return redact(u);
    var q = m[2] && /^\?v=\d{1,9}$/.test(m[2]) ? m[2] : '';
    return redact(m[1]) + q;
  }
  var URL_KEYS = /^(url|from|to|href)$/i;
  // Breadcrumbs (navigation from/to, fetch/xhr url, console/ui messages) carry
  // URLs with client-link tokens — scrub every string field of crumb.data.
  function redactBreadcrumb(crumb) {
    try {
      if (!crumb) return crumb;
      if (crumb.message) crumb.message = redact(crumb.message);
      if (crumb.data && typeof crumb.data === 'object') {
        Object.keys(crumb.data).forEach(function (k) {
          if (typeof crumb.data[k] === 'string') crumb.data[k] = URL_KEYS.test(k) ? stripUrl(crumb.data[k]) : redact(crumb.data[k]);
        });
      }
    } catch (e) {}
    return crumb;
  }
  // r26: errors that come from browser add-ons / injected scripts, never from Helm
  var EXT_URL = /(chrome|moz|safari|safari-web|ms-browser)-extension:\/\/|webkit-masked-url:|extension:\/\/|^chrome:\/\//i;
  function fromExtension(ev) {
    try {
      var vals = (ev && ev.exception && ev.exception.values) || [];
      for (var i = 0; i < vals.length; i++) {
        var fr = (vals[i] && vals[i].stacktrace && vals[i].stacktrace.frames) || [];
        for (var j = 0; j < fr.length; j++) if (fr[j] && EXT_URL.test(String(fr[j].filename || fr[j].abs_path || ''))) return true;
      }
    } catch (e) {}
    return false;
  }
  // Every URL-bearing field of a Sentry event: message, request url / query /
  // Referer header, transaction name, exception values, breadcrumbs.
  function redactEvent(ev) {
    try {
      if (!ev) return ev;
      if (fromExtension(ev)) return null;   // r26: drop add-on noise (Sentry: returning null = not sent)
      if (ev.message) ev.message = redact(ev.message);
      if (ev.transaction) ev.transaction = stripUrl(ev.transaction);
      // r26: no person on an event - at most an opaque id, never e-mail / name / IP
      if (ev.user) ev.user = ev.user.id ? { id: String(ev.user.id).slice(0, 64) } : undefined;
      if (ev.extra && typeof ev.extra === 'object') Object.keys(ev.extra).forEach(function (k) { if (typeof ev.extra[k] === 'string') ev.extra[k] = redact(ev.extra[k]); });
      if (ev.request) {
        if (ev.request.url) ev.request.url = stripUrl(ev.request.url);
        if (ev.request.data) ev.request.data = '[REDACTED]';
        if (ev.request.query_string) ev.request.query_string = '[REDACTED]';
        if (ev.request.cookies) ev.request.cookies = '[REDACTED]';
        if (ev.request.headers) {
          Object.keys(ev.request.headers).forEach(function (k) {
            if (/^(referer|referrer|authorization|cookie)$/i.test(k)) ev.request.headers[k] = '[REDACTED]';
            else if (typeof ev.request.headers[k] === 'string') ev.request.headers[k] = redact(ev.request.headers[k]);
          });
        }
      }
      if (ev.exception && ev.exception.values) ev.exception.values.forEach(function (v) {
        if (v && v.value) v.value = redact(v.value);
        // R32 CLI-02: each stack frame names the page it ran on - e.g. approve.html?token=<uuid> - so the
        // frame file / path loses its query + fragment and link tokens like every other URL field
        var fr = v && v.stacktrace && v.stacktrace.frames;
        if (Array.isArray(fr)) fr.forEach(function (f) {
          if (!f) return;
          if (typeof f.filename === 'string') f.filename = stripUrl(f.filename);
          if (typeof f.abs_path === 'string') f.abs_path = stripUrl(f.abs_path);
          if (typeof f.module === 'string') f.module = redact(f.module);
        });
      });
      var crumbs = ev.breadcrumbs && (Array.isArray(ev.breadcrumbs) ? ev.breadcrumbs : ev.breadcrumbs.values);
      if (Array.isArray(crumbs)) crumbs.forEach(redactBreadcrumb);
    } catch (e) {}
    return ev;
  }

  function report(kind, payload) {
    refresh();
    var safe = {
      kind: kind,
      env: CFG.env || 'unknown',
      release: CFG.release || null,
      at: new Date().toISOString(),
      url: (typeof location !== 'undefined') ? redact(location.pathname) : null, // path only, never query (no PII/tokens in URL)
      message: redact(payload && (payload.message || payload.reason || payload)),
      stack: redact(payload && payload.stack),
    };
    if (!ENABLED) { if (CFG.debug) console.debug('[telemetry:noop]', safe); return; }
    try {
      if (window.Sentry && typeof window.Sentry.captureException === 'function') {
        window.Sentry.captureException(payload, { extra: safe });
      } else if (pending.length < 10) {
        // r26: the SDK is still loading - keep the first few and send them once it is ready (never a
        // hand-made beacon to the DSN: that is not Sentry's format and would carry no redaction hooks)
        pending.push([payload, safe]);
      }
    } catch (e) { /* telemetry must never break the app */ }
  }
  var pending = [];
  function flushPending() {
    var list = pending; pending = [];
    try { list.forEach(function (p) { window.Sentry.captureException(p[0], { extra: p[1] }); }); } catch (e) {}
  }
  // r26: performance tracing is capped at 10% (0 = off, the default; the plain bundle has no tracing anyway)
  function traceRate(v) { var n = Number(v); return n > 0 ? Math.min(n, 0.1) : 0; }

  // When a DSN is configured but no reporter SDK is present yet, lazy-load the Sentry
  // browser SDK and init it (redaction-aware via beforeSend). Completely NO-OP when no
  // DSN is set. The CSP already allows the script (https://browser.sentry-cdn.com/8.35.0/,
  // pinned to this version's directory - change both together, see scripts/csp-hashes.cjs).
  // connect-src deliberately has NO Sentry ingest host while telemetry is dormant (audit
  // run-3 client/csp: a *.ingest.sentry.io wildcard lets any Sentry org receive data).
  // To enable: set window.HELM_TELEMETRY = { dsn, env, release } in config.js AND add the
  // DSN's EXACT ingest host (e.g. https://o123456.ingest.us.sentry.io) to connect-src in
  // server.js CSP_BASE, vercel.json and public/_headers (no wildcard).
  var SENTRY_SRC = 'https://browser.sentry-cdn.com/8.35.0/bundle.min.js';
  var SENTRY_SRI = 'sha384-j1K2/oFJn/QPiNs/Fk58NwXcaEbWzaUEF04vKMBnEprfbZ2hIQrAO0yc0XEfai1E';
  var sentryArmed = false, sentryReady = false;
  function loadSentry() {
    refresh();
    if (sentryArmed || !ENABLED || (typeof window === 'undefined') || window.Sentry || CFG.loadSentry === false) return;
    sentryArmed = true;
    try {
      var sc = document.createElement('script');
      // Pinned CDN bundle WITH Subresource Integrity (audit run-3
      // supply-chain/telemetry/sentry-cdn-script-no-sri): the browser refuses to run
      // the file unless its bytes hash to this value. The sha384 is Sentry's own
      // published checksum for 8.35.0 bundle.min.js (release-registry.services.sentry.io
      // sdks/sentry.javascript.browser/8.35.0) and was re-computed from the CDN bytes
      // on 2026-10-17 - both match. Changing the version means changing src, this
      // hash and the CSP script-src directory (scripts/csp-hashes.cjs) together.
      sc.src = SENTRY_SRC;
      sc.integrity = SENTRY_SRI;
      sc.crossOrigin = 'anonymous';
      sc.onload = function () {
        try {
          if (window.Sentry && window.Sentry.init) {
            window.Sentry.init({
              dsn: CFG.dsn,
              environment: CFG.env || 'production',
              release: CFG.release || undefined,
              sampleRate: 1.0,                                  // every error
              tracesSampleRate: traceRate(CFG.tracesSampleRate), // 0 .. 0.1
              sendDefaultPii: false,
              maxBreadcrumbs: 30,
              // r26: noise that is never a Helm bug (browser quirks, add-ons, the visitor's own network)
              ignoreErrors: ['ResizeObserver loop limit exceeded', 'ResizeObserver loop completed with undelivered notifications',
                /^Script error\.?$/, 'Non-Error promise rejection captured', /AbortError/, /The user aborted a request/,
                'Failed to fetch', 'Load failed', 'NetworkError when attempting to fetch resource.', /^Network request failed/,
                /webkit-masked-url/, /__gCrWeb/, /instantSearchSDKJSBridgeClearHighlight/],
              denyUrls: [/extensions\//i, /^chrome:\/\//i, /^chrome-extension:\/\//i, /^moz-extension:\/\//i, /^safari(-web)?-extension:\/\//i, /webkit-masked-url/i],
              beforeSend: redactEvent,
              beforeBreadcrumb: redactBreadcrumb
            });
            sentryReady = true;
            flushPending();
          }
        } catch (e) {}
      };
      document.head.appendChild(sc);
    } catch (e) { /* never break the app */ }
  }

  // ---- user-facing error toast (via BPUI from store-api.js, when loaded) ----
  // Non-spammy: at most one "Something went wrong — Reload" toast per 10s, and
  // never for known noise (ResizeObserver loop warnings, browser-extension
  // errors, opaque cross-origin "Script error.", aborted requests).
  var lastToastAt = 0;
  var EXT_RE = /(chrome|moz|safari|safari-web|ms-browser)-extension:\/\/|webkit-masked-url:|extension:\/\//i;
  function isNoise(msg, file, stack, err) {
    var m = String(msg || '');
    if (/ResizeObserver loop/i.test(m)) return true;
    if (/^Script error\.?$/i.test(m.trim()) || (!m && !stack && !file)) return true;   // cross-origin, no detail
    if (EXT_RE.test(String(file || '')) || EXT_RE.test(String(stack || ''))) return true;
    if (err && (err.name === 'AbortError' || /aborted|The user aborted/i.test(m))) return true;
    return false;
  }
  function showErrorToast() {
    try {
      var UI = window.BPUI;
      if (!UI || typeof UI.toast !== 'function') return;
      var t = Date.now();
      if (t - lastToastAt < 10000) return;   // de-dupe within 10s
      lastToastAt = t;
      UI.toast('Something went wrong.', { type: 'err', timeout: 10000,
        action: { label: 'Reload', onClick: function () { location.reload(); } } });
    } catch (e) { /* never break the app */ }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('error', function (e) {
      var err = e && e.error, msg = (e && e.message) || (err && err.message) || '';
      if (isNoise(msg, e && e.filename, err && err.stack, err)) return;
      if (!sentryReady) report('error', err || { message: msg });   // once Sentry runs it records this itself (no double)
      showErrorToast();
    });
    window.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason, msg = r && (r.message || (typeof r === 'string' ? r : '')) || '';
      if (isNoise(msg || 'rejection', null, r && r.stack, r)) return;
      if (!sentryReady) report('unhandledrejection', r);
      showErrorToast();
    });
    window.HelmTelemetry = { report: report, redact: redact, stripUrl: stripUrl, redactEvent: redactEvent, redactBreadcrumb: redactBreadcrumb, enabled: ENABLED,
      isEnabled: function () { return refresh(); } };
    loadSentry();
    window.addEventListener('DOMContentLoaded', function () { loadSentry(); try { window.HelmTelemetry.enabled = ENABLED; } catch (e) {} });
  }
})();
