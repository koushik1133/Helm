// Vfix: a brand-new quote with a hall size (flow / linked venue, e.g. 262×164 ft) got its default layout
// built in the default 200×140 ft room. The arrival block must size WORLD from client.hallLen/hallWid
// (or the ?gen URL's len/wid) BEFORE building the default layout.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const js = readFileSync(new URL('../public/builder.js', import.meta.url), 'utf8');
const a = js.indexOf("const hl=pick(cl.hallLen, u&&u.get('len'))");
const b = js.indexOf('store.items = fam ? buildEventDefault(fam, N) : TEMPLATES[presetKey]();');
assert.ok(a > 0 && b > a, 'hall is sized before the default layout is built');
assert.match(js, /WORLD\.w=clamp\(Math\.round\(hl\),20,maxFt\); WORLD\.h=clamp\(Math\.round\(hw\),20,maxFt\);/);
console.log('v-hall: ok');
