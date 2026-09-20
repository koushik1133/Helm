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

const PORT = process.env.PORT || 4173;
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
  fs.writeFileSync(DB_FILE, JSON.stringify(list, null, 2));
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
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
};
// Defensive security headers applied to every served response.
// CSP allows the app's real sources (inline scripts/styles are used across the
// static pages, hence 'unsafe-inline' — a documented accepted risk until a
// nonce refactor); everything else is locked to self + the known CDNs.
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "img-src 'self' data: https:",
  "font-src 'self' https://fonts.gstatic.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://cdn.jsdelivr.net",
  "upgrade-insecure-requests",
].join('; ');
const SECURITY_HEADERS = {
  'Content-Security-Policy': CSP,
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

function serveStatic(req, res) {
  let rel;
  try { rel = decodeURIComponent(req.url.split('?')[0]); }
  catch { return sendJson(res, 400, { error: 'bad request' }); }
  if (rel === '/') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  // must stay inside PUBLIC_DIR (guard the separator boundary, not just the prefix)
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep))
    return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // SPA-ish fallback to index for unknown non-file routes
      if (!path.extname(filePath)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) =>
          e2 ? sendJson(res, 404, { error: 'not found' })
             : (res.writeHead(200, { 'Content-Type': MIME['.html'], ...SECURITY_HEADERS }), res.end(idx)));
      }
      return sendJson(res, 404, { error: 'not found' });
    }
    const ext = path.extname(filePath);
    // Revalidate app files so updates always show; ETag lets the browser 304 unchanged files (fast, no staleness).
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    res.end(buf);
  });
}

/* ----------------------------------------------------------- api */
async function handleApi(req, res, url) {
  const parts = url.split('/').filter(Boolean); // ['api','layouts',':id']
  const id = parts[2];

  if (parts[1] === 'health') return sendJson(res, 200, { ok: true, service: 'blueprint-stage', time: Date.now() });
  if (parts[1] !== 'layouts') return sendJson(res, 404, { error: 'unknown endpoint' });

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
    if (url.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res);
  } catch (err) {
    sendJson(res, 500, { error: err.message || 'server error' });
  }
});

server.listen(PORT, () => {
  ensureDb();
  console.log(`Blueprint Stage running →  http://localhost:${PORT}`);
});
