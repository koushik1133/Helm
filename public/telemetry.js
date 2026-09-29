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
  function redact(s) {
    if (s == null) return s;
    try {
      return String(s)
        .replace(/eyJ[A-Za-z0-9._-]{10,}/g, '[JWT_REDACTED]')
        .replace(/(access_token|refresh_token|apikey|api_key|authorization|bearer)["':=\s]+[^\s"'&]+/gi, '$1=[REDACTED]')
        .replace(/\b\d{6}\b(?=.*\botp\b)/gi, '[OTP_REDACTED]')
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL_REDACTED]')
        .replace(/\b(?:\+?\d[ -]?){9,13}\d\b/g, '[PHONE_REDACTED]');
    } catch (e) { return '[unredactable]'; }
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
  // DSN is set. Requires the CSP to allow browser.sentry-cdn.com + *.ingest.sentry.io
  // (already added in vercel.json). To enable in production: set window.HELM_TELEMETRY
  // = { dsn, env, release } in config.js — nothing else.
  function loadSentry() {
    if (!ENABLED || (typeof window === 'undefined') || window.Sentry || CFG.loadSentry === false) return;
    try {
      var sc = document.createElement('script');
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
              beforeSend: function (ev) {
                try {
                  if (ev.message) ev.message = redact(ev.message);
                  if (ev.request && ev.request.url) ev.request.url = redact(ev.request.url);
                  if (ev.exception && ev.exception.values) ev.exception.values.forEach(function (v) { if (v && v.value) v.value = redact(v.value); });
                } catch (e) {}
                return ev;
              }
            });
          }
        } catch (e) {}
      };
      document.head.appendChild(sc);
    } catch (e) { /* never break the app */ }
  }

  if (typeof window !== 'undefined') {
    window.addEventListener('error', function (e) { report('error', e && (e.error || { message: e.message })); });
    window.addEventListener('unhandledrejection', function (e) { report('unhandledrejection', e && e.reason); });
    window.HelmTelemetry = { report: report, redact: redact, enabled: ENABLED };
    loadSentry();
  }
})();
