/* ============================================================================
 * csp-hashes.cjs — the SHA-256 hashes of every inline <script> in public/.
 *
 * script-src no longer allows 'unsafe-inline'; each inline block the pages ship
 * is allowed by its exact hash instead, so an injected <script> or on*= handler
 * is refused by the browser even if some escaping bug lets markup through.
 *
 * Used by scripts/gen-csp.mjs (writes vercel.json + public/_headers, and
 * `--check` fails CI when they are stale) and by server.js (computes the same
 * list at startup, so local dev can never drift from the files on disk).
 * ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// JS types the browser executes; data blocks (application/ld+json, templates)
// are never run, so CSP does not need (or want) their hashes.
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module']);

function htmlFiles(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...htmlFiles(p));
    else if (ent.name.endsWith('.html')) out.push(p);
  }
  return out;
}

// Inline scripts of one HTML document: [{ hash, line }]
function inlineScripts(html) {
  const res = [];
  // the element ends at "</script" + whitespace, "/" or ">" (HTML tokenizer rule)
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script(?=[\s/>])[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const t = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [, ''])[1].toLowerCase();
    if (!JS_TYPES.has(t)) continue;
    const hash = "'sha256-" + crypto.createHash('sha256').update(m[2], 'utf8').digest('base64') + "'";
    res.push({ hash, line: html.slice(0, m.index).split('\n').length });
  }
  return res;
}

// Inline <style> blocks of one HTML document: [{ hash, line }]
function inlineStyles(html) {
  const res = [];
  const re = /<style\b([^>]*)>([\s\S]*?)<\/style(?=[\s/>])[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const hash = "'sha256-" + crypto.createHash('sha256').update(m[2], 'utf8').digest('base64') + "'";
    res.push({ hash, line: html.slice(0, m.index).split('\n').length });
  }
  return res;
}
function computeStyleHashes(publicDir) {
  const set = new Set();
  for (const f of htmlFiles(publicDir)) {
    for (const s of inlineStyles(fs.readFileSync(f, 'utf8'))) set.add(s.hash);
  }
  return [...set].sort();
}

// Sorted, de-duplicated hash list for every page under publicDir.
function computeHashes(publicDir) {
  const set = new Set();
  for (const f of htmlFiles(publicDir)) {
    for (const s of inlineScripts(fs.readFileSync(f, 'utf8'))) set.add(s.hash);
  }
  return [...set].sort();
}

// Rewrite the script-src directive of a CSP string: keep its host sources,
// drop 'unsafe-inline' and any old hashes, append the current hashes.
//
// With styleHashes (array), the style directives are rewritten too:
//   style-src       'self' <hosts> <style hashes>   (legacy fallback, no 'unsafe-inline')
//   style-src-elem  'self' <hosts> <style hashes>   (<style> blocks by hash; runtime CSS
//                                                    uses constructable sheets / CSSOM)
//   style-src-attr  'unsafe-inline'                 (static markup style="" were moved to
//                                                    classes — scripts/extract-inline-styles.mjs —
//                                                    but ~280 remain in JS-built templates; an
//                                                    attribute cannot load or run script)
//
// Trusted Types: public/trusted-types.js installs a `default` policy (allowlist
// sanitizer) plus the `helm` policy. Enforcement is a FLAG, off until every page
// has been exercised logged-in with zero violations (see docs in that file):
//   TRUSTED_TYPES_ENFORCE = true  → every policy gets
//     require-trusted-types-for 'script'; trusted-types helm default
// HELM_TRUSTED_TYPES=1 turns it on for the local server only (verification runs).
const TRUSTED_TYPES_ENFORCE = false;
const TT_DIRECTIVES = ["require-trusted-types-for 'script'", 'trusted-types helm default'];
const ttOn = () => TRUSTED_TYPES_ENFORCE || process.env.HELM_TRUSTED_TYPES === '1';
const isHash = (s) => /^'sha(256|384|512)-/.test(s);
function withHashes(csp, hashes, styleHashes) {
  const out = [];
  for (const d of csp.split(';')) {
    const parts = d.trim().split(/\s+/);
    if (!parts[0]) continue;
    if (parts[0] === 'require-trusted-types-for' || parts[0] === 'trusted-types') continue;
    if (parts[0] === 'script-src') {
      const keep = parts.slice(1).filter((s) => s !== "'unsafe-inline'" && !isHash(s));
      out.push(['script-src', ...keep, ...hashes].join(' '));
    } else if (styleHashes && (parts[0] === 'style-src-elem' || parts[0] === 'style-src-attr')) {
      continue;
    } else if (styleHashes && parts[0] === 'style-src') {
      const keep = parts.slice(1).filter((s) => s !== "'unsafe-inline'" && s !== "'unsafe-hashes'" && !isHash(s));
      out.push(['style-src', ...keep, ...styleHashes].join(' '));
      out.push(['style-src-elem', ...keep, ...styleHashes].join(' '));
      out.push("style-src-attr 'unsafe-inline'");
    } else out.push(d.trim());
  }
  if (ttOn()) out.push(...TT_DIRECTIVES);
  return out.join('; ');
}

// ---------------------------------------------------------------------------
// script-src HOST sources — the single allowlist (audit Phase 9, CSP-01).
// A whole-CDN host source (https://cdnjs.cloudflare.com, https://cdn.jsdelivr.net)
// lets an attacker who finds any HTML injection load an old gadget library from
// the same CDN and run script despite the hash-based policy. So:
//   • every page: only the pinned Sentry bundle directory (dormant until a DSN is
//     set — telemetry.js loads https://browser.sentry-cdn.com/8.35.0/bundle.min.js);
//   • the 3D builder only: the exact three.js r128 directories it loads
//     (public/builder-3d.js, every file also SRI-pinned).
// A source ending in "/" matches by path prefix (CSP3 §6.7.2.12), so nothing
// else on those CDNs is allowed. server.js builds its policies from these
// constants; scripts/gen-csp.mjs fails when vercel.json / public/_headers drift.
const SCRIPT_SRC_BASE = ["'self'", 'https://browser.sentry-cdn.com/8.35.0/'];
const SCRIPT_SRC_BUILDER = [...SCRIPT_SRC_BASE,
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/',
  'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/'];
// Pages (clean URL or .html) whose policy may use SCRIPT_SRC_BUILDER.
const BUILDER_SOURCES = new Set(['/builder', '/builder\\.html', '/builder.html', '/try', '/try.html', '/(builder|try)', '/(builder|try)\\.html', '/capture', '/capture\\.html', '/capture.html', '/(capture|capture\\.html)', '/([a-z0-9-]+)/events/([^/]+)/floor-plan', '/:studio/events/:ref/floor-plan',
  '/([a-z0-9-]+)/(events/[^/]+/floor-plan|builder)', '/:studio/builder']);   // 0067 pretty floor-plan URL serves builder.html; la-1018 /<studio>/builder too

// Sign-in / password-reset pages - and (r21) the checkout page's "Contact sales" form, (r26) the public forms - may
// also load the Cloudflare Turnstile CAPTCHA widget (a single-purpose origin, not a library
// CDN). Always allowed on those routes (script-src + frame-src only, never connect-src): the
// widget itself is only loaded when public/config.js has a site key, so with the key empty
// nothing is fetched and the allowance is inert.
const AUTH_ROUTE = /(^|\/|\()(login|reset|signup)/;   // r22: /signup = the login page (rewrite)
// r26: the signed-out public forms (home page Contact form, /contact-sales, /<studio>/enquiry, /suggest) - same allowance
const PUBLIC_FORM_ROUTE = /^\/((index|contact-sales|suggest|enquiry)(\.html|\\\.html)?|:studio\/enquiry)?$/;
const TURNSTILE = /^https:\/\/challenges\.cloudflare\.com(\/[^\s;]*)?$/;
// r26: "Continue with Google" on helm.events (public/google-gis.js) - Google Identity Services, the EXACT
// library URL only (script-src), plus its button / pop-up iframe + endpoints under /gsi/ (frame-src,
// connect-src) and its stylesheet (style-src). Only login.html loads it, but the sign-in pages share ONE
// vercel.json policy rule with the public forms (home / contact-sales / suggest / enquiry - r26 Turnstile),
// and a separate login-only CSP rule would push vercel.json over its 200 KB guard, so those routes allow
// the same exact /gsi/ paths. COOP same-origin-allow-popups (so Google's pop-up can hand the answer back
// in browsers without FedCM - Safari / Firefox) is set on the sign-in pages ONLY (own small rules).
const GIS_SCRIPT = 'https://accounts.google.com/gsi/client';
const GIS_ORIGIN_PATH = 'https://accounts.google.com/gsi/';
const GIS_STYLE = 'https://accounts.google.com/gsi/style';
const AUTH_COOP = 'same-origin-allow-popups';
// The onboarding checkout page (0056) only may load Razorpay Standard Checkout — the
// EXACT script URL, nothing else on that origin. Card / UPI / netbanking fields live
// in Razorpay's own iframe (frame-src), never in Helm's DOM.
const CHECKOUT_ROUTE = /(^|\/|\()checkout/;
const RAZORPAY_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';

// Host sources of a CSP's script-src (hashes / nonces dropped).
function scriptHosts(csp) {
  const d = String(csp || '').split(';').map((x) => x.trim().split(/\s+/)).find((p) => p[0] === 'script-src');
  return d ? d.slice(1).filter((s) => !/^'(sha(256|384|512)|nonce)-/.test(s)) : null;
}
// Problems with one policy's script-src for the given route ('' = no problem).
function scriptSrcProblem(csp, route) {
  const hosts = scriptHosts(csp);
  if (!hosts) return 'no script-src directive';
  // 'staging-site' = the ONE generated helm-v01.vercel.app (staging) rule: the union of
  // every page policy, so it may carry each page's own allowed sources — nothing more.
  if (route === 'staging-site') {
    const extraS = hosts.filter((h) => !SCRIPT_SRC_BUILDER.includes(h) && !SCRIPT_SRC_BASE.includes(h) && !TURNSTILE.test(h) && h !== RAZORPAY_SCRIPT && h !== GIS_SCRIPT);
    return extraS.length ? 'script-src allows ' + extraS.join(' ') : '';
  }
  const allowed = BUILDER_SOURCES.has(route) ? SCRIPT_SRC_BUILDER : SCRIPT_SRC_BASE;
  const extra = hosts.filter((h) => !allowed.includes(h) && !((AUTH_ROUTE.test(route) || CHECKOUT_ROUTE.test(route) || PUBLIC_FORM_ROUTE.test(route)) && TURNSTILE.test(h)) && !(CHECKOUT_ROUTE.test(route) && h === RAZORPAY_SCRIPT)
    && !((AUTH_ROUTE.test(route) || PUBLIC_FORM_ROUTE.test(route)) && h === GIS_SCRIPT));
  if (extra.length) return 'script-src allows ' + extra.join(' ') + (BUILDER_SOURCES.has(route) ? '' : ' (CDN sources are builder-only)');
  return '';
}

// R8b: the ONLY routes whose CSP may allow framing (frame-ancestors 'self'): the invitation
// preview (/invite, /i/<slug>) and the headless picture-capture host (capture.html, framed by the
// share checklist). Every other page — builder.html included — must stay frame-ancestors 'none'.
const FRAME_SELF_ROUTES = new Set(['/invite', '/invite\\.html', '/invite.html', '/i', '/i/(.*)', '/i/*',
  '/([a-z0-9-]+)/invite/([^/]+)', '/:studio/invite/:ref', '/capture', '/capture\\.html', '/capture.html', '/(capture|capture\\.html)']);
function frameAncestorsProblem(value, route) {
  const m = /frame-ancestors ([^;]*)/.exec(value || ''); const fa = m ? m[1].trim() : '';
  if (!fa || fa === "'none'") return '';   // (a policy without frame-ancestors is checked by headers-parity)
  if (fa === "'self'" && FRAME_SELF_ROUTES.has(route)) return '';
  return "frame-ancestors " + (fa || '(missing)') + " is only allowed ('self') on " + [...FRAME_SELF_ROUTES].join(' ');
}
// ---------------------------------------------------------------------------
// r21 monitoring: CSP violation reports + the Sentry ingest host (production policies only).
//   report-uri  -> the csp-report Supabase edge function of the PRODUCTION project (logs a
//                  redacted one-line summary, rate-limited per IP; supabase/functions/csp-report).
//                  r22: also `report-to csp-endpoint` + a Reporting-Endpoints header naming the
//                  same URL (the Reporting API; report-uri stays for browsers without it).
//                  Off: set CSP_REPORTS = false.
//   connect-src -> the EXACT Sentry ingest origin of the DSN in public/config.js
//                  (window.HELM_TELEMETRY.dsn). Empty DSN = nothing added (telemetry dormant).
//                  Never a wildcard (gen-csp --check refuses https://*.).
// server.js applies the same helper for production hosts only (localhost dev never reports).
const CSP_REPORTS = true;
function cspReportUri(prodRef) { return CSP_REPORTS && /^[a-z0-9]{20}$/.test(prodRef || '') ? 'https://' + prodRef + '.supabase.co/functions/v1/csp-report' : ''; }
// "https://<key>@o123.ingest.us.sentry.io/456" -> "https://o123.ingest.us.sentry.io" ('' when absent / malformed)
function sentryIngestOrigin(configSrc) {
  const m = /HELM_TELEMETRY[\s\S]{0,400}?\bdsn\s*:\s*["'](https:\/\/[0-9A-Za-z]{1,64}@(o\d{1,12}\.ingest(?:\.[a-z]{2})?\.sentry\.io)\/\d{1,12})["']/.exec(String(configSrc || ''));
  return m ? 'https://' + m[2] : '';
}
const REPORT_GROUP = 'csp-endpoint';
// Reporting-Endpoints header value for a report URL ('' = send no header).
function reportingEndpoints(reportUri) { return reportUri ? REPORT_GROUP + '="' + reportUri + '"' : ''; }
function withReporting(csp, opts) {
  const o = opts || {};
  const out = [];
  for (const d of String(csp || '').split(';')) {
    const parts = d.trim().split(/\s+/);
    if (!parts[0] || parts[0] === 'report-uri' || parts[0] === 'report-to') continue;
    if (parts[0] === 'connect-src' && o.sentryOrigin && !parts.includes(o.sentryOrigin)) parts.push(o.sentryOrigin);
    out.push(parts.join(' '));
  }
  if (o.reportUri) out.push('report-uri ' + o.reportUri, 'report-to ' + REPORT_GROUP);
  return out.join('; ');
}
module.exports = {
  CSP_REPORTS, cspReportUri, sentryIngestOrigin, withReporting, reportingEndpoints, REPORT_GROUP,
  TRUSTED_TYPES_ENFORCE, TT_DIRECTIVES,
  computeHashes, computeStyleHashes, inlineScripts, inlineStyles, htmlFiles, withHashes,
  SCRIPT_SRC_BASE, SCRIPT_SRC_BUILDER, BUILDER_SOURCES, RAZORPAY_SCRIPT, scriptHosts, scriptSrcProblem, FRAME_SELF_ROUTES, frameAncestorsProblem,
  GIS_SCRIPT, GIS_ORIGIN_PATH, GIS_STYLE, AUTH_COOP,
};
