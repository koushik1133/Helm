#!/usr/bin/env node
/* ============================================================================
 * invite-media-hardening.test.mjs — content-validation hardening for the
 * digital-invitation photo path (source-assertion tests; no DB, no network).
 *
 * Covers two sides of the 'invite-media' bucket:
 *   UPLOAD (public/store-api.js → sites.uploadPhoto): magic-byte image
 *     allowlist (png/jpeg/webp/gif), size cap, random object key, client
 *     filename + client-declared type discarded.
 *   RENDER (public/invite.html): every stored media URL is scheme-allowlisted
 *     to http(s) and only ever placed in a CSS background url() / <img>, never
 *     injected as raw HTML.
 * ========================================================================== */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

const api = read('public/store-api.js');
// Isolate the uploadPhoto body so assertions can't be satisfied by the
// unrelated event-docs path elsewhere in the file.
const upM = api.match(/async uploadPhoto\(quoteId, file\)\s*\{([\s\S]*?)\n    \},/);
assert.ok(upM, 'sites.uploadPhoto must exist');
const uploadBody = upM[1];

// --- UPLOAD: magic-byte image allowlist -------------------------------------
t('invite upload declares a magic-byte image allowlist (png/jpeg/webp/gif)', () => {
  assert.match(api, /const INVITE_IMG_SNIFF = \[/, 'INVITE_IMG_SNIFF table must exist');
  for (const mime of ['image/png', 'image/jpeg', 'image/webp', 'image/gif']) {
    assert.ok(api.includes('"' + mime + '"'), 'allowlist must include ' + mime);
  }
  // image-only — the invite allowlist must NOT accept PDFs
  const snM = api.match(/const INVITE_IMG_SNIFF = \[([\s\S]*?)\];/);
  assert.ok(snM && !/application\/pdf/.test(snM[1]), 'invite image allowlist must not include application/pdf');
  // GIF matcher guards the full GIF87a/GIF89a signature
  assert.match(snM[1], /0x47 && b\[1\]===0x49 && b\[2\]===0x46 && b\[3\]===0x38/, 'GIF magic bytes must be checked');
});

t('invite upload VALIDATES by magic bytes, not the client type/extension', () => {
  assert.match(uploadBody, /sniffInviteImage\(file\)/, 'must sniff the file bytes');
  assert.match(uploadBody, /if \(!sniff\) throw new Error/, 'must reject when no image signature matches');
  // the stored content-type comes from the sniff, never the client-declared file.type
  assert.match(uploadBody, /contentType:\s*sniff\.mime/, 'contentType must come from the sniff');
  assert.ok(!/file\.type/.test(uploadBody), 'must not trust the client-declared file.type');
  // the client filename / extension must not drive the stored key
  assert.ok(!/file\.name/.test(uploadBody), 'must not use the client filename');
  assert.ok(!/split\(["']\.["']\)/.test(uploadBody), 'must not derive an extension from the client name');
});

t('invite upload enforces a size cap (8 MB)', () => {
  assert.match(api, /const INVITE_IMG_MAX = 8 \* 1024 \* 1024;/, 'INVITE_IMG_MAX must be 8 MB');
  assert.match(uploadBody, /file\.size > INVITE_IMG_MAX/, 'must reject files over the cap');
});

t('invite upload uses a RANDOM object key (uuid), not a guessable/client key', () => {
  assert.match(uploadBody, /crypto\.randomUUID\(\)/, 'must use a random uuid for the key');
  assert.match(uploadBody, /uuid\s*\+\s*"\."\s*\+\s*sniff\.ext/, 'key = <uuid>.<sniffed-ext>');
  assert.ok(!/Date\.now\(\)/.test(uploadBody), 'key must not be derived from Date.now()');
});

// --- RENDER: scheme allowlist + no raw-HTML injection -----------------------
const invite = read('public/invite.html');

t('invite render scheme-allowlists every media URL to http(s)', () => {
  assert.match(invite, /d\.photos\.filter\(u=>\/\^https\?:\\\/\\\/\/i\.test\(u\|\|""\)\)/,
    'photos must be filtered to the http(s) scheme before render');
  // the pre-hardening permissive filter must be gone
  assert.ok(!/d\.photos\.filter\(Boolean\)/.test(invite), 'photos must no longer be filtered by Boolean alone');
});

t('invite render places media only in a CSS url(), never as injected HTML', () => {
  // a CSS-url escaper exists and is applied to every photo sink
  assert.match(invite, /const cssUrl=u=>esc\(/, 'cssUrl escaper must exist');
  // hero + gallery both go through cssUrl inside background-image:url('...')
  const urlSinks = invite.match(/background-image:url\('\$\{cssUrl\([^)]*\)\}'\)/g) || [];
  assert.ok(urlSinks.length >= 2, 'hero and gallery must both render via cssUrl in a url() sink');
  // no photo value is ever concatenated straight into innerHTML without cssUrl/esc
  assert.ok(!/innerHTML[^\n]*\$\{(hero0|u)\}/.test(invite), 'a raw media URL must not be injected as HTML');
});

// --- P2-01: private bucket => photos render through SIGNED urls, never assumed public ---
t('store-api exposes sites.mediaUrls that signs invite-media refs (short-lived)', () => {
  const i = api.indexOf('async mediaUrls(');
  assert.ok(i > 0, 'sites.mediaUrls must exist');
  const body = api.slice(i, i + 1400);
  assert.match(body, /from\("invite-media"\)\.createSignedUrls\(paths, seconds \|\| 3600\)/, 'must sign via createSignedUrls (<=1h)');
  assert.match(body, /object\\\/\(\?:public\|sign\|authenticated\)\\\/invite-media\\\//, 'must only rewrite invite-media refs');
});
t('public invitation signs photos before render (load + studio preview)', () => {
  assert.match(invite, /site=await signPhotos\(site\);[\s\S]{0,40}render\(site\)/, 'load() must sign before render');
  assert.match(invite, /site=await signPhotos\(m\.site\)/, 'preview message must sign before render');
  assert.match(invite, /if\(seq!==pvSeq\) return;/, 'stale preview renders must be dropped');
  assert.match(invite, /BPStore\.sites\.mediaUrls\(need\)/);
});
t('invite studio thumbnails render signed URLs, store references', () => {
  const studio = read('public/invite-studio.html');
  assert.match(studio, /BPStore\.sites\.mediaUrls\(need\)/, 'studio must sign thumbnails');
  assert.match(studio, /cssUrl\(SIGNED\.get\(u\)\|\|u\)/, 'thumbnails must use the signed URL');
  assert.match(studio, /photos:PHOTOS\.slice\(\)/, 'saved data keeps the stable references, not expiring signed URLs');
});
t('migration 0019 keeps bucket private + published-only anon read', () => {
  const m = read('supabase/migrations/0019_invite_media_published_read.sql');
  assert.match(m, /set public = false where id = 'invite-media'/);
  assert.match(m, /for select to anon, authenticated\s+using \( bucket_id = 'invite-media' and public\.invite_media_on_published_site\(name\) \)/);
  assert.match(m, /s\.status = 'published'/);
  assert.match(m, /s\.org_id::text\s+= split_part\(p_name, '\/', 1\)/, 'org folder must match the site');
  assert.match(m, /security definer\s+set search_path = ''/);
  assert.ok(!/to public\b/.test(m) && !/public = true/.test(m), 'never re-open the bucket');
});

console.log('\ninvite-media-hardening: ' + passed + ' assertion(s) passed.');
