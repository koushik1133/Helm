#!/usr/bin/env node
// ============================================================================
// tests/staging/storage.mjs — STAGING Storage runtime test suite (PREPARED).
//
// Verifies the REAL Supabase Storage provider config + RLS for the two private
// buckets hardened in supabase/migrations/0013_storage_hardening.sql:
//     invite-media  (private, 8 MB,  png/jpeg/webp/gif)
//     event-docs    (private, 10 MB, pdf/png/jpeg/webp)
// and 0009_feature_tasks_files.sql (event-docs org-scoped RLS).
//
// WHY A RUNTIME SUITE: the SQL migration sets storage.buckets config and
// storage.objects policies, but the actual enforcement lives in the Storage
// *provider*. This suite talks to the live Storage REST API so we confirm the
// provider matches the SQL, not just that the SQL ran.
//
// SAFETY INVARIANTS (do not weaken):
//   * STAGING ONLY. Asserts SUPABASE_STAGING_URL contains the staging ref
//     (xizehqgeyjcfpzrdymly) and HARD-REFUSES the prod ref (nqltzgiwznphugcfhmbm)
//     before any network call.
//   * Secrets come from env ONLY. Never printed, never hardcoded.
//   * Uploads use the HARDEN_TEST_ org path prefix so cleanup can assert on it.
//     Every object created is deleted in teardown (best effort).
//   * Fixtures are tiny inline magic-byte buffers — no binaries committed.
//   * Fails CLOSED (exit 3 = BLOCKED) if seed/env/manifest missing.
//
// Required env:
//   SUPABASE_STAGING_URL                (default https://<staging-ref>.supabase.co)
//   SUPABASE_STAGING_SERVICE_ROLE_KEY   (service_role key — bucket config reads + cleanup)
//   SUPABASE_STAGING_ANON_KEY           (anon key — the anon-denied cases + apikey header)
//   SEED_TEST_PASSWORD                  (password for the HARDEN_TEST_ users)
// Reads scripts/staging/.seed-manifest.json for org ids + HARDEN_TEST_ users.
//
// Run (ONLY when you intend to execute against staging):
//   node tests/staging/storage.mjs
// Importing this module does nothing (guarded by the import.meta.main check).
// ============================================================================

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- Safety constants ------------------------------------------------------
const STAGING_REF = 'xizehqgeyjcfpzrdymly';
const PROD_REF = 'nqltzgiwznphugcfhmbm';
const PREFIX = 'HARDEN_TEST_';
const MANIFEST_PATH = join(__dirname, '..', '..', 'scripts', 'staging', '.seed-manifest.json');

// Expected bucket config (must mirror 0013_storage_hardening.sql exactly).
const EXPECTED_BUCKETS = {
  'invite-media': {
    public: false,
    file_size_limit: 8388608,
    allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  },
  'event-docs': {
    public: false,
    file_size_limit: 10485760,
    allowed_mime_types: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
  },
};

// ---- env + fail-closed guard ----------------------------------------------
const SUPABASE_URL = (process.env.SUPABASE_STAGING_URL || `https://${STAGING_REF}.supabase.co`).replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_STAGING_SERVICE_ROLE_KEY || '';
const ANON_KEY = process.env.SUPABASE_STAGING_ANON_KEY || '';
const SEED_PASSWORD = process.env.SEED_TEST_PASSWORD || '';

// Exit codes: 0 all pass, 1 some FAIL, 3 BLOCKED (cannot run safely/at all).
function blocked(msg) {
  console.error(`\n[storage] BLOCKED: ${msg}`);
  process.exit(3);
}

function assertStaging() {
  if (SUPABASE_URL.includes(PROD_REF)) blocked(`SUPABASE_STAGING_URL points at PROD ref (${PROD_REF}). Refusing.`);
  if (!SUPABASE_URL.includes(STAGING_REF)) blocked(`SUPABASE_STAGING_URL must contain the staging ref (${STAGING_REF}). Got: ${SUPABASE_URL}`);
  if (!SERVICE_KEY) blocked('SUPABASE_STAGING_SERVICE_ROLE_KEY is not set.');
  if (!ANON_KEY) blocked('SUPABASE_STAGING_ANON_KEY is not set.');
  if (!SEED_PASSWORD) blocked('SEED_TEST_PASSWORD is not set.');
}

// ---- tiny PASS/FAIL recorder ----------------------------------------------
const results = [];
function record(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}
// expect(cond) — cond truthy means PASS
function expect(name, cond, detail) { record(name, cond, detail); }

// ---- HTTP helpers ----------------------------------------------------------
async function loadManifest() {
  let raw;
  try { raw = await readFile(MANIFEST_PATH, 'utf8'); }
  catch { blocked(`seed manifest not found at ${MANIFEST_PATH}. Run scripts/staging/seed-test-data.mjs first.`); }
  let m;
  try { m = JSON.parse(raw); } catch { blocked('seed manifest is not valid JSON.'); }
  if (m.stagingRef && m.stagingRef !== STAGING_REF) blocked(`manifest stagingRef (${m.stagingRef}) != expected (${STAGING_REF}).`);
  if (!Array.isArray(m.orgs) || m.orgs.length < 2) blocked('manifest needs >=2 orgs (A and B) for cross-org tests.');
  if (!Array.isArray(m.users) || !m.users.length) blocked('manifest has no users.');
  return m;
}

// Sign in a HARDEN_TEST user via password grant; returns the access token.
async function signIn(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: SEED_PASSWORD }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) blocked(`could not sign in ${email} (HTTP ${res.status}). Re-seed staging.`);
  return body.access_token;
}

const storageBase = `${SUPABASE_URL}/storage/v1`;

async function getBucket(id) {
  return fetch(`${storageBase}/bucket/${id}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
}

// upload with an arbitrary bearer (user token / anon key) + declared content-type
async function uploadObject(bucket, path, bytes, { token, contentType } = {}) {
  return fetch(`${storageBase}/object/${bucket}/${encodeURI(path)}`, {
    method: 'POST',
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${token || ANON_KEY}`,
      'Content-Type': contentType || 'application/octet-stream',
      'x-upsert': 'false',
    },
    body: bytes,
  });
}

async function readObject(bucket, path, { token } = {}) {
  return fetch(`${storageBase}/object/${bucket}/${encodeURI(path)}`, {
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token || ANON_KEY}` },
  });
}

async function listObjects(bucket, prefix, { token } = {}) {
  return fetch(`${storageBase}/object/list/${bucket}`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, Authorization: `Bearer ${token || ANON_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: prefix || '', limit: 100, offset: 0 }),
  });
}

// service-role delete (teardown only) — never counts toward pass/fail
async function svcDelete(bucket, path) {
  try {
    await fetch(`${storageBase}/object/${bucket}/${encodeURI(path)}`, {
      method: 'DELETE',
      headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    });
  } catch { /* best effort */ }
}

// ---- inline magic-byte fixtures (tiny, valid headers) ----------------------
// These mirror the matchers in public/store-api.js (INVITE_IMG_SNIFF / FILE_SNIFF).
function fx() {
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  // "RIFF" ....(size) "WEBP"
  const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c]);
  const gif = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00]);
  const pdf = Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3]);
  const html = new TextEncoder().encode('<!doctype html><script>alert(1)</script>');
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>');
  // oversize: 1 byte over the invite-media 8 MB cap, png-headed
  const oversize = new Uint8Array(8388608 + 1);
  oversize.set(png.subarray(0, 8), 0);
  return { png, jpeg, webp, gif, pdf, html, svg, oversize };
}

// ---- main ------------------------------------------------------------------
async function main() {
  assertStaging();
  console.log(`[storage] target: ${SUPABASE_URL} (staging ref ${STAGING_REF})`);

  const manifest = await loadManifest();
  const orgA = manifest.orgs[0];
  const orgB = manifest.orgs[1];
  // pick an admin (edit-capable) user in each org
  const pickUser = (orgId) =>
    manifest.users.find((u) => u.orgId === orgId && u.role === 'admin') ||
    manifest.users.find((u) => u.orgId === orgId);
  const uA = pickUser(orgA.id);
  const uB = pickUser(orgB.id);
  if (!uA || !uB) blocked('could not find a HARDEN_TEST user in each org.');

  const tokenA = await signIn(uA.email);
  const tokenB = await signIn(uB.email);

  const f = fx();
  const stamp = Date.now();
  const toDelete = []; // {bucket, path}
  const key = (orgId, bucket, name) => `${orgId}/${PREFIX}${bucket}-${stamp}/${name}`;

  // === 1) BUCKET PROVIDER CONFIG (matches 0013) =============================
  for (const [id, want] of Object.entries(EXPECTED_BUCKETS)) {
    const res = await getBucket(id);
    if (!res.ok) { expect(`bucket ${id}: readable via provider`, false, `HTTP ${res.status}`); continue; }
    const b = await res.json();
    expect(`bucket ${id}: public === false`, b.public === want.public, `got public=${b.public}`);
    expect(`bucket ${id}: file_size_limit === ${want.file_size_limit}`,
      Number(b.file_size_limit) === want.file_size_limit, `got ${b.file_size_limit}`);
    const got = Array.isArray(b.allowed_mime_types) ? [...b.allowed_mime_types].sort() : null;
    const exp = [...want.allowed_mime_types].sort();
    expect(`bucket ${id}: allowed_mime_types match SQL`,
      got && JSON.stringify(got) === JSON.stringify(exp), `got ${JSON.stringify(b.allowed_mime_types)}`);
  }

  // === 2) ANON IS LOCKED OUT ===============================================
  {
    const p = key(orgA.id, 'invite-media', 'anon.png');
    const up = await uploadObject('invite-media', p, f.png, { token: ANON_KEY, contentType: 'image/png' });
    expect('anon upload to invite-media is DENIED', !up.ok, `HTTP ${up.status}`);
    if (up.ok) toDelete.push({ bucket: 'invite-media', path: p });

    // read a (service-uploaded) object as anon -> denied on a private bucket
    const svcPath = key(orgA.id, 'invite-media', 'svc-probe.png');
    const svcUp = await uploadObject('invite-media', svcPath, f.png, { token: SERVICE_KEY, contentType: 'image/png' });
    if (svcUp.ok) toDelete.push({ bucket: 'invite-media', path: svcPath });
    const anonRead = await readObject('invite-media', svcPath, { token: ANON_KEY });
    expect('anon read of private invite-media object is DENIED', !anonRead.ok, `HTTP ${anonRead.status}`);

    const anonList = await listObjects('invite-media', `${orgA.id}/`, { token: ANON_KEY });
    let listedEmpty = false;
    if (anonList.ok) { const arr = await anonList.json().catch(() => []); listedEmpty = Array.isArray(arr) && arr.length === 0; }
    expect('anon listing of invite-media returns denied/empty', !anonList.ok || listedEmpty, `HTTP ${anonList.status}`);
  }

  // === 3) SAME-ORG ALLOWED / CROSS-ORG DENIED (<org_id>/... convention) =====
  for (const bucket of ['invite-media', 'event-docs']) {
    const ext = bucket === 'event-docs' ? 'pdf' : 'png';
    const bytes = bucket === 'event-docs' ? f.pdf : f.png;
    const ctype = bucket === 'event-docs' ? 'application/pdf' : 'image/png';

    // same-org (user A writes under orgA path)
    const samePath = key(orgA.id, bucket, `same.${ext}`);
    const sameUp = await uploadObject(bucket, samePath, bytes, { token: tokenA, contentType: ctype });
    expect(`${bucket}: same-org upload ALLOWED`, sameUp.ok, `HTTP ${sameUp.status}`);
    if (sameUp.ok) toDelete.push({ bucket, path: samePath });
    const sameRead = await readObject(bucket, samePath, { token: tokenA });
    expect(`${bucket}: same-org read ALLOWED`, sameRead.ok, `HTTP ${sameRead.status}`);

    // cross-org write: user B tries to write under orgA's path -> denied by RLS foldername check
    const crossPath = key(orgA.id, bucket, `cross.${ext}`);
    const crossUp = await uploadObject(bucket, crossPath, bytes, { token: tokenB, contentType: ctype });
    expect(`${bucket}: cross-org upload DENIED`, !crossUp.ok, `HTTP ${crossUp.status}`);
    if (crossUp.ok) toDelete.push({ bucket, path: crossPath });

    // cross-org read: user B tries to read orgA's same-org object -> denied
    if (sameUp.ok) {
      const crossRead = await readObject(bucket, samePath, { token: tokenB });
      expect(`${bucket}: cross-org read DENIED`, !crossRead.ok, `HTTP ${crossRead.status}`);
    }
  }

  // === 4) FILE TYPE / SIZE / NAME CASES (invite-media) ======================
  const okCases = [
    ['valid JPEG accepted', 'ok.jpg', f.jpeg, 'image/jpeg'],
    ['valid PNG accepted', 'ok.png', f.png, 'image/png'],
    ['valid WEBP accepted', 'ok.webp', f.webp, 'image/webp'],
    ['valid GIF accepted', 'ok.gif', f.gif, 'image/gif'],
  ];
  for (const [name, fname, bytes, ctype] of okCases) {
    const p = key(orgA.id, 'invite-media', fname);
    const up = await uploadObject('invite-media', p, bytes, { token: tokenA, contentType: ctype });
    expect(`invite-media: ${name}`, up.ok, `HTTP ${up.status}`);
    if (up.ok) toDelete.push({ bucket: 'invite-media', path: p });
  }

  // Declared-MIME allowlist rejections (Supabase validates the DECLARED content-type).
  const rejectCases = [
    // name,                            fname,            bytes,    declared content-type
    ['oversize (>8 MB) REJECTED', 'big.png', f.oversize, 'image/png'],
    ['SVG REJECTED (not in allowlist)', 'x.svg', f.svg, 'image/svg+xml'],
    ['wrong MIME (pdf to image bucket) REJECTED', 'doc.pdf', f.pdf, 'application/pdf'],
    ['double-extension x.png.html (declared text/html) REJECTED', 'x.png.html', f.html, 'text/html'],
  ];
  for (const [name, fname, bytes, ctype] of rejectCases) {
    const p = key(orgA.id, 'invite-media', fname);
    const up = await uploadObject('invite-media', p, bytes, { token: tokenA, contentType: ctype });
    expect(`invite-media: ${name}`, !up.ok, `HTTP ${up.status}`);
    if (up.ok) toDelete.push({ bucket: 'invite-media', path: p });
  }

  // Content-disguise is a KNOWN Supabase architecture point: the bucket allowlist
  // checks the DECLARED content-type, not magic bytes, so HTML sent as image/png is
  // stored. The real controls are: client-side magic-byte validation before upload
  // (tests/invite-media-hardening.test.mjs), a PRIVATE bucket + org-scoped RLS, and
  // the object being SERVED with its declared type (image/png) — so it cannot execute
  // as an HTML document. Assert those true controls, not a rejection Supabase doesn't do.
  {
    const p = key(orgA.id, 'invite-media', 'declared.png');
    const up = await uploadObject('invite-media', p, f.html, { token: tokenA, contentType: 'image/png' });
    if (up.ok) toDelete.push({ bucket: 'invite-media', path: p });
    const got = await readObject('invite-media', p, { token: tokenA });
    const ct = got.headers.get('content-type') || '';
    expect('invite-media: HTML-as-image served as declared image type (not text/html)',
      up.ok && ct.startsWith('image/') && !/text\/html/i.test(ct), `served '${ct}'`);
    const anon = await readObject('invite-media', p, { token: null });
    expect('invite-media: HTML-as-image stays private (anon denied)', !anon.ok, `anon HTTP ${anon.status}`);
  }

  // Path-traversal: Supabase stores the key literally ('..' is NOT resolved) and RLS
  // scopes by foldername[1]=org_id, so a '../' segment cannot escape the org prefix,
  // the bucket, or the private flag. Assert the '..' object cannot be read anonymously.
  {
    const p = `${orgA.id}/${PREFIX}trav-${stamp}/../escape.png`;
    const up = await uploadObject('invite-media', p, f.png, { token: tokenA, contentType: 'image/png' });
    if (up.ok) toDelete.push({ bucket: 'invite-media', path: p });
    const anon = await readObject('invite-media', p, { token: null });
    expect('invite-media: path-traversal key cannot escape to public (anon denied)', !anon.ok, `anon HTTP ${anon.status}`);
  }

  // event-docs: PDF allowed, html rejected, wrong-mime (gif not in event-docs allowlist) rejected
  {
    const p = key(orgA.id, 'event-docs', 'ok.pdf');
    const up = await uploadObject('event-docs', p, f.pdf, { token: tokenA, contentType: 'application/pdf' });
    expect('event-docs: valid PDF accepted', up.ok, `HTTP ${up.status}`);
    if (up.ok) toDelete.push({ bucket: 'event-docs', path: p });

    // Same declared-MIME architecture as invite-media: assert HTML-as-PDF is served
    // as its declared application/pdf type (not text/html) and stays private.
    const pH = key(orgA.id, 'event-docs', 'declared.pdf');
    const upH = await uploadObject('event-docs', pH, f.html, { token: tokenA, contentType: 'application/pdf' });
    if (upH.ok) toDelete.push({ bucket: 'event-docs', path: pH });
    const gotH = await readObject('event-docs', pH, { token: tokenA });
    const ctH = gotH.headers.get('content-type') || '';
    expect('event-docs: HTML-as-PDF served as declared type (not text/html)',
      upH.ok && /application\/pdf/i.test(ctH) && !/text\/html/i.test(ctH), `served '${ctH}'`);

    const pG = key(orgA.id, 'event-docs', 'x.gif');
    const upG = await uploadObject('event-docs', pG, f.gif, { token: tokenA, contentType: 'image/gif' });
    expect('event-docs: gif (not in allowlist) REJECTED', !upG.ok, `HTTP ${upG.status}`);
    if (upG.ok) toDelete.push({ bucket: 'event-docs', path: pG });
  }

  // === teardown (best effort; never affects pass/fail) =====================
  for (const { bucket, path } of toDelete) await svcDelete(bucket, path);

  // === gate ================================================================
  const failed = results.filter((r) => !r.ok);
  console.log(`\n[storage] ${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length) {
    console.log('[storage] GATE: FAIL');
    for (const r of failed) console.log(`   FAIL: ${r.name}${r.detail ? ' (' + r.detail + ')' : ''}`);
    process.exit(1);
  }
  console.log('[storage] GATE: PASS');
  process.exit(0);
}

if (decodeURIComponent(import.meta.url) === `file://${process.argv[1]}`) {
  main().catch((err) => { blocked(err?.message || String(err)); });
}

export { EXPECTED_BUCKETS, STAGING_REF, PROD_REF };
