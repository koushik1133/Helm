// csp-hashes: the hash-based script-src must match what browsers compute, and
// must reject anything a hash can't cover (inline handlers, javascript: URLs).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { inlineScripts, withHashes } = require('../scripts/csp-hashes.cjs');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

t('hash equals the browser value for the exact element text', () => {
  // echo -n 'alert(1)' | openssl dgst -sha256 -binary | base64
  const [s] = inlineScripts('<script>alert(1)</script>');
  assert.equal(s.hash, "'sha256-bhHHL3z2vDgxUt0W3dWQOrprscmda2Y5pLsLg4GF+pI='");
});

t('external, JSON-LD and template scripts are not hashed; module scripts are', () => {
  const html = '<script src="/a.js"></script><script type="application/ld+json">{}</script>'
    + '<script type="text/template">x</script><script type="module">m()</script><script>x()</script>';
  assert.equal(inlineScripts(html).length, 2);
});

t("withHashes drops 'unsafe-inline' + stale hashes and keeps host sources", () => {
  const out = withHashes("default-src 'self'; script-src 'self' 'unsafe-inline' 'sha256-old=' https://cdnjs.cloudflare.com; img-src 'self'", ["'sha256-new='"]);
  assert.equal(out, "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com 'sha256-new='; img-src 'self'");
});

t('gen-csp --check fails on an inline event handler', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'csp-'));
  mkdirSync(join(tmp, 'scripts')); mkdirSync(join(tmp, 'public'));
  cpSync(join(ROOT, 'scripts', 'gen-csp.mjs'), join(tmp, 'scripts', 'gen-csp.mjs'));
  cpSync(join(ROOT, 'scripts', 'csp-hashes.cjs'), join(tmp, 'scripts', 'csp-hashes.cjs'));
  writeFileSync(join(tmp, 'vercel.json'), JSON.stringify({ headers: [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: "script-src 'self'" }] }] }));
  writeFileSync(join(tmp, 'public', '_headers'), "/*\n  Content-Security-Policy: script-src 'self'\n");
  writeFileSync(join(tmp, 'public', 'a.html'), '<button onclick="x()">x</button><script>ok()</script>');
  let failed = false;
  try { execFileSync(process.execPath, [join(tmp, 'scripts', 'gen-csp.mjs'), '--check'], { stdio: 'pipe' }); } catch { failed = true; }
  assert.ok(failed, 'expected --check to fail on onclick=');
  // after removing the handler and regenerating, --check passes
  writeFileSync(join(tmp, 'public', 'a.html'), '<button>x</button><script>ok()</script>');
  execFileSync(process.execPath, [join(tmp, 'scripts', 'gen-csp.mjs')], { stdio: 'pipe' });
  execFileSync(process.execPath, [join(tmp, 'scripts', 'gen-csp.mjs'), '--check'], { stdio: 'pipe' });
  assert.match(readFileSync(join(tmp, 'vercel.json'), 'utf8'), /sha256-/);
});

console.log(`\ncsp-hashes: ${n} test(s) passed.`);
