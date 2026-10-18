/* flash fix: app pages must set the Emerald shell theme BEFORE first paint (no old violet flash). */
import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const r = (p) => readFileSync(p, 'utf8');
const proto = r('public/shell-proto.js');
const APP = /var APP = \{([^}]*)\}/.exec(proto)[1].match(/"?([a-z-]+)"?: 1/g).map((x) => x.replace(/"|: 1/g, ''));
let n = 0;
for (const p of APP) {
  const f = 'public/' + p + '.html'; if (!existsSync(f)) continue;
  const h = r(f), head = h.slice(0, h.indexOf('</head>'));
  assert.match(head, /<script src="\/shell-proto\.js\?v=\d+" id="shellProto"><\/script>\s*$/, f + ': shell-proto loads synchronously at the end of <head>');
  n++;
}
assert.ok(n >= 30, 'covers the app pages');
assert.match(proto, /var early = !document\.body;/);
assert.match(proto, /if \(early\) l\.setAttribute\("blocking", "render"\)/, 'shell CSS is render-blocking in head mode');
assert.match(proto, /document\.addEventListener\("DOMContentLoaded", function \(\) \{ jsq\.forEach\(addJs\); \}\)/, 'shell JS still runs after the page scripts');
const api = r('public/store-api.js'), pin = /shell-proto\.js\?v=(\d+)/.exec(api)[1];
for (const p of APP) { const f = 'public/' + p + '.html'; if (existsSync(f)) assert.equal(/shell-proto\.js\?v=(\d+)/.exec(r(f))[1], pin, f + ': same shell-proto pin as store-api'); }
assert.doesNotMatch(r('public/dashboard.html'), /#ece3ff/, 'dashboard background has no violet wash');
console.log(`flash-head-shell: ok (${n} app pages)`);
