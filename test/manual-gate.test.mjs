#!/usr/bin/env node
// manual-gate.test.mjs — the user manual is behind sign-in (2026-10).
// The content is no longer a deployed public file; /manual gates on sign-in and
// downloads it from the private "helm-manual" bucket (0031). Pure Node, no deps.
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('manual content is NOT deployed: no public screenshots, the old URL is a content-free stub', () => {
  assert.ok(!existsSync(new URL('public/docs/screenshots', root)), 'public/docs/screenshots must be gone');
  const stub = read('public/docs/USER-MANUAL.html');
  assert.ok(stub.length < 1200 && !/<img|<h2|<style/i.test(stub), 'stub holds no manual content');
  assert.match(stub, /http-equiv="refresh" content="0;url=\/manual"/);
  assert.match(stub, /noindex/);
  assert.ok(existsSync(new URL('docs/manual/USER-MANUAL.html', root)), 'source kept (not deployed) in docs/manual/');
});
t('vercel.json redirects the old public URLs to /manual; /manual is noindex + no-store', () => {
  const v = JSON.parse(read('vercel.json'));
  const re = (s) => new RegExp('^' + s.replace(/:file\*/, '.*') + '$');
  for (const p of ['/docs/USER-MANUAL', '/docs/USER-MANUAL.html', '/docs/screenshots/a.webp'])
    assert.equal((v.redirects.find((r) => !r.has && re(r.source).test(p)) || {}).destination, '/manual', p);
  const h = {}; for (const r of v.headers) if (!r.has && new RegExp('^' + r.source + '$').test('/manual')) for (const x of r.headers) h[x.key.toLowerCase()] = x.value;
  assert.match(h['x-robots-tag'] || '', /noindex/); assert.match(h['cache-control'] || '', /no-store/);
  assert.match(read('public/_headers'), /^\/manual\n  X-Robots-Tag: noindex/m);
});
t('/manual page: noindex, no inline script, gated exactly like app pages', () => {
  const html = read('public/manual.html'), js = read('public/manual.js');
  assert.match(html, /<meta name="robots" content="noindex/);
  assert.ok(!/<script>(?!<\/script>)/.test(html) && !/<script>[\s\S]*?<\/script>/.test(html), 'no inline <script>');
  assert.match(js, /BPStore\.auth\.required\(\) && !BPStore\.auth\.user\(\)/);
  assert.match(js, /location\.replace\("login\.html\?next=" \+ encodeURIComponent\("manual"\)\)/);
  // the ?next= allowlist moved from login.html into store-api.js safeNext() (auth-gate fix)
  assert.match(read('public/login.html'), /BPStore\.auth\.safeNext\(/, 'login ?next= uses the shared sanitiser');
  assert.match(read('public/store-api.js'), /const NEXT_PAGES = \[[^\]]*"manual"/, 'login ?next= allowlist includes manual');
  assert.match(js, /script,iframe,frame,object,embed,link,meta,base,form/, 'strips executable / remote-loading tags');
  assert.ok(!/innerHTML/.test(js), 'no innerHTML sinks');
});
t('store-api reads the manual from the PRIVATE bucket with the user session (signed URLs for images)', () => {
  const s = read('public/store-api.js');
  assert.match(s, /storage\.from\("helm-manual"\)/);
  assert.match(s, /\.download\("USER-MANUAL\.html"\)/);
  assert.match(s, /createSignedUrls\(names, ttl\)/);
  assert.ok(!/getPublicUrl\([^)]*\)[^;]*helm-manual|helm-manual[^;]*getPublicUrl/.test(s), 'never a public URL');
});
t('0031: private bucket + ONE staff-read policy, no write policy; in MANIFEST', () => {
  const m = read('supabase/migrations/0031_manual_private_bucket.sql');
  assert.match(m, /'helm-manual', 'helm-manual', false/);
  assert.match(m, /for select to authenticated/);
  assert.ok(!/for (insert|update|delete|all)/i.test(m), 'no write policy');
  assert.match(read('supabase/migrations/MANIFEST'), /^forward\s+supabase\/migrations\/0031_manual_private_bucket\.sql$/m);
});
t('profile menu "User manual" opens the gated page (dashboard button moved into the menu)', () =>
  assert.match(read('public/auth-ui.js'), /id: "manual", label: "User manual", href: "manual\.html"/));
console.log(`\nmanual-gate: ${n} passed`);
