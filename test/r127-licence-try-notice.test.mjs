// r127: Helm is proprietary (no MIT claim), /try shows the copyright + terms notice, HQ date ranges read cleanly.
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { buildTry } from '../scripts/gen-try.mjs';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0;
const t = (name, fn) => { try { fn(); n++; console.log('  ok ' + name); } catch (e) { console.error('  FAIL ' + name + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

t('package.json is proprietary and can never be published to npm', () => {
  const p = JSON.parse(r('package.json'));
  assert.equal(p.license, 'UNLICENSED');
  assert.equal(p.private, true);
});
t('package-lock agrees with package.json', () => {
  assert.equal(JSON.parse(r('package-lock.json')).packages[''].license, 'UNLICENSED');
});
t('LICENSE states all rights reserved and is not an open-source grant', () => {
  assert.ok(existsSync(new URL('../LICENSE', import.meta.url)));
  const l = r('LICENSE');
  assert.match(l, /All rights reserved/);
  assert.match(l, /No licence is granted/);
  assert.doesNotMatch(l, /Permission is hereby granted/i);
});
t('LICENSE stays out of the site (public/ is the deploy root)', () => {
  assert.ok(!existsSync(new URL('../public/LICENSE', import.meta.url)));
});
t('/try shows copyright and links both legal pages, including when regenerated', () => {
  for (const h of [r('public/try.html'), buildTry(r('public/builder.html'))]) {
    const m = h.match(/<p class="try-legal">[\s\S]*?<\/p>/);
    assert.ok(m, 'notice present');
    assert.match(m[0], /© 2026 Helm Events\. All rights reserved\./);
    assert.match(m[0], /href="\/terms"/);
    assert.match(m[0], /href="\/acceptable-use"/);
  }
});
t('the notice is styled on desktop and on phones', () => {
  const c = r('public/try.css');
  assert.match(c, /^\.try-legal\{position:fixed/m);
  assert.match(c, /^  \.try-legal\{left:10px;right:10px/m);
});
t('hq.js turns every ".." in a date range into " to "', () => {
  assert.match(r('public/hq.js'), /id\.replace\(\/\\\.\\\.\/g, " to "\)/);
  assert.equal('2026-11-01..2026-11-05'.replace(/\.\./g, ' to '), '2026-11-01 to 2026-11-05');
});
console.log(n + ' r127 checks passed');
