// 0192: every edge case of "Save package" in Settings > Menus & catalog > Menu packages.
// Pure checks (price / dish list / bulk text) run in Node; the card is driven through a tiny fake DOM:
// cleared price -> inline "Enter a price per plate" and NOTHING is sent; 0 / negative / text / > 1,00,000 /
// 3 decimals blocked; active package with no dishes blocked; inactive keeps its last price, never cleared;
// double click / click while a save is pending -> one request; edits locked while saving; the card then shows
// the row the server returned; a failed save stays "Not saved"; unsaved-changes tracker; dishes not in the
// catalog -> "Add to catalog" (free trial: "can't add new dishes"); bulk text line errors + clean-up summary.
// Plus the 0192 migration / APPLY / MANIFEST / run-all wiring and the store + error-message hooks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const r = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const M = require("../public/menu-pkg-editor.js");
let passed = 0; const tests = []; const t = (name, fn) => tests.push([name, fn]);

// =============================================================== pure: price
t("price edge cases", () => {
  const A = { active: true, base: 650 }, I = { active: false, base: 650 }, I0 = { active: false, base: 0 };
  for (const raw of ["", "   ", "\t", null, undefined]) assert.match(M.checkPrice(raw, A).error, /^Enter a price per plate\./, JSON.stringify(raw));
  assert.equal(M.checkPrice("", { active: true, base: null }).error, "Enter a price per plate.");
  assert.match(M.checkPrice("", A).error, /last saved price was 650/);
  assert.match(M.checkPrice("", I).error, /^Enter a price per plate\. A price can't be left empty/, "inactive: an existing price is never cleared");
  assert.deepEqual(M.checkPrice("", I0), { ok: true, keep: true, value: 0 }, "inactive with no price yet: nothing to clear, nothing sent");
  assert.match(M.checkPrice("0", A).error, /active package needs a price per plate above 0/);
  assert.match(M.checkPrice("0.00", A).error, /above 0/);
  assert.match(M.checkPrice("0", I).error, /can't be set to 0/, "inactive: never zeroed");
  assert.equal(M.checkPrice("0", I0).keep, true);
  assert.match(M.checkPrice("-5", A).error, /can't be negative/);
  assert.match(M.checkPrice("-0.01", I0).error, /negative/);
  for (const raw of ["abc", "12abc", "1e3", "0x10", "Infinity", "NaN", "1.2.3", "--5", "6 5 0x"]) assert.match(M.checkPrice(raw, A).error, /as a number/, raw);
  assert.match(M.checkPrice("", { active: true, base: 650, badInput: true }).error, /as a number/, "browser could not read the box");
  assert.match(M.checkPrice("100000.01", A).error, /at most 1,00,000/);
  assert.match(M.checkPrice("250000", A).error, /1,00,000/);
  assert.match(M.checkPrice("650.555", A).error, /2 decimal places/);
  assert.equal(M.checkPrice("650.500", A).value, 650.5, "trailing zeros are not extra decimals");
  assert.deepEqual(M.checkPrice("100000", A), { ok: true, keep: false, value: 100000 });
  assert.deepEqual(M.checkPrice(" 1,200 ", A), { ok: true, keep: false, value: 1200 }, "commas / spaces tolerated");
  assert.deepEqual(M.checkPrice("₹750", A), { ok: true, keep: false, value: 750 });
  assert.deepEqual(M.checkPrice(".5", A), { ok: true, keep: false, value: 0.5 });
  assert.equal(M.checkPrice("650", A).keep, true, "unchanged price is not sent again");
  assert.equal(M.checkPrice(650, A).keep, true, "numbers work too");
});

// =============================================================== pure: dish list
t("dish list checks", () => {
  assert.match(M.checkDishes([], { active: true }).error, /^Add at least one dish/);
  assert.ok(M.checkDishes([], { active: false }).ok, "an inactive package may be empty");
  assert.ok(M.checkDishes([{ c: "S", n: "x", k: "veg" }], { active: true }).ok);
  assert.match(M.checkDishes(Array.from({ length: 501 }, (_, i) => ({ c: "S", n: "D" + i, k: "veg" })), { active: true }).error, /at most 500/);
  const cat = [{ category: "Starters", name: "Paneer tikka", kind: "veg" }];
  assert.deepEqual(M.notInCatalog([{ c: "Starters", n: "paneer TIKKA", k: "veg" }, { c: "Mains", n: "Biryani", k: "nonveg" }], cat).map((d) => d.n), ["Biryani"]);
});

// =============================================================== pure: bulk text
t("bulk text: line errors, clean-up, summary", () => {
  const rep = M.parseTextReport([
    "Starters | Paneer tikka | veg",                     // 1 ok
    "",                                                  // 2 blank
    "   ",                                               // 3 blank
    "starters |  paneer   TIKKA | veg",                  // 4 duplicate (case / spaces)
    "Starters | | veg",                                  // 5 missing name
    "| Dal | veg",                                       // 6 missing category
    "Mains | Biryani | chicken",                         // 7 unknown kind
    "Mains | Dal | veg | extra",                         // 8 extra pipe
    "Mains | Rice |",                                    // 9 missing type
    "Mains | " + "x".repeat(121) + " | veg",             // 10 too long
    "Desserts | Kulfi \u{1F366} | special",              // 11 emoji removed
    "Desserts | \u{1F366}\u{1F366} | veg",               // 12 emoji only
    "Breads | Naan | Non-Veg",                           // 13 ok (alias)
    "Plain dish",                                        // 14 ok -> Other
    "X".repeat(81) + " | Tea | veg",                     // 15 category too long
  ].join("\r\n"));
  assert.deepEqual(rep.errors.map((e) => e.line), [5, 6, 7, 8, 9, 10, 12, 15]);
  assert.match(rep.errors[0].error, /dish name is missing/); assert.match(rep.errors[1].error, /category is missing/);
  assert.match(rep.errors[2].error, /Unknown type “chicken”/); assert.match(rep.errors[3].error, /Too many \| separators/);
  assert.match(rep.errors[4].error, /type is missing/); assert.match(rep.errors[5].error, /too long \(121 characters, at most 120\)/);
  assert.match(rep.errors[6].error, /has only emoji/); assert.match(rep.errors[7].error, /category is too long/);
  assert.deepEqual(rep.dishes, [{ c: "Starters", n: "Paneer tikka", k: "veg" }, { c: "Desserts", n: "Kulfi", k: "special" },
    { c: "Breads", n: "Naan", k: "nonveg" }, { c: "Other", n: "Plain dish", k: "veg" }]);
  assert.equal(rep.blank, 2); assert.deepEqual(rep.dupes, [4]); assert.deepEqual(rep.emoji, [11, 12]);
  const ok = M.parseTextReport("A | x | veg\n\nA | x | veg\nB | y \u{1F600} | nonveg\n");
  assert.equal(ok.errors.length, 0);
  assert.equal(M.reportSummary(ok), "2 dishes ready. Skipped 2 blank lines. Removed 1 repeated dish (line 3). Removed emoji from line 4.");
  assert.equal(M.strictKind("Vegetarian"), "veg"); assert.equal(M.strictKind("NV"), "nonveg"); assert.equal(M.strictKind("vegan"), null);
  assert.equal(M.parseTextReport(Array.from({ length: 501 }, (_, i) => "S | D" + i + " | veg").join("\n")).errors.at(-1).line, 0, "over 500 dishes");
  assert.deepEqual(M.parseText("Paneer 65\nBad | | veg\nSoups | Tomato soup"), [{ c: "Other", n: "Paneer 65", k: "veg" }, { c: "Soups", n: "Tomato soup", k: "veg" }]);
});

// =============================================================== fake DOM
class CL { constructor(e) { this.e = e; } _l() { return this.e.className.split(/\s+/).filter(Boolean); }
  add(c) { const l = this._l(); if (!l.includes(c)) { l.push(c); this.e.className = l.join(" "); } }
  remove(c) { this.e.className = this._l().filter((x) => x !== c).join(" "); }
  contains(c) { return this._l().includes(c); }
  toggle(c, on) { if (on === undefined) on = !this.contains(c); if (on) this.add(c); else this.remove(c); return on; } }
class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.ls = {}; this.value = ""; this._t = "";
    this.hidden = false; this.disabled = false; this.className = ""; this.classList = new CL(this); this.validity = { badInput: false }; this.open = false; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; } removeAttribute(k) { delete this.attrs[k]; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  set textContent(v) { this._t = String(v); this.children = []; } get textContent() { return this._t + this.children.map((c) => c.textContent).join(""); }
  addEventListener(tp, f) { (this.ls[tp] = this.ls[tp] || []).push(f); }
  fire(tp, ex) { const e = Object.assign({ type: tp, target: this, preventDefault() {}, key: "" }, ex || {}); (this.ls[tp] || []).forEach((f) => f(e)); }
  click() { if (!this.disabled) this.fire("click"); }
  focus() { focused = this; }
  all() { const out = []; const w = (n) => n.children.forEach((c) => { if (c instanceof El) { out.push(c); w(c); } }); w(this); return out; }
  querySelectorAll(q) { const tags = q.split(",").map((x) => x.trim().toUpperCase()); return this.all().filter((e) => tags.includes(e.tagName)); }
  querySelector(q) { const m = /^\.([\w-]+)(?:\[data-i="(\d+)"\])?$/.exec(q); return this.all().find((e) => e.classList.contains(m[1]) && (m[2] == null || e.attrs["data-i"] === m[2])) || null; }
}
let focused = null;
const document = { createElement: (tg) => new El(tg), createTextNode: (s) => ({ textContent: s, children: [] }) };
function load(bpui) {
  const cx = { document, console, Promise, window: null, BPUI: bpui };
  cx.window = cx; cx.globalThis = cx;
  vm.createContext(cx);
  vm.runInContext(r("public/menu-pkg-editor.js"), cx);
  return cx;
}
const byCls = (root, c) => root.all().filter((e) => e.classList.contains(c));
const one = (root, c) => byCls(root, c)[0];
const btnText = (root, txt) => root.all().find((e) => e.tagName === "BUTTON" && e._t === txt);
const tick = () => new Promise((res) => setImmediate(res));
function trackerFake() { const tr = { dirty: false, disposed: 0, mark() { tr.dirty = true; }, clean() { tr.dirty = false; }, isDirty: () => tr.dirty, dispose() { tr.disposed++; tr.dirty = false; } }; return tr; }
const DISHES = [{ c: "Starters", n: "Paneer tikka", k: "veg" }, { c: "Desserts", n: "Gulab jamun", k: "veg" }];
const CATALOG = [{ category: "Starters", name: "Paneer tikka", kind: "veg" }, { category: "Desserts", name: "Gulab jamun", kind: "veg" },
  { category: "Mains", name: "Dal makhani", kind: "veg" }];
function mount(o = {}) {
  const tr = trackerFake(); const guards = [];
  const bpui = o.noBPUI ? undefined : { trackDirty: () => tr,
    guard: (el, fn) => { if (el.disabled || el.getAttribute("aria-busy") === "true") return Promise.resolve(); el.disabled = true; el.setAttribute("aria-busy", "true"); guards.push(el);
      return Promise.resolve(fn()).finally(() => { el.disabled = false; el.removeAttribute("aria-busy"); }); } };
  const cx = load(bpui);
  const calls = [], errors = [], added = [];
  let pending = null;
  const pkg = Object.assign({ id: "p1", name: "Standard — Vegetarian", price_per_plate: 650, dishes: DISHES.slice(), active: true }, o.pkg || {});
  const host = new El("div");
  const ui = cx.HelmMenuPkg.render(host, { packages: [pkg], catalog: o.catalog || CATALOG, trial: () => !!o.trial,
    error: (m) => errors.push(m),
    save: (p, patch) => { calls.push(JSON.parse(JSON.stringify(patch))); if (o.hold) return new Promise((res) => { pending = res; }); return Promise.resolve(o.saveResult ? o.saveResult(patch) : true); },
    addToCatalog: (list) => { added.push(list); return Promise.resolve(true); } });
  const box = one(host, "mpk");
  return { cx, host, ui, box, tr, calls, errors, added, pkg, guards, resolve: (v) => pending(v),
    price: one(box, "mpk-price"), act: one(box, "tpl_active"), save: one(box, "tpl_save"), perr: one(box, "mpk-perr"), derr: one(box, "mpk-derr"),
    state: one(box, "mpk-state"), setPrice(v, bad) { this.price.value = v; this.price.validity.badInput = !!bad; this.price.fire("input"); } };
}

// ---- the owner's bug: cleared price + Save -> blocked, inline, nothing sent -------------------------
t("cleared price is refused inline, never saved", () => {
  const m = mount();
  assert.equal(m.price.value, "650");
  m.setPrice("");
  assert.equal(m.state._t, "Unsaved changes"); assert.equal(m.tr.dirty, true, "leave-page warning armed");
  m.save.click();
  assert.equal(m.calls.length, 0, "nothing sent");
  assert.equal(m.perr.hidden, false); assert.match(m.perr._t, /^Enter a price per plate\./);
  assert.equal(m.price.getAttribute("aria-invalid"), "true"); assert.equal(m.price.getAttribute("aria-describedby"), m.perr.attrs.id || m.perr.id);
  assert.match(m.errors[0], /Enter a price per plate.*\(Standard — Vegetarian\)/);
  assert.equal(focused, m.price, "focus goes to the price");
  m.setPrice("700");
  assert.equal(m.perr.hidden, true, "typing clears the message"); assert.equal(m.price.getAttribute("aria-invalid"), null);
});
t("every bad price is blocked before any request", () => {
  for (const [v, bad, re] of [["   ", false, /Enter a price per plate/], ["0", false, /above 0/], ["-5", false, /negative/], ["", true, /as a number/],
    ["100001", false, /1,00,000/], ["650.555", false, /2 decimal/]]) {
    const m = mount(); m.setPrice(v, bad); m.save.click();
    assert.equal(m.calls.length, 0, v); assert.match(m.perr._t, re, v);
  }
});
t("active package with no dishes is blocked; inactive may be empty", () => {
  let m = mount({ pkg: { dishes: [] } });
  m.save.click();
  assert.equal(m.calls.length, 0); assert.equal(m.derr.hidden, false); assert.match(m.derr._t, /^Add at least one dish/);
  m = mount({ pkg: { dishes: [] } });
  m.act.checked = false; m.act.fire("change"); m.save.click();
  assert.deepEqual(m.calls, [{ active: false }], "switching off an empty package is fine; only the change is sent");
});
t("inactive package keeps its last price, never cleared", () => {
  let m = mount({ pkg: { active: false } });
  m.setPrice(""); m.save.click();
  assert.equal(m.calls.length, 0); assert.match(m.perr._t, /can't be left empty\. The last saved price was 650/);
  m = mount({ pkg: { active: false } }); m.setPrice("0"); m.save.click();
  assert.equal(m.calls.length, 0); assert.match(m.perr._t, /can't be set to 0/);
  m = mount({ pkg: { active: false, price_per_plate: 0 } }); m.setPrice(""); m.save.click();
  assert.equal(m.calls.length, 0, "nothing changed, nothing sent"); assert.equal(m.price.value, "0", "box shows the stored value again");
});
t("switching a 0-price package on needs a price", () => {
  const m = mount({ pkg: { active: false, price_per_plate: 0 } });
  m.act.checked = true; m.act.fire("change"); m.save.click();
  assert.equal(m.calls.length, 0); assert.match(m.perr._t, /active package needs a price per plate above 0/);
});

// ---- double click / pending save / reload shows what was saved -----------------------------------
t("double click and click-while-pending send ONE request; edits are locked while saving", async () => {
  const m = mount({ hold: true });
  m.setPrice("725.5");
  m.save.click(); m.save.click(); m.save.fire("click");             // fire bypasses the disabled button too
  assert.equal(m.calls.length, 1); assert.deepEqual(m.calls[0], { price_per_plate: 725.5 }, "only the changed field");
  assert.equal(m.state._t, "Saving…"); assert.ok(m.box.classList.contains("mpk-saving")); assert.equal(m.ui.saving(), true);
  assert.equal(m.price.disabled, true, "price locked while saving");
  const x = one(m.box, "mpk-x"); x.disabled = false; x.fire("click");
  assert.equal(byCls(m.box, "mpk-chip").length, 2, "a chip cannot be removed mid-save");
  // the server returns the stored row: numeric as a string, its own dish list
  m.resolve({ id: "p1", name: m.pkg.name, price_per_plate: "725.50", dishes: [{ c: "Starters", n: "Paneer tikka", k: "veg" }], active: true });
  await tick(); await tick();
  assert.equal(m.price.value, "725.5"); assert.equal(m.price.disabled, false);
  assert.equal(byCls(m.box, "mpk-chip").length, 1, "card shows exactly the stored row (as a reload would)");
  assert.equal(m.state._t, ""); assert.equal(m.tr.dirty, false, "clean after save"); assert.equal(m.ui.dirty(), false);
  m.save.click(); assert.equal(m.calls.length, 1, "no changes -> nothing sent");
});
t("no BPUI: the fallback still prevents a second request", async () => {
  const m = mount({ hold: true, noBPUI: true });
  m.setPrice("800"); m.save.click(); m.save.fire("click");
  assert.equal(m.calls.length, 1);
  m.resolve(true); await tick(); await tick();
  assert.equal(m.price.value, "800"); assert.equal(m.save.disabled, false);
});
t("failed save stays unsaved and says so", async () => {
  const m = mount({ saveResult: () => false });
  m.setPrice("900"); m.save.click(); await tick(); await tick();
  assert.equal(m.calls.length, 1); assert.equal(m.state._t, "Not saved"); assert.ok(m.state.classList.contains("bad"));
  assert.equal(m.price.value, "900", "the typed value is kept"); assert.equal(m.tr.dirty, true, "leave-page warning still on");
});
t("paid save sends dishes + active only when they changed; trial never sends active, dishes only when changed", async () => {
  let m = mount();
  const x = one(m.box, "mpk-x"); x.click();
  m.save.click(); await tick();
  assert.deepEqual(m.calls[0], { dishes: [{ c: "Desserts", n: "Gulab jamun", k: "veg" }] });
  m = mount({ trial: true, pkg: { dishes: [] } });
  // L8 (live QA): the server refuses dish changes in the trial -> no add-dish row there, the switch stays fixed
  assert.equal(one(m.box, "mpk-add"), undefined, "no add-dish row in the trial"); assert.equal(m.act.disabled, true);
  m.setPrice("999"); m.save.click(); await tick();
  assert.deepEqual(m.calls[0], { price_per_plate: 999 }, "trial: price only, an untouched empty legacy list is not blocked");
  m = mount({ trial: true }); m.setPrice(""); m.save.click();
  assert.equal(m.calls.length, 0, "trial: a cleared price is refused too");
});
t("re-render disposes the old leave-page tracker", () => {
  const tr = trackerFake(); let made = 0;
  const cx = load({ trackDirty: () => { made++; return tr; }, guard: (el, fn) => Promise.resolve(fn()) });
  const host = new El("div");
  cx.HelmMenuPkg.render(host, { packages: [{ id: 1, name: "A", price_per_plate: 1, dishes: DISHES, active: true }] });
  cx.HelmMenuPkg.render(host, { packages: [{ id: 1, name: "A", price_per_plate: 1, dishes: DISHES, active: true }] });
  assert.equal(made, 2); assert.equal(tr.disposed, 1);
});

// ---- dishes not in the catalog ---------------------------------------------------------------------
t("a dish not in the catalog: offer to add it (free trial: refused)", async () => {
  const m = mount();
  const sel = one(m.box, "mpk-cat-sel"), dish = one(m.box, "mpk-dish-in");
  sel.value = "Mains"; dish.value = "Hyderabadi biryani \u{1F35B}"; dish.fire("input");
  btnText(m.box, "+ Add dish").click();
  assert.equal(byCls(m.box, "mpk-chip").length, 3);
  assert.ok(byCls(m.box, "mpk-chip").some((c) => c.textContent.startsWith("Hyderabadi biryani") && !/\u{1F35B}/u.test(c.textContent)), "emoji stripped");
  const note = one(m.box, "mpk-catnote");
  assert.equal(note.hidden, false); assert.match(note.textContent, /1 dish not in your Dishes catalog: Hyderabadi biryani/);
  btnText(note, "Add it to the catalog").click(); await tick(); await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(m.added[0])), [{ c: "Mains", n: "Hyderabadi biryani", k: "veg" }]);
  dish.value = "\u{1F35B}"; btnText(m.box, "+ Add dish").click();
  assert.match(one(m.box, "mpk-addmsg")._t, /letters or numbers/, "emoji-only name refused");
  dish.value = "paneer TIKKA"; sel.value = "Starters"; btnText(m.box, "+ Add dish").click();
  assert.match(one(m.box, "mpk-addmsg")._t, /already in this package/, "duplicate refused");
  const tm = mount({ trial: true, pkg: { dishes: [{ c: "Mains", n: "Not in catalog", k: "veg" }] } });
  assert.match(one(tm.box, "mpk-catnote").textContent, /Dishes are fixed in the free trial\./);
  assert.equal(btnText(one(tm.box, "mpk-catnote"), "Add it to the catalog"), undefined);
});

// ---- L8: free trial = price only (the server 403s every dish change) -----------------------------------
t("free trial: dishes are read-only (no x, reorder, add row or bulk text); Save sends the price only", async () => {
  const m = mount({ trial: true, pkg: { dishes: [{ c: "Starters", n: "Paneer tikka", k: "veg" }, { c: "Drinks", n: "Lemon mint cooler", k: "veg" }] } });
  assert.equal(byCls(m.box, "mpk-chip").length, 2, "the dishes are listed");
  assert.equal(byCls(m.box, "mpk-x").length, 0, "no remove (x)");
  assert.equal(byCls(m.box, "mpk-mv").length, 0, "no category up / down");
  assert.equal(byCls(m.box, "mpk-chip").filter((c) => c.draggable).length, 0, "not draggable");
  assert.ok(byCls(m.box, "mpk-chip").every((c) => c.classList.contains("mpk-chip-ro")));
  assert.equal(one(m.box, "mpk-add"), undefined, "no add-dish row"); assert.equal(one(m.box, "mpk-ta"), undefined, "no bulk text");
  const chip = byCls(m.box, "mpk-chip")[1]; chip.fire("keydown", { key: "Delete" }); chip.fire("keydown", { key: "ArrowLeft", altKey: true });
  assert.equal(byCls(m.box, "mpk-chip").length, 2, "Delete / Alt+arrow do nothing");
  assert.equal(m.state._t, "", "nothing changed");
  assert.equal(one(m.host, "mpk-trialnote")._t, "Free trial: you can change the price per plate. Dishes are fixed.");
  assert.equal(one(m.box, "mpk-trial")._t, "Free trial: you can change the price per plate. Dishes are fixed.");
  m.setPrice("725"); m.save.click(); await tick();
  assert.deepEqual(m.calls, [{ price_per_plate: 725 }], "price only - never dishes / active");
  // paid studio: the same card keeps the dish tools
  const p = mount({ pkg: { dishes: [{ c: "Starters", n: "Paneer tikka", k: "veg" }, { c: "Drinks", n: "Lemon mint cooler", k: "veg" }] } });
  assert.equal(byCls(p.box, "mpk-x").length, 2); assert.equal(byCls(p.box, "mpk-mv").length, 4); assert.notEqual(one(p.box, "mpk-add"), undefined);
});

// ---- bulk text in the card ---------------------------------------------------------------------------
t("bulk text: errors block Apply with line numbers; clean text applies with a summary", () => {
  const m = mount();
  const ta = one(m.box, "mpk-ta"), apply = btnText(m.box, "Apply text"), terr = one(m.box, "mpk-terr");
  ta.value = "Starters | Paneer tikka | veg\nMains | Biryani | chicken\nA|B|veg|x";
  apply.click();
  assert.equal(byCls(m.box, "mpk-chip").length, 2, "nothing applied");
  assert.ok(terr.classList.contains("bad")); assert.match(terr.textContent, /Nothing applied yet\. Fix 2 lines:/);
  assert.match(terr.textContent, /Line 2: Unknown type/); assert.match(terr.textContent, /Line 3: Too many \| separators/);
  assert.equal(ta.getAttribute("aria-invalid"), "true");
  ta.value = "Starters | Paneer tikka | veg\n\nstarters | paneer tikka | veg\nMains | Dal makhani | veg";
  apply.click();
  assert.equal(byCls(m.box, "mpk-chip").length, 2); assert.match(terr.textContent, /2 dishes ready\. Skipped 1 blank line\. Removed 1 repeated dish \(line 3\)\./);
  assert.equal(m.state._t, "Unsaved changes");
  ta.value = ""; apply.click(); m.save.click();
  assert.equal(m.calls.length, 0, "emptied by text -> Save blocked"); assert.match(m.derr._t, /Add at least one dish/);
});

// =============================================================== static wiring
t("editor source: ASCII, no HTML sinks, validation before save", () => {
  const src = r("public/menu-pkg-editor.js");
  assert.ok(/^[\x00-\x7F]*$/.test(src)); assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(src));
  assert.match(src, /if \(st\.saving\) return;\s+\/\/ a second click while the first save runs/);
  assert.match(src, /if \(!v\.pr\.ok \|\| !v\.dr\.ok\) \{/);
  assert.match(src, /price\.step = "0\.01";/);
});
t("control center + store: stored row back, catalog add, friendly 0192 message", () => {
  const cc = r("public/control.html");
  assert.match(cc, /const row=await BPStore\.menuTemplates\.update\(t\.id, patch\);[^\n]*return row\|\|true;/);
  assert.match(cc, /addToCatalog:async\(list\)=>\{ if\(mpkTrial\(\)\)\{ setMsg\("err","You can't add new dishes in the free trial\."\); return false; \}/);
  assert.match(cc, /BPStore\.dishCatalog\.add\(d\.c, d\.n, d\.k\)/);
  const st = r("public/store-api.js");
  assert.match(st, /supa\.from\("menu_templates"\)\.update\(patch\)\.eq\("id", id\)\.select\("\*"\)/);
  assert.match(st, /if \(!data \|\| !data\.length\) throw new Error\("This package was not saved\./, "0 rows updated is never reported as saved");
  assert.match(st, /e\.hint === "menu_pkg_invalid" && e\.message\) return pre \+ endDot/);
});
t("0192 migration, APPLY, MANIFEST, DB suite", () => {
  const mig = r("supabase/migrations/0192_menu_package_validation.sql"), ap = r("supabase/APPLY-0192.sql");
  for (const s of [mig, ap]) assert.ok(/^[\x00-\x7F]*$/.test(s), "ASCII only");
  assert.ok(!/\b(drop\s+table|truncate|delete\s+from|update\s+public\.)/i.test(mig.replace(/--[^\n]*/g, "")), "additive: no data statements");
  assert.match(mig, /create or replace function public\.tg_menu_pkg_validate_0192\(\)/);
  assert.match(mig, /if current_user not in \('anon', 'authenticated'\) then return new; end if;/, "Helm functions (0167 clone) + owner SQL exempt");
  assert.match(mig, /tgname = 'zzzzz_menu_pkg_validate_0192'/); assert.match(mig, /before insert or update on public\.menu_templates/);
  assert.ok("zzzz_tl173_no_add" < "zzzzz_menu_pkg_validate_0192", "fires after the 0173 trial refusal");
  assert.match(mig, /errcode = '23514', hint = 'menu_pkg_invalid'/);
  assert.ok(ap.includes(mig.trim().split("\n").slice(-12).join("\n").trim()), "APPLY embeds the migration");
  assert.match(ap, /^begin;$/m); assert.match(ap, /^commit;$/m); assert.match(ap, /-- VERIFY/);
  assert.match(r("supabase/migrations/MANIFEST"), /\nforward\s+supabase\/migrations\/0192_menu_package_validation\.sql\n/);
  assert.match(r("scripts/db-test/run-all.sh"), /run "menu-pkg-0192"\s+"MENU-PKG-0192: ALL PASS \\\(41\/41\\\)" psql -q -f tests\/db\/menu-pkg-0192\.sql/);
  const db = r("tests/db/menu-pkg-0192.sql");
  assert.match(db, /0167 clone copies every package/); assert.match(db, /new package still refused by 0173 first/);
});

for (const [name, fn] of tests) { try { await fn(); passed++; } catch (e) { console.error("FAIL " + name); throw e; } }
console.log("menu-pkg-validation: ok (" + passed + " groups)");
