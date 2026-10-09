// R10 hotfix: ?gen=1 arrival crashed with "rawType is not defined" (CI tests only extracted
// functions, so the init path was never parsed for free identifiers). Guard both fixes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const js = readFileSync(new URL('../public/builder.js', import.meta.url), 'utf8');
const use = js.indexOf("CE_TYPE[rawType]");
const def = js.lastIndexOf("const rawType=", use);
assert.ok(use > 0 && def > 0 && use - def < 400, 'rawType is declared right before it is used in the ?gen=1 block');
assert.match(js, /u\.get\('from'\)==='flow' && u\.get\('chairs'\)/, 'flow arrival seats come from the URL first');
// every identifier used as CE_TYPE[...] / layoutRules.get(...) in the gen block must be declared in it
const block = js.slice(js.indexOf("if(params.get('gen')==='1'"), js.indexOf("if(params.get('gen')==='1'") + 4000);
for (const m of block.matchAll(/CE_TYPE\[(\w+)\]|layoutRules\.get\((\w+)\)/g)) {
  const id = m[1] || m[2];
  assert.ok(new RegExp('(const|let|var)\\s+' + id + '\\s*=').test(block) || new RegExp('(const|let|var)\\s+' + id + '\\s*=').test(js.slice(0, js.indexOf("if(params.get('gen')==='1'"))), id + ' declared');
}
console.log('r10-hotfix: ok');
