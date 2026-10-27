// auth-ui.js is injected by store-api.js using AUTH_UI_VERSION; it must match every <script src="auth-ui.js?v=N">
// so a changed auth-ui.js is never served from a stale browser cache (live bug: Settings kept v=19).
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
const dir = new URL('../public/', import.meta.url);
const v = readFileSync(new URL('store-api.js', dir), 'utf8').match(/const AUTH_UI_VERSION = "(\d+)";/)[1];
for (const f of readdirSync(dir).filter((x) => x.endsWith('.html'))) {
  for (const m of readFileSync(new URL(f, dir), 'utf8').matchAll(/auth-ui\.js\?v=(\d+)/g)) assert.equal(m[1], v, `${f} loads auth-ui v${m[1]} but store-api injects v${v}`);
}
console.log('auth-ui-version-sync: ok (v' + v + ')');
