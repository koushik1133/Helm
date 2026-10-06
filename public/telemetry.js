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
  var CFG = (typeof window !== 'undefined' && window.HELM_TELEMETRY) || {};
  var ENABLED = !!CFG.dsn;

  // Redact anything that looks like a token/JWT/OTP/email/phone from a string.
  // Client links carry bearer tokens in the URL itself, so these are scrubbed too
  // (audit Phase 9): the <ref> of /<studio>/<invite|quote|proposal|portal|work>/<ref>,
  // the slug of /i/<slug>, query/fragment tokens (?token= &t= #access_token= …) and
  // any bare UUID (approval / portal / crew / proposal tokens are UUIDs).
  var LINK_PATH = /(\/[a-z0-9-]{1,40}\/(?:invite|quote|proposal|portal|work)\/)[^\/?#\s"'<>]+/gi;
  var INVITE_PATH = /(\/i\/)[^\/?#\s"'<>]+/g;
  var QUERY_TOKEN = /([?&#;](?:token|t|ref|slug|code|key|access_token|refresh_token|provider_token|provider_refresh_token)=)[^&#\s"'<>]*/gi;
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
        .replace(/\b(?:\+?\d[ -]?){9,13}\d\b/g, '[PHONE_REDACTED]');
    } catch (e) { return '[unredactable]'; }
  }

  // Breadcrumbs (navigation from/to, fetch/xhr url, console/ui messages) carry
  // URLs with client-link tokens — scrub every string field of crumb.data.
  function redactBreadcrumb(crumb) {
    try {
      if (!crumb) return crumb;
      if (crumb.message) crumb.message = redact(crumb.message);
      if (crumb.data && typeof crumb.data === 'object') {
        Object.keys(crumb.data).forEach(function (k) {
          if (typeof crumb.data[k] === 'string') crumb.data[k] = redact(crumb.data[k]);
        });
      }
    } catch (e) {}
    return crumb;
  }
  // Every URL-bearing field of a Sentry event: message, request url / query /
  // Referer header, transaction name, exception values, breadcrumbs.
  function redactEvent(ev) {
    try {
      if (!ev) return ev;
      if (ev.message) ev.message = redact(ev.message);
      if (ev.transaction) ev.transaction = redact(ev.transaction);
      if (ev.request) {
        if (ev.request.url) ev.request.url = redact(ev.request.url);
        if (ev.request.query_string) ev.request.query_string = '[REDACTED]';
        if (ev.request.cookies) ev.request.cookies = '[REDACTED]';
        if (ev.request.headers) {
          Object.keys(ev.request.headers).forEach(function (k) {
            if (/^(referer|referrer|authorization|cookie)$/i.test(k)) ev.request.headers[k] = '[REDACTED]';
            else if (typeof ev.request.headers[k] === 'string') ev.request.headers[k] = redact(ev.request.headers[k]);
          });
        }
      }
      if (ev.exception && ev.exception.values) ev.exception.values.forEach(function (v) { if (v && v.value) v.value = redact(v.value); });
      var crumbs = ev.breadcrumbs && (Array.isArray(ev.breadcrumbs) ? ev.breadcrumbs : ev.breadcrumbs.values);
      if (Array.isArray(crumbs)) crumbs.forEach(redactBreadcrumb);
    } catch (e) {}
    return ev;
  }

  function report(kind, payload) {
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
      } else if (navigator.sendBeacon) {
        navigator.sendBeacon(CFG.dsn, JSON.stringify(safe));
      }
    } catch (e) { /* telemetry must never break the app */ }
  }

  // When a DSN is configured but no reporter SDK is present yet, lazy-load the Sentry
  // browser SDK and init it (redaction-aware via beforeSend). Completely NO-OP when no
  // DSN is set. Requires the CSP to allow https://browser.sentry-cdn.com/8.35.0/ +
  // *.ingest.sentry.io (already in vercel.json; the script-src entry is pinned to this
  // version's directory — change both together, see scripts/csp-hashes.cjs). To enable in production: set window.HELM_TELEMETRY
  // = { dsn, env, release } in config.js — nothing else.
  function loadSentry() {
    if (!ENABLED || (typeof window === 'undefined') || window.Sentry || CFG.loadSentry === false) return;
    try {
      var sc = document.createElement('script');
      // Pinned CDN bundle. NOT self-hosted / no SRI yet: @sentry/browser@8.35.0 on npm
      // does not ship build/bundles/, so no byte-identical file could be verified.
      // See public/vendor/README.md for how to vendor it with an integrity hash.
      sc.src = 'https://browser.sentry-cdn.com/8.35.0/bundle.min.js';
      sc.crossOrigin = 'anonymous';
      sc.onload = function () {
        try {
          if (window.Sentry && window.Sentry.init) {
            window.Sentry.init({
              dsn: CFG.dsn,
              environment: CFG.env || 'production',
              release: CFG.release || undefined,
              tracesSampleRate: CFG.tracesSampleRate || 0,
              sendDefaultPii: false,
              beforeSend: redactEvent,
              beforeBreadcrumb: redactBreadcrumb
            });
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
      report('error', err || { message: msg });
      showErrorToast();
    });
    window.addEventListener('unhandledrejection', function (e) {
      var r = e && e.reason, msg = r && (r.message || (typeof r === 'string' ? r : '')) || '';
      if (isNoise(msg || 'rejection', null, r && r.stack, r)) return;
      report('unhandledrejection', r);
      showErrorToast();
    });
    window.HelmTelemetry = { report: report, redact: redact, redactEvent: redactEvent, redactBreadcrumb: redactBreadcrumb, enabled: ENABLED };
    loadSentry();
  }
})();
