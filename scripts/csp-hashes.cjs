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
function withHashes(csp, hashes) {
  return csp.split(';').map((d) => {
    const parts = d.trim().split(/\s+/);
    if (parts[0] !== 'script-src') return d.trim();
    const keep = parts.slice(1).filter((s) => s !== "'unsafe-inline'" && !/^'sha(256|384|512)-/.test(s));
    return ['script-src', ...keep, ...hashes].join(' ');
  }).filter(Boolean).join('; ');
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
const BUILDER_SOURCES = new Set(['/builder', '/builder\\.html', '/builder.html']);

// Sign-in / password-reset pages may also load the Cloudflare Turnstile CAPTCHA
// widget (a single-purpose origin, not a library CDN).
const AUTH_ROUTE = /(^|\/|\()(login|reset)/;
const TURNSTILE = /^https:\/\/challenges\.cloudflare\.com(\/[^\s;]*)?$/;

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
  const extra = hosts.filter((h) => !allowed.includes(h) && !(AUTH_ROUTE.test(route) && TURNSTILE.test(h)));
  if (extra.length) return 'script-src allows ' + extra.join(' ') + (BUILDER_SOURCES.has(route) ? '' : ' (CDN sources are builder-only)');
  return '';
}

module.exports = {
  computeHashes, inlineScripts, htmlFiles, withHashes,
  SCRIPT_SRC_BASE, SCRIPT_SRC_BUILDER, BUILDER_SOURCES, scriptHosts, scriptSrcProblem,
};
