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
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
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

module.exports = { computeHashes, inlineScripts, htmlFiles, withHashes };
