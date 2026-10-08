#!/usr/bin/env node
/* upload-quarantine.test.mjs — 0051 server-side upload verification (static, no network).
 * Behaviour is proven by tests/db/upload-quarantine.sql (RLS) and tests/edge/verify-upload.test.ts. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
let passed = 0; const t = (n, f) => { f(); passed++; console.log('  ✓ ' + n); };
const mig = read('supabase/migrations/0051_upload_quarantine.sql');
const apply = read('supabase/APPLY-0051.sql');
const fn = read('supabase/functions/verify-upload/index.ts');
const api = read('public/store-api.js');
const ev = read('public/event.html');
const man = read('supabase/migrations/MANIFEST');
t('enforce flag defaults OFF (dormant until the owner deploys + flips it)', () => {
  assert.match(mig, /enforce\s+boolean not null default false/);
  assert.match(mig, /values \(true, false\) on conflict \(id\) do nothing/);
  assert.match(apply, /values \(true, false\) on conflict \(id\) do nothing/);
});
t('existing objects grandfathered clean; nothing deleted', () => {
  assert.match(mig, /'clean', 'grandfathered'/);
  assert.doesNotMatch(mig.replace(/^--.*$/gm, ''), /delete\s+from|drop\s+table|truncate/i);
});
t('read gate is RESTRICTIVE; scanner RPCs revoked from clients', () => {
  assert.match(mig, /create policy upload_scan_read_gate on storage\.objects as restrictive for select/);
  assert.match(mig, /revoke all on function public\.upload_scan_claim\(int\) from public, anon, authenticated/);
  assert.match(mig, /revoke all on function public\.upload_scan_mark\(uuid, text, text, bigint\) from public, anon, authenticated/);
});
t('APPLY-0051 mirrors the migration body and preflights 0048', () => {
  const body = mig.slice(mig.indexOf('-- ---- tables'), mig.indexOf('-- ---- VERIFY')).trim();
  assert.ok(apply.includes(body), 'APPLY body drifted from the migration');
  assert.match(apply, /STOP: 0048 not installed/);
});
t('MANIFEST lists 0051 after 0048', () => {
  assert.ok(man.indexOf('0051_upload_quarantine.sql') > man.indexOf('0048_upload_hardening.sql'));
});
t('verify-upload: dormant by default, secret-gated, body-capped, no caller-supplied paths', () => {
  assert.match(fn, /if \(Deno\.env\.get\("HELM_UPLOAD_SCAN_ENABLED"\) !== "true"\) return json\(\{ status: "dormant" \}\)/);
  assert.match(fn, /secretMatches\(req\.headers\.get\("x-helm-cron-secret"\)/);
  assert.match(fn, /readBodyCapped\(req, WEBHOOK_BODY_LIMIT\)/);
  assert.match(fn, /admin\.rpc\("upload_scan_claim"/);
  assert.doesNotMatch(fn, /storage\/v1\/object\/[^"]*\$\{[^}]*body/);
});
t('verify-upload: AV only to an https allowlisted host with a timeout; no hard delete', () => {
  assert.match(fn, /u\.protocol !== "https:"[^\n]*!hosts\.includes/);
  assert.match(fn, /AbortController/);
  assert.doesNotMatch(fn, /method: "DELETE"|\.remove\(/);
});
t('client: scanStatus is best-effort and event files show Scanning…', () => {
  assert.match(api, /scanStatus: ugScanStatus/);
  assert.match(api, /if \(error \|\| !Array\.isArray\(data\)\) return \{\};/);
  assert.match(ev, /Scanning…/);
  assert.match(ev, /renderFiles\._n<=24/);
});
console.log(`\nupload-quarantine: ${passed} passed.`);
