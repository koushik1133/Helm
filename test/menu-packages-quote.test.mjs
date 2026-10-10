// Menu packages on the quote flow (step 5): cards must survive loadSection, dishes pre-fill, price drives.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const s = readFileSync(new URL("../public/flow.html", import.meta.url), "utf8");
// Root cause: loadSection clears its slot on success, so the slot must NOT be the cards container.
assert.match(s, /packages:\s*\["#err-menu","menu packages",loadPackages\]/, "packages section must use its own error slot");
assert.doesNotMatch(s, /packages:\s*\["#pkgCards"/, "pkgCards must not be the loadSection slot (it gets wiped)");
assert.match(s, /id="err-menu"/, "error slot present");
assert.match(s, /No menu packages set up yet — <a href="control.html#menu">/, "empty state links to Control Center");
// Dishes pre-fill + price
assert.match(s, /fillPackageDishes\(t\); appliedPkg=t;/, "apply pre-fills dishes before switching applied package");
assert.match(s, /\$\("#q_platePrice"\)\.value=t\.price_per_plate/, "package drives plate price");
assert.match(s, /const sel=plan&&\(plan\.menu_template\|\|plan\.package\)/, "reload restores selection");
// packageDishText groups by course
const m = s.match(/function packageDishText\(t\)\{[\s\S]*?\n\s*return [^\n]*\}/);
assert.ok(m, "packageDishText present");
const fn = new Function(m[0] + "; return packageDishText;")();
assert.equal(fn({ dishes: [{ c: "Starters", n: "Paneer Tikka" }, { c: "Mains", n: "Biryani" }, { c: "Starters", n: "Kebab" }] }),
  "Starters: Paneer Tikka, Kebab\nMains: Biryani");
assert.equal(fn({ dishes: null }), "");
console.log("menu-packages-quote: ok");
