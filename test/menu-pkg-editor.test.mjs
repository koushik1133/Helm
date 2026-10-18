// Control Center > Menus & catalog > Menu packages: chips by category + category / dish dropdowns
// (public/menu-pkg-editor.js). Pure helpers run in Node; the page wiring is checked statically.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const M = require("../public/menu-pkg-editor.js");

// ---- price: always the stored number, never a blank or a silent 0 ----------------------------
assert.equal(M.priceOf({ price_per_plate: 450 }), 450);
assert.equal(M.priceOf({ price_per_plate: "450" }), 450, "numeric column as a string still shows");
assert.equal(M.priceOf({ price_per_plate: "450.00" }), 450);
assert.equal(M.priceOf({ price_per_plate: 0 }), 0, "0 is a real price");
assert.equal(M.priceOf({ per_person: 650 }), 650, "package-flow name per_person");
assert.equal(M.priceOf({ price_per_plate: null, price: "1,400" }), 1400);
assert.equal(M.priceOf({ price_per_plate: null }), null, "missing price -> empty box with a prompt");
assert.equal(M.priceOf({ price_per_plate: "abc" }), null);
assert.equal(M.priceOf({ price_per_plate: -5 }), null);
assert.equal(M.priceText(450), "450"); assert.equal(M.priceText(null), ""); assert.equal(M.priceText(12.345), "12.35");

// ---- dishes ---------------------------------------------------------------------------------------
const std = [{ c: "Welcome drinks", n: "Lemon mint cooler", k: "veg" }, { c: "Starters (veg)", n: "Paneer tikka", k: "veg" },
  { c: "Starters (veg)", n: "Gobi Manchurian", k: "veg" }, { c: "Desserts", n: "Gulab jamun", k: "veg" }];
assert.deepEqual(M.normDishes([{ category: "Soups", name: " Sweet  corn ", kind: "NONVEG" }, { n: "" }, null, { n: "Sweet corn", c: "soups" }]),
  [{ c: "Soups", n: "Sweet corn", k: "nonveg" }], "legacy keys, trims, blanks + duplicates dropped");
assert.equal(M.normKind("non-veg"), "nonveg"); assert.equal(M.normKind("Special"), "special"); assert.equal(M.normKind("x"), "veg");
// text round trip (the "Paste as text" toggle keeps the old format)
assert.equal(M.toText(std).split("\n")[1], "Starters (veg) | Paneer tikka | veg");
assert.deepEqual(M.parseText(M.toText(std)), std);
assert.deepEqual(M.parseText("Paneer 65\nSoups | Tomato soup\n\n  Desserts | Kulfi | special  "),
  [{ c: "Other", n: "Paneer 65", k: "veg" }, { c: "Soups", n: "Tomato soup", k: "veg" }, { c: "Desserts", n: "Kulfi", k: "special" }]);
// groups keep first-appearance order
assert.deepEqual(M.groups(std).map((g) => g.c + ":" + g.items.length), ["Welcome drinks:1", "Starters (veg):2", "Desserts:1"]);
// add: lands after the last dish of its category; duplicates refused
let a = M.addDish(std, { c: "Starters (veg)", n: "Paneer 65", k: "veg" });
assert.ok(a.ok); assert.deepEqual(a.dishes.map((d) => d.n), ["Lemon mint cooler", "Paneer tikka", "Gobi Manchurian", "Paneer 65", "Gulab jamun"]);
assert.equal(M.addDish(std, { c: "starters (VEG)", n: "paneer TIKKA" }).error, "duplicate");
assert.deepEqual(M.addDish(std, { c: "Breads", n: "Butter naan", k: "veg" }).dishes.at(-1), { c: "Breads", n: "Butter naan", k: "veg" });
assert.equal(std.length, 4, "helpers never mutate the input");
// remove / move
assert.deepEqual(M.removeAt(std, 2).map((d) => d.n), ["Lemon mint cooler", "Paneer tikka", "Gulab jamun"]);
assert.deepEqual(M.moveDish(std, 2, 1).map((d) => d.n).slice(1, 3), ["Gobi Manchurian", "Paneer tikka"]);
assert.equal(M.moveDish(std, 0, 3), std, "never across categories");
assert.deepEqual(M.stepDish(std, 1, 1).map((d) => d.n).slice(1, 3), ["Gobi Manchurian", "Paneer tikka"]);
assert.equal(M.stepDish(std, 0, -1), std, "first in its category stays");
assert.deepEqual(M.groups(M.moveCategory(std, "Desserts", -1)).map((g) => g.c), ["Welcome drinks", "Desserts", "Starters (veg)"]);
assert.equal(M.moveCategory(std, "Welcome drinks", -1), std);
// catalog-driven dropdowns
const cat = [{ category: "Desserts", name: "Rasmalai", kind: "veg" }, { category: "Starters (nonveg)", name: "Chicken 65", kind: "nonveg" },
  { category: "Desserts", name: "Kaju katli", kind: "special" }, { category: "Old", name: "Gone", kind: "veg", active: false },
  { category: "Starters (veg)", name: "Chicken 65", kind: "nonveg" }];
assert.deepEqual(M.categories(cat, std), ["Desserts", "Starters (nonveg)", "Starters (veg)", "Welcome drinks"], "catalog + package categories, inactive dropped");
assert.deepEqual(M.catalogFor(cat, "Desserts").map((x) => x.name), ["Kaju katli", "Rasmalai"]);
assert.equal(M.catalogFor(cat, "").length, 4);
assert.equal(M.findDish(cat, "kaju KATLI", "").kind, "special", "kind comes from the catalog");
assert.equal(M.findDish(cat, "Chicken 65", "Starters (veg)").category, "Starters (veg)", "same category wins");
assert.equal(M.findDish(cat, "Gone", ""), null);
assert.ok(M.same(std, JSON.parse(JSON.stringify(std))) && !M.same(std, M.removeAt(std, 0)));

// ---- the editor file: DOM by createElement only, trial saves the price only ----------------------
const src = r("public/menu-pkg-editor.js");
assert.ok(/^[\x00-\x7F]*$/.test(src), "ASCII only (unicode as \\u escapes)");
assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src), "no HTML sinks");
assert.match(src, /ctx\.trial\(\) \? \{ price_per_plate: pp \} : \{ price_per_plate: pp, active: !!act\.checked, dishes: normDishes\(st\.dishes\) \}/,
  "free trial (0173): Save sends only the price");
assert.match(src, /if \(!trial\) \{\s*add = el\("div", "mpk-add"\)/, "no add-dish row in the trial");
assert.match(src, /if \(trial\) \{ act\.disabled = true;/, "active switch fixed in the trial");
assert.match(src, /price\.value = priceText\(st\.price\);/, "price set as a property from the tolerant reader");
assert.match(src, /if \(raw === ""\) \{ ctx\.error\("Enter the price per plate for "/, "an empty price is refused, never saved as 0");
assert.match(src, /el\("summary", null, "Paste as text \(bulk\)"\)/);
assert.match(src, /dishIn\.setAttribute\("list", dl\.id\)/, "searchable dish list");

// ---- Control Center wiring ---------------------------------------------------------------------------
const cc = r("public/control.html");
assert.match(cc, /<script src="menu-pkg-editor\.js\?v=\d+"><\/script>/);
assert.match(cc, /<link rel="stylesheet" href="menu-pkg-editor\.css\?v=\d+">/);
const fn = cc.slice(cc.indexOf("async function renderMenuTemplates(){"), cc.indexOf("// Vendors moved to the dedicated"));
assert.match(fn, /BPStore\.menuTemplates\.list\(true\)/); assert.match(fn, /BPStore\.dishCatalog\.list\(\)/);
assert.match(fn, /HelmMenuPkg\.render\(\$\("#menuTplList"\)/); assert.match(fn, /BPStore\.menuTemplates\.update\(t\.id, patch\)/);
assert.match(fn, /trial:mpkTrial/); assert.match(cc, /const mpkTrial=\(\)=>document\.documentElement\.classList\.contains\("helm-trial"\)/);
assert.match(cc, /window\.addEventListener\("helm:trial",\(\)=>\{ if\(mpkUI && !mpkUI\.dirty\(\)\) renderMenuTemplates\(\); \}\)/);
assert.match(cc, /if\(mpkUI\) mpkUI\.setCatalog\(dishCache\);/, "new catalog dishes show up in the dropdowns");
assert.ok(!/tpl_dishes"[^>]*>\$\{esc\(dishesToText/.test(cc), "old textarea editor gone");
const css = r("public/menu-pkg-editor.css");
assert.match(css, /\.mpk-chip\{/); assert.match(css, /@media \(max-width:720px\)/);

console.log("menu-pkg-editor: ok");
