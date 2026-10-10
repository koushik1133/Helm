// Menu packages on the quote flow (step 5): cards must survive loadSection, dishes pre-fill, price drives.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const s = readFileSync(new URL("../public/flow.html", import.meta.url), "utf8");
// Root cause: loadSection clears its slot on success, so the slot must NOT be the cards container.
assert.match(s, /packages:\s*\["#err-menu","menu packages",loadPackages\]/, "packages section must use its own error slot");
assert.doesNotMatch(s, /packages:\s*\["#pkgCards"/, "pkgCards must not be the loadSection slot (it gets wiped)");
assert.match(s, /id="err-menu"/, "error slot present");
assert.match(s, /No menu packages set up yet — <a href="control.html#menu">/, "empty state links to Control Center");
// Dishes now go to the per-course dish editor (event_menu_items), not into the notes box
assert.match(s, /appliedPkg=t; if\(dishEd\) await dishEd\.reload\(\);/, "apply reloads the dish editor");
assert.doesNotMatch(s, /packageDishText|fillPackageDishes/, "dishes are no longer dumped into the notes textarea");
assert.match(s, /\$\("#q_platePrice"\)\.value=t\.price_per_plate/, "package drives plate price");
assert.match(s, /const sel=plan&&\(plan\.menu_template\|\|plan\.package\)/, "reload restores selection");
console.log("menu-packages-quote: ok");
