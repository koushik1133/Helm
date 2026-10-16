import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
const s = fs.readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
test('supabase client fetch goes through read coalescing', () => {
  assert.match(s, /function coalescedFetch\(/);
  assert.match(s, /return coalescedFetch\(input, init\)\.then/);
});
test('coalescing is safe: writes clear cache, keyed by token, short TTL, rest only', () => {
  assert.match(s, /if \(!isRead\) \{ readCache\.clear\(\);/);
  assert.match(s, /hdrOf\(init, input, "Authorization"\)/);
  assert.match(s, /const READ_TTL_MS = 1500;/);
  assert.match(s, /if \(!\/\\\/rest\\\/v1\\\/\/\.test\(u\)/);
  assert.match(s, /\.then\(\(r\) => r\.clone\(\)\)/);
});
