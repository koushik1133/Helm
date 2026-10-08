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
const BUILDER_SOURCES = new Set(['/builder', '/builder\\.html', '/builder.html', '/([a-z0-9-]+)/events/([^/]+)/floor-plan', '/:studio/events/:ref/floor-plan']);   // 0067 pretty floor-plan URL serves builder.html

// Sign-in / password-reset pages may also load the Cloudflare Turnstile CAPTCHA
// widget (a single-purpose origin, not a library CDN).
const AUTH_ROUTE = /(^|\/|\()(login|reset)/;
const TURNSTILE = /^https:\/\/challenges\.cloudflare\.com(\/[^\s;]*)?$/;
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
  const allowed = BUILDER_SOURCES.has(route) ? SCRIPT_SRC_BUILDER : SCRIPT_SRC_BASE;
  const extra = hosts.filter((h) => !allowed.includes(h) && !(AUTH_ROUTE.test(route) && TURNSTILE.test(h)) && !(CHECKOUT_ROUTE.test(route) && h === RAZORPAY_SCRIPT));
  if (extra.length) return 'script-src allows ' + extra.join(' ') + (BUILDER_SOURCES.has(route) ? '' : ' (CDN sources are builder-only)');
  return '';
}

module.exports = {
  TRUSTED_TYPES_ENFORCE, TT_DIRECTIVES,
  computeHashes, computeStyleHashes, inlineScripts, inlineStyles, htmlFiles, withHashes,
  SCRIPT_SRC_BASE, SCRIPT_SRC_BUILDER, BUILDER_SOURCES, RAZORPAY_SCRIPT, scriptHosts, scriptSrcProblem,
};
