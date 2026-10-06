/* =========================================================================
   Blueprint Stage — full-stack server (zero dependencies)
   Serves the static builder from /public and exposes a small REST API that
   persists saved event layouts to data/layouts.json.

   API
   ------------------------------------------------------------------
   GET    /api/health              -> { ok:true }
   GET    /api/layouts             -> [ {id,name,updatedAt,objectCount}, ... ]
   GET    /api/layouts/:id         -> full layout { id,name,createdAt,updatedAt,data }
   POST   /api/layouts             -> create   body:{ name, data }        -> layout
   PUT    /api/layouts/:id         -> replace  body:{ name?, data }       -> layout
   DELETE /api/layouts/:id         -> { ok:true }
   ========================================================================= */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');

// Stability mandate: strict env validation BEFORE the server layer starts — fail
// fast with an actionable message rather than silently binding somewhere unexpected.
const PORT = (() => {
  const raw = process.env.PORT;
  if (raw === undefined || raw === '') return 4173;           // documented default
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`[helm] FATAL: PORT="${raw}" is not a valid TCP port (1-65535). Refusing to start.`);
    process.exit(1);
  }
  return n;
})();
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'layouts.json');

/* ----------------------------------------------------------- storage */
function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');
}
function readDb() {
  ensureDb();
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) || []; }
  catch { return []; }
}
function writeDb(list) {
  ensureDb();
  // write-then-rename so a crash mid-write can't leave truncated JSON (which
  // readDb would treat as [] and the next save would persist, wiping layouts)
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
const uid = () => 'lay_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ----------------------------------------------------------- helpers */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { reject(new Error('payload too large')); req.destroy(); return; }
      raw += c;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}
const summary = (l) => ({
  id: l.id, name: l.name, createdAt: l.createdAt, updatedAt: l.updatedAt,
  objectCount: Array.isArray(l.data && l.data.items) ? l.data.items.length : 0,
});

/* ----------------------------------------------------------- static */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

/* Security headers — MIRRORS vercel.json (production source of truth) and
   public/_headers. test/headers-parity.test.mjs fails CI if they drift.
   Documented per-host difference: on localhost (plain http) we drop
   `upgrade-insecure-requests` (see isLocalHost).
   script-src has NO 'unsafe-inline': every inline <script> is allowed by its
   sha256 hash (scripts/csp-hashes.cjs). Here the hashes are computed from the
   files on disk, so local dev never drifts; vercel.json / _headers carry the
   same list via `node scripts/gen-csp.mjs` (CI --check). Do not add CDN hosts back:
   script-src host sources come from SCRIPT_SRC_BASE / SCRIPT_SRC_BUILDER in
   scripts/csp-hashes.cjs (path-scoped; CDNs are builder-only). */
// Inline-script hashes, recomputed only when a page under public/ changes.
const { computeHashes, htmlFiles, withHashes, SCRIPT_SRC_BASE, SCRIPT_SRC_BUILDER } = require('./scripts/csp-hashes.cjs');
let hashCache = { sig: null, hashes: [] };
function inlineScriptHashes() {
  let sig = '';
  try { for (const f of htmlFiles(PUBLIC_DIR)) sig += f + ':' + fs.statSync(f).mtimeMs + ';'; } catch { return hashCache.hashes; }
  if (sig !== hashCache.sig) hashCache = { sig, hashes: computeHashes(PUBLIC_DIR) };
  return hashCache.hashes;
}
const CSP_BASE = [
  ['default-src', "'self'"],
  ['base-uri', "'self'"],
  ['object-src', "'none'"],
  ['frame-ancestors', "'none'"],
  ['frame-src', "'self'"],                  // the invitation studio previews /invite in a same-origin iframe
  ['form-action', "'self'"],
  ['img-src', "'self' data: blob: https://*.supabase.co"],
  ['media-src', "'self' blob: https://*.supabase.co"],
  ['font-src', "'self' https://fonts.gstatic.com"],
  ['style-src', "'self' 'unsafe-inline' https://fonts.googleapis.com"],
  // 'self' + the pinned Sentry bundle directory only (no whole-CDN hosts)
  ['script-src', SCRIPT_SRC_BASE.join(' ')],
  ['connect-src', "'self' https://*.supabase.co wss://*.supabase.co https://*.ingest.sentry.io https://*.ingest.us.sentry.io"],
  ['upgrade-insecure-requests', ''],
];
const buildCsp = (over = {}) => CSP_BASE
  .map(([k, v]) => [k, Object.prototype.hasOwnProperty.call(over, k) ? over[k] : v])
  .map(([k, v]) => (v ? k + ' ' + v : k)).join('; ');
// Per-page relaxations (same pages as vercel.json):
//  • portal / proposal-view / proposal / media render user-pasted image URLs → img-src https:
//  • invite-studio also plays external music URLs → + media-src https:
//  • invite (/invite, /i/<slug>) = studio policy + same-origin framing for the studio preview
//  • builder lazy-loads three.js r128 + example modules (SRI-pinned) from the exact
//    cdnjs / jsdelivr directories in SCRIPT_SRC_BUILDER
const USER_IMG = "'self' data: blob: https:";
const USER_MEDIA = "'self' blob: https:";
const CSP = {
  base: buildCsp(),
  userImg: buildCsp({ 'img-src': USER_IMG }),
  studio: buildCsp({ 'img-src': USER_IMG, 'media-src': USER_MEDIA }),
  invite: buildCsp({ 'img-src': USER_IMG, 'media-src': USER_MEDIA, 'frame-ancestors': "'self'" }),
  builder: buildCsp({ 'script-src': SCRIPT_SRC_BUILDER.join(' ') }),
};
const CSP_BY_PAGE = {
  portal: 'userImg', 'proposal-view': 'userImg', proposal: 'userImg', media: 'userImg',
  'invite-studio': 'studio', invite: 'invite', builder: 'builder',
};
const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy': CSP.base,
};

// Search-engine policy: only the marketing pages are indexable. Every other
// page (app, token pages, login, sim-pay, 404), /docs/* and /.well-known/* get
// X-Robots-Tag. Same list as vercel.json (derived from public/*.html).
const INDEXABLE_PAGES = new Set(['index', 'about', 'services', 'privacy', 'terms']);
// Pages served for client links that carry a bearer token in the URL (/approve?token=,
// /<studio>/<kind>/<ref>, /i/<slug>): Referrer-Policy no-referrer + Cache-Control
// no-store, private (audit Phase 9). Same list as vercel.json / _headers.
const TOKEN_PAGES = new Set(['approve', 'portal', 'proposal-view', 'work', 'invite']);
const NOINDEX = 'noindex, nofollow, noarchive';

// Loopback host? On localhost we serve over http, so `upgrade-insecure-requests`
// would rewrite same-origin subresources (e.g. the invitation preview iframe) to
// https://localhost and break them. Prod is https, where UIR is kept.
function isLocalHost(req) {
  return /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test((req && req.headers && req.headers.host) || '');
}
// "dashboard" for public/dashboard.html; null for non-page files.
function pageName(filePath) {
  const m = filePath && /(?:^|[\\/])([^\\/]+)\.html$/.exec(filePath);
  return m ? m[1] : null;
}
function relFromPublic(filePath) {
  const abs = path.isAbsolute(filePath) ? filePath : path.join(PUBLIC_DIR, filePath);
  return path.relative(PUBLIC_DIR, abs).split(path.sep).join('/');
}
// Per-request security headers (+ X-Robots-Tag) for the file being served.
function securityHeadersFor(req, filePath) {
  const h = { ...SECURITY_HEADERS };
  const rel = filePath ? relFromPublic(filePath) : '';
  const page = rel.includes('/') ? null : pageName(rel);
  const variant = page && CSP_BY_PAGE[page];
  if (variant) h['Content-Security-Policy'] = CSP[variant];
  if (page === 'invite') h['X-Frame-Options'] = 'SAMEORIGIN';   // Invitation Studio preview (same-origin only)
  // Client-link (bearer token) pages: the token is in the URL, so never send it
  // on as a Referer (same rule as vercel.json / _headers).
  if (page && TOKEN_PAGES.has(page)) h['Referrer-Policy'] = 'no-referrer';
  if ((page && !INDEXABLE_PAGES.has(page)) || rel.startsWith('docs/') || rel.startsWith('.well-known/')) {
    h['X-Robots-Tag'] = NOINDEX;
  }
  h['Content-Security-Policy'] = withHashes(h['Content-Security-Policy'], inlineScriptHashes());
  if (isLocalHost(req)) h['Content-Security-Policy'] = h['Content-Security-Policy'].replace(/;\s*upgrade-insecure-requests/, '');
  return h;
}

// Cache policy (mirrors vercel.json): HTML revalidates every time; /vendor/ and
// ?v=-versioned assets are immutable; config.js is short-lived; unversioned
// images / crawler files get an hour.
const IMMUTABLE = 'public, max-age=31536000, immutable';
const SHORT = 'public, max-age=3600, must-revalidate';
function cacheControlFor(filePath, query) {
  const rel = relFromPublic(filePath);
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.html' && !rel.includes('/') && TOKEN_PAGES.has(pageName(rel))) return 'no-store, private';
  if (ext === '.html') return 'no-cache';
  if (rel === 'config.js') return 'public, max-age=300';
  if (rel.startsWith('vendor/')) return IMMUTABLE;
  if (/[?&]v=/.test(query || '') && ['.js', '.css', '.png', '.webp', '.svg', '.woff2'].includes(ext)) return IMMUTABLE;
  if (['.js', '.css'].includes(ext)) return 'no-cache';   // unversioned script/style: always revalidate locally
  if (['.png', '.webp', '.svg', '.woff2', '.ico', '.txt', '.xml'].includes(ext)) return SHORT;
  return 'no-cache';
}

function sendFileRes(res, filePath, buf, req, status = 200) {
  const ext = path.extname(filePath);
  const query = (req && req.url && req.url.includes('?')) ? req.url.slice(req.url.indexOf('?')) : '';
  res.writeHead(status, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': status === 200 ? cacheControlFor(filePath, query) : 'no-cache',
    ...securityHeadersFor(req, filePath),
  });
  res.end(buf);
}

// Unknown URL → the branded 404 page with a real 404 status (was: dashboard.html, 200).
function sendNotFound(res, req) {
  const file = path.join(PUBLIC_DIR, '404.html');
  fs.readFile(file, (e, buf) =>
    e ? sendJson(res, 404, { error: 'not found' }) : sendFileRes(res, file, buf, req, 404));
}

// Index of every servable file under public/, keyed by its URL path
// ("/vendor/x.js" → absolute path). Requests are looked up here, so a request
// path is never joined onto the filesystem (no traversal is even expressible).
// Rebuilt at most once a second on a miss, so files added in dev show up.
let fileIndex = new Map(), fileIndexAt = 0;
function buildFileIndex() {
  const idx = new Map();
  const walk = (dir, urlDir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') && ent.name !== '.well-known') continue;
      const abs = path.join(dir, ent.name), url = urlDir + '/' + ent.name;
      if (ent.isDirectory()) walk(abs, url);
      else if (ent.isFile()) idx.set(url, abs);
    }
  };
  try { walk(PUBLIC_DIR, ''); } catch (e) { console.error('[server] cannot index public/:', e.message); }
  fileIndex = idx; fileIndexAt = Date.now();
}
function lookupFile(urlPath) {
  if (!fileIndex.has(urlPath) && Date.now() - fileIndexAt > 1000) buildFileIndex();
  return fileIndex.get(urlPath) || null;
}
// the index's own copy of the key (never the request's string)
function indexedUrl(urlPath) {
  for (const k of fileIndex.keys()) if (k === urlPath) return k;
  return null;
}
function serveFile(res, req, file) {
  fs.readFile(file, (e, buf) => (e ? sendNotFound(res, req) : sendFileRes(res, file, buf, req)));
}

const INTERNAL_EXT = /\.(md|map|sql|bak|log|env)$/i;
function isInternalFile(rel) {
  const base = rel.split('/').pop() || '';
  return base === '_headers' || base === '.DS_Store' || INTERNAL_EXT.test(base);
}

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); }
  catch { return sendJson(res, 400, { error: 'bad request' }); }
  const qIdx = req.url.indexOf('?');
  const query = qIdx >= 0 ? req.url.slice(qIdx) : '';

  // The public front door.
  if (rel === '/') return serveFile(res, req, path.join(PUBLIC_DIR, 'index.html'));

  // Internal files kept in public/ for tooling (the Cloudflare/Netlify _headers file,
  // vendor notes) are never served. Production: .vercelignore + vercel.json redirects.
  if (isInternalFile(rel)) return sendNotFound(res, req);

  // Public digital-invitation sites: /i/<slug> is served by invite.html, which
  // reads the slug from the path and fetches ONLY the published display fields.
  // Guard: only treat it as a slug when there's no file extension, so asset
  // requests (e.g. /i/foo.js) are never swallowed by this route.
  if ((rel === '/i' || rel.startsWith('/i/')) && !path.extname(rel)) {
    return serveFile(res, req, path.join(PUBLIC_DIR, 'invite.html'));
  }

  // Branded client links (migration 0020): /<studio>/<kind>/<ref> → the client page.
  // Same pattern + page mapping as the vercel.json rewrites. The page asks the server
  // whether <studio> owns <ref> before showing anything (anti-phishing).
  {
    const m = /^\/[a-z0-9-]{3,40}\/(invite|quote|proposal|portal|work)\/[^/]+\/?$/.exec(rel);
    if (m && !path.extname(rel)) {
      const page = { invite: 'invite', quote: 'approve', proposal: 'proposal-view', portal: 'portal', work: 'work' }[m[1]];
      return serveFile(res, req, path.join(PUBLIC_DIR, page + '.html'));
    }
  }

  // Clean URLs: hide the .html extension. /foo.html → 302 /foo (served from
  // foo.html below). Only real pages redirect, to the index's own path — so
  // "//evil.com.html" style requests can't produce an off-site Location.
  if (rel.toLowerCase().endsWith('.html')) {
    const page = rel.startsWith('/') && lookupFile(rel) ? indexedUrl(rel) : null;
    if (!page) return sendNotFound(res, req);
    const clean = page.slice(0, -5);                         // /dashboard.html → /dashboard
    res.writeHead(302, { Location: clean + query, ...securityHeadersFor(req, lookupFile(page)) });
    return res.end();
  }

  // A real asset (.js, .css, images, …), or a clean page URL → <name>.html.
  const file = path.extname(rel) ? lookupFile(rel) : lookupFile(rel + '.html');
  if (!file) return sendNotFound(res, req);
  serveFile(res, req, file);
}

/* ----------------------------------------------------- rate limiting */
// In-memory per-IP fixed-window limiter for this server's mutating /api surface.
// NOTE: auth/login traffic does NOT pass through here — the browser calls Supabase
// directly, so brute-force protection on sign-in is configured in the Supabase
// dashboard (Authentication → Rate Limits). This guards the layout API from bursts.
const RL_WINDOW_MS = 60 * 1000;
const RL_MAX = 120;                 // requests per IP per window for /api/*
const rlHits = new Map();           // ip -> { count, resetAt }
// X-Forwarded-For is client-controlled; only honour it behind a trusted proxy
// (TRUST_PROXY=1), otherwise a caller could rotate it to bypass the limit.
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
function rateLimited(req) {
  const ip = (TRUST_PROXY && (req.headers['x-forwarded-for'] || '').split(',')[0].trim())
    || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let e = rlHits.get(ip);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + RL_WINDOW_MS }; rlHits.set(ip, e); }
  e.count++;
  if (rlHits.size > 5000) { for (const [k, v] of rlHits) { if (now > v.resetAt) rlHits.delete(k); } }
  return e.count > RL_MAX ? Math.ceil((e.resetAt - now) / 1000) : 0;   // 0 = allowed, else Retry-After secs
}

/* --------------------------------------------------- layout API auth */
// The /api/layouts file store is unauthenticated and un-tenant-scoped. The live
// multi-tenant app does NOT use it — layouts persist via Supabase (RLS) + localStorage
// (see public/store-api.js); this endpoint is a local single-user convenience and is
// not served by the production (Vercel static) deployment. To stop an exposed server.js
// from being an open read/write/delete relay, gate it: loopback clients are allowed;
// any non-local client must present a configured bearer token (timing-safe). With no
// token configured, remote access fails closed.
const LAYOUTS_API_TOKEN = process.env.LAYOUTS_API_TOKEN || '';
function isLoopbackClient(req) {
  const a = (req.socket && req.socket.remoteAddress) || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function layoutApiAllowed(req) {
  if (isLoopbackClient(req)) return true;
  if (!LAYOUTS_API_TOKEN) return false;
  const m = /^Bearer\s+(.+)$/i.exec(req.headers['authorization'] || '');
  if (!m) return false;
  const got = Buffer.from(m[1]);
  const want = Buffer.from(LAYOUTS_API_TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/* ----------------------------------------------------------- api */
async function handleApi(req, res, url) {
  const parts = url.split('/').filter(Boolean); // ['api','layouts',':id']
  const id = parts[2];

  if (parts[1] === 'health') return sendJson(res, 200, { ok: true, service: 'blueprint-stage', time: Date.now() });
  if (parts[1] !== 'layouts') return sendJson(res, 404, { error: 'unknown endpoint' });
  // Fail closed for non-local callers without a valid token (read + write).
  if (!layoutApiAllowed(req)) return sendJson(res, 401, { error: 'unauthorized' });

  // Parse the body first (client errors -> 4xx, never 500). We deliberately
  // read the DB from disk *after* this await so there is no yield point between
  // read-modify-write, which keeps concurrent mutations from clobbering each other.
  let body = {};
  if (req.method === 'POST' || req.method === 'PUT') {
    try { body = await readBody(req); }
    catch (e) {
      const tooBig = /too large/i.test(e.message);
      return sendJson(res, tooBig ? 413 : 400, { error: e.message || 'invalid body' });
    }
  }

  if (req.method === 'GET' && !id) return sendJson(res, 200, readDb().map(summary));
  if (req.method === 'GET' && id) {
    const found = readDb().find((l) => l.id === id);
    return found ? sendJson(res, 200, found) : sendJson(res, 404, { error: 'not found' });
  }
  if (req.method === 'POST') {
    if (!body.data || !Array.isArray(body.data.items)) return sendJson(res, 400, { error: 'data.items required' });
    const db = readDb();
    const now = new Date().toISOString();
    const layout = { id: uid(), name: (body.name || 'Untitled layout').slice(0, 120), createdAt: now, updatedAt: now, data: body.data };
    db.push(layout); writeDb(db);
    return sendJson(res, 201, layout);
  }
  if (req.method === 'PUT' && id) {
    if (body.data && !Array.isArray(body.data.items)) return sendJson(res, 400, { error: 'data.items must be an array' });
    const db = readDb();
    const idx = db.findIndex((l) => l.id === id);
    if (idx === -1) return sendJson(res, 404, { error: 'not found' });
    db[idx] = { ...db[idx], name: body.name != null ? String(body.name).slice(0, 120) : db[idx].name,
      data: body.data || db[idx].data, updatedAt: new Date().toISOString() };
    writeDb(db);
    return sendJson(res, 200, db[idx]);
  }
  if (req.method === 'DELETE' && id) {
    const db = readDb();
    const next = db.filter((l) => l.id !== id);
    if (next.length === db.length) return sendJson(res, 404, { error: 'not found' });
    writeDb(next);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 405, { error: 'method not allowed' });
}

/* ----------------------------------------------------------- server */
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {   // CORS preflight — 204 must carry no body
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }
    const url = req.url.split('?')[0];
    if (url.startsWith('/api/')) {
      const retry = rateLimited(req);
      if (retry) {
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'Retry-After': String(retry),
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        return res.end(JSON.stringify({ error: 'rate limited — slow down', retryAfter: retry }));
      }
      return await handleApi(req, res, url);
    }
    return serveStatic(req, res);
  } catch (err) {
    console.error('[server] unhandled error:', err);
    if (res.headersSent) return res.end();
    sendJson(res, 500, { error: 'server error' });
  }
});

// Exported for test/headers-parity.test.mjs (requiring this file does not listen).
module.exports = { CSP, CSP_BY_PAGE, SECURITY_HEADERS, INDEXABLE_PAGES, NOINDEX, TOKEN_PAGES, securityHeadersFor, cacheControlFor, layoutApiAllowed, isLoopbackClient, isInternalFile };

if (require.main === module) {
  server.listen(PORT, () => {
    ensureDb();
    console.log(`Blueprint Stage running →  http://localhost:${PORT}`);
  });
}
