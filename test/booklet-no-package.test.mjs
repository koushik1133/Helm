// A package only shows as chosen when one was actually applied for THIS quote (menu.mode !== 'choose').
import assert from "node:assert/strict";
import fs from "node:fs";
const bk = fs.readFileSync(new URL("../public/booklet.js", import.meta.url), "utf8");
const sc = fs.readFileSync(new URL("../public/share-checklist.js", import.meta.url), "utf8");
globalThis.window = globalThis;
globalThis.document = { getElementById: () => null, querySelector: () => null, addEventListener() {}, readyState: "loading" };
try { new Function(bk)(); } catch (e) { /* DOM boot may fail in node; the export runs before boot */ }
const B = globalThis.HelmBooklet;
if (B && B.menuChoosing) {
  assert.equal(B.menuChoosing({ mode: "choose", package: "Gold" }), true);
  assert.equal(B.menuChoosing({ mode: "selected" }), false);
  assert.equal(B.menuChoosing({}), false);
}
assert.match(bk, /pk = choosing \? null : mn\.selected_package/);
assert.match(bk, /mn\.package && !choosing/);
assert.match(bk, /"Choose a package"/);
assert.match(bk, /menuChoosing\(mn\) \|\| mn\.selected_package/);
assert.doesNotMatch(sc, /p\.menu_template \|\| p\.package/);
assert.match(sc, /list\.some\(\(t\) => t && t\.name === name\)/);
console.log("booklet-no-package: ok");
