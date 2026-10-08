// upload-guard.test.mjs — 0048 client upload hardening. store-api.js runs in a vm sandbox with a
// stubbed Supabase client + a fake canvas, and pins:
//  * magic-byte sniff (png/jpeg/webp/gif/pdf/audio), short / unknown bytes refused
//  * declared type / extension vs bytes mismatch is refused (polyglots, renamed html/svg)
//  * every image is re-drawn on a canvas and re-encoded to WebP/JPEG (EXIF/GPS gone) with a
//    size cap and long-edge cap; output bytes are re-sniffed
//  * object names are server-shaped (<uuid>.<ext>), client file names never reach the key;
//    display names are sanitised
//  * invite photos, chat photos, event-doc images and task-proof photos all upload the
//    re-encoded blob, never the original file
//  * guest invitation signing goes through a session-less client carrying x-helm-site-slug
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const SRC = read('public/store-api.js');
const invite = read('public/invite.html');
const mig = read('supabase/migrations/0048_upload_hardening.sql');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

/* ------------------------------------------------------------ sandbox */
const U = (n) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const ORG = 'a0000000-0000-4000-8000-000000000001';
function memStore() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function el(attrs) {
  const a = Object.assign({}, attrs || {});
  return { _a: a, children: [], style: {}, isConnected: true, textContent: '',
    getAttribute: (k) => (k in a ? a[k] : null), setAttribute: (k, v) => { a[k] = String(v); }, removeAttribute: (k) => { delete a[k]; },
    hasAttribute: (k) => k in a, appendChild(c) { this.children.push(c); return c; },
    addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [], remove() { this.isConnected = false; } };
}
const J = (x) => JSON.parse(JSON.stringify(x));
const PNG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, 0x49, 0x48, 0x44, 0x52];
const JPG = [0xFF, 0xD8, 0xFF, 0xE1, 0, 0x20, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4D, 0x4D, 0, 0x2A];   // JPEG with an EXIF APP1
const WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20];
const GIF = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0];
const PDF = [0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x37, 0x0A, 0, 0, 0, 0, 0, 0, 0];
const OGG = [0x4F, 0x67, 0x67, 0x53, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const HTML = [...Buffer.from('<html><script>x</script></html>')];
const pad = (head, size, tail) => { const b = new Uint8Array(size || 64); b.set(head); if (tail) b.set(tail, b.length - tail.length); return b; };
const file = (bytes, name, type) => new File([bytes], name, { type: type == null ? '' : type });

function makeEnv(o = {}) {
  const uploads = [], creates = [], signs = [], draws = [];
  const user = { id: U(1), email: 'admin@a.test' };
  const session = o.anon ? null : { user, access_token: 'x' };
  const storage = (tag) => ({ from(bucket) { return {
    async upload(path, body, opts) { uploads.push({ tag, bucket, path, body, opts }); return { data: { path }, error: null }; },
    async createSignedUrls(paths, ttl) { signs.push({ tag, bucket, paths: paths.slice() }); return { data: paths.map((p) => ({ path: p, signedUrl: 'https://sb.test/sign/' + p, error: null })), error: null }; },
    async createSignedUrl(p) { return { data: { signedUrl: 'https://sb.test/sign/' + p }, error: null }; },
    async remove() { return { error: null }; },
    getPublicUrl(p) { return { data: { publicUrl: 'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/' + bucket + '/' + p } }; },
  }; } });
  const mkClient = (tag) => ({
    auth: {
      async getSession() { return { data: { session } }; }, async getUser() { return { data: { user: session && user } }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
      async refreshSession() { return { data: { session }, error: null }; }, async signOut() { return { error: null }; },
      mfa: { async getAuthenticatorAssuranceLevel() { return { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }; } },
    },
    rpc(name) {
      if (name === 'current_org_id') return Promise.resolve({ data: ORG, error: null });
      if (name === 'my_profile_status') return Promise.resolve({ data: { complete: true, required: false, nudge: false }, error: null });
      if (name === 'worker_evidence_upload') return Promise.resolve({ data: { bucket: 'task-proof', path: [U(7), U(8), U(9), U(10)].join('/') + '.webp', mime: 'image/webp' }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    storage: storage(tag),
    from(table) {
      const b = {}; ['select', 'eq', 'in', 'order', 'limit', 'insert', 'update', 'is', 'neq'].forEach((m) => { b[m] = () => b; });
      const run = () => Promise.resolve(table === 'profiles' ? { data: [{ role: 'admin' }], error: null }
        : table === 'event_files' ? { data: [{ id: 'f1' }], error: null } : { data: [], error: null });
      b.single = () => run().then((r) => ({ ...r, data: Array.isArray(r.data) ? r.data[0] : r.data })); b.maybeSingle = b.single;
      b.then = (res, rej) => run().then(res, rej); return b;
    },
  });
  // fake canvas: toBlob yields a WebP (or JPEG when o.noWebp) whose size follows the pixel count
  const canvas = () => { const c = Object.assign(el(), { tagName: 'CANVAS', width: 0, height: 0,
    getContext: () => ({ fillRect() {}, drawImage: (...a) => draws.push({ w: c.width, h: c.height, args: a.length }), set fillStyle(v) {}, set imageSmoothingEnabled(v) {}, set imageSmoothingQuality(v) {} }),
    toBlob(cb, type, q) {
      const size = o.blobSize ? o.blobSize(c.width, c.height, q) : 4096;
      if (type === 'image/webp' && o.noWebp) return cb(new Blob([pad(PNG, 64)], { type: 'image/png' }));
      const head = type === 'image/webp' ? WEBP : [0xFF, 0xD8, 0xFF, 0xDB];
      cb(new Blob([pad(head, Math.max(16, size))], { type }));
    } }); return c; };
  const doc = {
    readyState: 'complete', addEventListener() {}, removeEventListener() {}, currentScript: { src: 'https://www.helm.events/store-api.js?v=1' },
    createElement: (tag) => (String(tag).toLowerCase() === 'canvas' ? canvas() : Object.assign(el(), { tagName: String(tag).toUpperCase() })),
    head: { appendChild() {} }, body: { appendChild() {}, removeChild() {}, children: [] },
    documentElement: { setAttribute() {}, getAttribute() { return 'light'; }, classList: { contains: () => false, add() {}, remove() {} } },
    querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  };
  const win = {
    SUPABASE_CONFIG: { url: 'https://abcdefghijklmnopqrst.supabase.co', anonKey: 'anon' },
    supabase: { createClient: (url, key, opts) => { creates.push(opts || {}); return mkClient(creates.length === 1 ? 'main' : 'guest'); } },
    localStorage: memStore(), sessionStorage: memStore(),
    location: { pathname: o.path || '/event', search: '', hash: '', origin: 'https://www.helm.events', href: '', hostname: 'www.helm.events', replace() {}, reload() {} },
    document: doc, navigator: { onLine: true }, crypto: globalThis.crypto, Blob, File, Response, Uint8Array, URL,
    createImageBitmap: async () => ({ width: o.w || 4000, height: o.h || 3000, close() {} }),
    fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    addEventListener() {}, removeEventListener() {},
    setTimeout: (fn, ms) => { if (!ms || ms < 1000) { try { fn(); } catch (e) {} } return 0; }, clearTimeout() {},
    setInterval: () => 0, clearInterval() {}, atob: (b) => Buffer.from(b, 'base64').toString('binary'),
    console: { log() {}, info() {}, warn() {}, error() {} },
  };
  win.window = win; win.globalThis = win;
  vm.createContext(win);
  vm.runInContext(SRC, win, { filename: 'store-api.js' });
  return { win, S: win.BPStore, uploads, creates, signs, draws };
}
const bytesOf = async (b) => new Uint8Array(await b.arrayBuffer());

t('sniff: magic bytes, not names', () => {
  const { S } = makeEnv(); const u = S.uploads;
  assert.equal(u.sniff(pad(PNG)).mime, 'image/png'); assert.equal(u.sniff(pad(JPG)).ext, 'jpg');
  assert.equal(u.sniff(pad(WEBP)).mime, 'image/webp'); assert.equal(u.sniff(pad(GIF)).ext, 'gif');
  assert.equal(u.sniff(pad(PDF)).mime, 'application/pdf'); assert.equal(u.sniff(pad(OGG)).mime, 'audio/ogg');
  assert.equal(u.sniff(pad(HTML)), null); assert.equal(u.sniff(new Uint8Array([0xFF, 0xD8])), null, 'too short');
  assert.equal(u.sniff(pad([0x89, 0x50, 0x4E, 0x47, 0, 0, 0, 0])), null, 'PNG needs its full 8-byte signature');
});
t('mismatch: declared type or extension disagreeing with the bytes is refused', () => {
  const { S } = makeEnv(); const u = S.uploads; const j = u.sniff(pad(JPG));
  assert.equal(u.mismatch(file(pad(JPG), 'a.jpg', 'image/jpeg'), j), null);
  assert.equal(u.mismatch(file(pad(JPG), 'a.JPEG', 'image/jpg'), j), null, 'aliases');
  assert.equal(u.mismatch(file(pad(JPG), 'blob', ''), j), null, 'no name/type (canvas blob)');
  assert.equal(u.mismatch(file(pad(JPG), 'a.png', 'image/jpeg'), j), 'extension');
  assert.equal(u.mismatch(file(pad(JPG), 'a.jpg', 'image/png'), j), 'type');
  assert.equal(u.mismatch(file(pad(JPG), 'evil.html', ''), j), 'extension', 'jpeg/html polyglot');
  assert.equal(u.mismatch(file(pad(JPG), 'x.svg', 'image/svg+xml'), j), 'type');
  assert.equal(u.mismatch(file(pad(OGG), 'v.ogg', 'audio/ogg;codecs=opus'), u.sniff(pad(OGG))), null, 'mime params ignored');
  assert.equal(u.mismatch(file(pad(PDF), 'a.pdf', 'application/pdf'), null), 'unrecognised');
});
t('object names are server-shaped; display names sanitised', () => {
  const { S } = makeEnv(); const u = S.uploads;
  assert.match(u.objectName('webp'), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/);
  assert.equal(u.objectName('html'), null); assert.equal(u.objectName('../x'), null);
  assert.notEqual(u.objectName('jpg'), u.objectName('jpg'));
  assert.equal(u.displayName('C:\\Users\\me\\brief: v2.pdf'), 'brief v2.pdf');
  assert.doesNotMatch(u.displayName('../../etc/<script>.pdf'), /[<>\/]/);
  assert.equal(u.displayName('...hidden'), 'hidden'); assert.equal(u.displayName('', 'x.pdf'), 'x.pdf');
  assert.ok(u.displayName('a'.repeat(500) + '.pdf').length <= 120 && u.displayName('a'.repeat(500) + '.pdf').endsWith('.pdf'));
  assert.deepEqual(J(u.fit(4000, 3000, 2560)), { w: 2560, h: 1920 }); assert.deepEqual(J(u.fit(800, 600, 2560)), { w: 800, h: 600 });
});
t('prepareImage: re-encodes on a canvas (EXIF gone), caps pixels + bytes, re-sniffs output', async () => {
  const e = makeEnv({ w: 4000, h: 3000 });
  const out = await e.S.uploads.prepareImage(file(pad(JPG, 2048), 'IMG_0001.jpg', 'image/jpeg'), { maxBytes: 8 << 20, maxPx: 2560 });
  assert.equal(out.mime, 'image/webp'); assert.equal(out.ext, 'webp'); assert.equal(out.sniffed, 'image/jpeg');
  const b = await bytesOf(out.blob);
  assert.equal(e.S.uploads.sniff(b).mime, 'image/webp');
  assert.equal(Buffer.from(b).indexOf(Buffer.from('Exif')), -1, 'no EXIF in the output');
  assert.ok(e.draws.some((d) => d.w === 2560 && d.h === 1920), 'drawn at the capped size');
  const j = await makeEnv({ noWebp: true }).S.uploads.prepareImage(file(pad(PNG), 'a.png', 'image/png'), {});
  assert.equal(j.mime, 'image/jpeg', 'JPEG fallback when the browser cannot write WebP');
  // too big at every quality → shrinks pixels, then gives up with a clear error
  const big = makeEnv({ blobSize: (w, h) => w * h });
  const small = await big.S.uploads.prepareImage(file(pad(JPG), 'a.jpg', 'image/jpeg'), { maxBytes: 3e6, maxPx: 2560 });
  assert.ok(small.blob.size <= 3e6);
  await assert.rejects(makeEnv({ blobSize: () => 9e9 }).S.uploads.prepareImage(file(pad(JPG), 'a.jpg'), { maxBytes: 1e6 }), /small enough/);
});
t('prepareImage: refuses non-images, mismatches, oversize input', async () => {
  const u = makeEnv().S.uploads;
  await assert.rejects(u.prepareImage(file(pad(HTML), 'a.jpg', 'image/jpeg')), /Unsupported image type/);
  await assert.rejects(u.prepareImage(file(pad(PDF), 'a.pdf')), /Unsupported image type/);
  await assert.rejects(u.prepareImage(file(pad(JPG), 'a.html', '')), /doesn't match/);
  await assert.rejects(u.prepareImage(file(pad(PNG), 'a.png', 'image/jpeg')), /doesn't match/);
  await assert.rejects(u.prepareImage(file(pad(GIF), 'a.gif'), { allow: ['image/png', 'image/jpeg', 'image/webp'] }), /Unsupported/);
  await assert.rejects(u.prepareImage(file(pad(JPG, 2 << 20), 'a.jpg'), { maxInput: 1 << 20 }), /too large/);
  await assert.rejects(u.prepareImage(file(new Uint8Array(4), 'a.jpg')), /empty/);
  await assert.rejects(u.checkFile(file(pad(PDF), 'a.jpg', ''), ['application/pdf']), /doesn't match/);
  assert.equal((await u.checkFile(file(pad(PDF), 'brief.pdf', 'application/pdf'), ['application/pdf'])).ext, 'pdf');
});
t('every image upload sends the re-encoded blob under a server-shaped key', async () => {
  const e = makeEnv(); await e.S.init();
  const exif = file(pad(JPG, 4096), '<my> photo.jpg', 'image/jpeg');
  await e.S.sites.uploadPhoto(U(2), exif);
  await e.S.chat.uploadMedia(U(3), exif, {});
  await e.S.files.upload(U(2), exif);
  await e.S.ops.worker.uploadEvidence(U(5), U(6), 'proof_photo', exif);
  assert.equal(e.uploads.length, 4);
  for (const up of e.uploads) {
    assert.notEqual(up.body, exif, up.bucket + ' uploaded the original file');
    assert.equal(e.S.uploads.sniff(await bytesOf(up.body)).mime, 'image/webp', up.bucket);
    assert.doesNotMatch(up.path, /photo|my|<|\s/, up.bucket + ' key carries the client name');
  }
  const [inv, chat, docs, proof] = e.uploads;
  assert.match(inv.path, new RegExp('^' + ORG + '/' + U(2) + '/[0-9a-f-]{36}\\.webp$')); assert.equal(inv.opts.contentType, 'image/webp');
  assert.match(chat.path, new RegExp('^' + ORG + '/' + U(3) + '/[0-9a-f-]{36}\\.webp$'));
  assert.match(docs.path, new RegExp('^' + ORG + '/' + U(2) + '/[0-9a-f-]{36}\\.webp$'));
  assert.equal(proof.bucket, 'task-proof');
  // mismatched file never reaches storage
  await assert.rejects(e.S.sites.uploadPhoto(U(2), file(pad(JPG), 'x.svg', 'image/svg+xml')));
  await assert.rejects(e.S.files.upload(U(2), file(pad(PDF), 'x.exe', '')));
  assert.equal(e.uploads.length, 4);
});
t('guest invitation signing: session-less client with x-helm-site-slug; staff path unchanged', async () => {
  const e = makeEnv({ anon: true, path: '/i/asha-ravi-0123456789abcdef' }); await e.S.init();
  const ref = 'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/invite-media/' + ORG + '/' + U(2) + '/' + U(9) + '.webp';
  const out = await e.S.sites.mediaUrls([ref], 600, 'asha-ravi-0123456789abcdef');
  assert.match(out[0], /^https:\/\/sb\.test\/sign\//);
  assert.equal(e.signs[0].tag, 'guest');
  const g = e.creates[1];
  assert.equal(g.global.headers['x-helm-site-slug'], 'asha-ravi-0123456789abcdef');
  assert.equal(g.auth.persistSession, false);
  await e.S.sites.mediaUrls([ref], 600, 'asha-ravi-0123456789abcdef');
  assert.equal(e.creates.length, 2, 'one guest client per slug');
  await e.S.sites.mediaUrls([ref], 600, 'bad slug/../x');
  assert.equal(e.signs[2].tag, 'main', 'malformed slug never becomes a header');
  await e.S.sites.mediaUrls([ref], 600);
  assert.equal(e.signs[3].tag, 'main');
  assert.match(invite, /BPStore\.sites\.mediaUrls\(need,undefined,\(site&&site\.slug\)\|\|getSlug\(\)\)/);
});
t('0048 SQL: slug-bound guest read, restrictive guards, bucket caps', () => {
  assert.match(mig, /create policy "invite_media_published_read"[\s\S]*invite_media_guest_read_ok\(name\)/);
  assert.match(mig, /x-helm-site-slug/); assert.match(mig, /storage\.operation/);
  assert.match(mig, /as restrictive for insert to anon, authenticated/); assert.match(mig, /as restrictive for update to anon, authenticated/);
  assert.doesNotMatch(mig, /public\s*=\s*true/);
  assert.doesNotMatch(mig, /\bdelete from\b|\bdrop table\b|\btruncate\b/i);
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('ok - ' + name); }
  catch (e) { fail++; console.log('not ok - ' + name + ': ' + (e && e.stack || e)); }
}
console.log(`\nupload-guard: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
