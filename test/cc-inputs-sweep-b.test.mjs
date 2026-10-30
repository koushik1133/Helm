// Settings input sweep B: Menus & catalog (dish add / filter), Layout rules, Reminders & client
// messages, Layout templates (rename) and Venues list filters. Pure rules + static wiring checks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const F = require("../public/cc-field-rules.js");
let n = 0; const t = (name, fn) => { fn(); n++; console.log("  ok " + name); };

t("text: trims, collapses spaces, strips control chars", () => {
  assert.deepEqual(F.text("  Paneer \t  tikka\n ", { label: "Dish name", required: true }), { ok: true, value: "Paneer tikka" });
  assert.equal(F.text("   ", { label: "Dish name", required: true }).error, "Enter dish name.");
  assert.deepEqual(F.text("", { label: "x" }), { ok: true, value: "" });
});
t("text: < >, emoji, too short / too long, needs a letter", () => {
  assert.match(F.text("<b>x</b>", { label: "Dish name" }).error, /can't contain < or >/);
  for (const e of ["Paneer 🌶", "❤️ Biryani", "Tikka 👨‍🍳", "🇮🇳 Thali"]) assert.match(F.text(e, { label: "Dish name", noEmoji: true }).error, /Emoji/, e);
  assert.match(F.text("a", { label: "Dish name", min: 2 }).error, /at least 2/);
  assert.match(F.text("x".repeat(81), { label: "Dish name", max: 80 }).error, /80 characters or fewer \(now 81\)/);
  assert.match(F.text("123", { label: "Dish name", needLetter: true }).error, /at least one letter/);
  assert.equal(F.text("पनीर टिक्का", { label: "Dish name", noEmoji: true, needLetter: true, max: 80 }).ok, true, "other scripts are letters");
  assert.equal(F.text("Mac & cheese (kids) - 2/pc", { label: "Dish name", noEmoji: true, needLetter: true }).ok, true);
});
t("number: empty / negative / letters / e-notation / decimals / leading zeros / range", () => {
  const o = { label: "Bars", required: true, integer: true, min: 0, max: 20 };
  assert.match(F.number("", o).error, /Enter a whole number from 0 to 20 for bars/);
  assert.match(F.number("  ", o).error, /Enter a whole number/);
  assert.match(F.number("-1", o).error, /can't be negative/);
  assert.match(F.number("abc", o).error, /Enter a whole number/);
  assert.match(F.number("1e3", o).error, /Enter a whole number/);
  assert.match(F.number("2.5", o).error, /whole number \(no decimals\)/);
  assert.deepEqual(F.number("2.0", o), { ok: true, value: 2 });
  assert.deepEqual(F.number("007", o), { ok: true, value: 7 });
  assert.match(F.number("21", o).error, /from 0 to 20/);
  assert.deepEqual(F.number("0", o), { ok: true, value: 0 });
  assert.match(F.number("1.234", { label: "Seats per guest", dp: 2 }).error, /up to 2 decimal places/);
  assert.equal(F.number("1.230", { label: "Seats per guest", dp: 2 }).ok, true, "trailing zeros are not extra places");
  assert.deepEqual(F.number("", { label: "x" }), { ok: true, value: null });
});
t("dish add: required, kind, duplicate in the same category (case + spaces ignored)", () => {
  const have = [{ category: "Starters (veg)", name: "Paneer  Tikka", kind: "veg", active: true }, { category: "Mains", name: "Old", active: false }];
  let r = F.dish({ category: "", name: "", kind: "veg" }, have);
  assert.equal(r.ok, false); assert.ok(r.errors.category && r.errors.name);
  r = F.dish({ category: " starters (VEG) ", name: "paneer tikka", kind: "veg" }, have);
  assert.match(r.errors.name, /already in Starters \(veg\)/);
  assert.equal(F.dish({ category: "Mains", name: "Paneer tikka", kind: "veg" }, have).ok, true, "same dish in another category is allowed (DB rule)");
  assert.equal(F.dish({ category: "Mains", name: "Old", kind: "veg" }, have).ok, true, "a removed (inactive) dish can be added again");
  assert.match(F.dish({ category: "Mains", name: "Dal", kind: "vegan" }, have).errors.kind, /veg, non-veg or special/);
  assert.deepEqual(F.dish({ category: "  Mains ", name: " Dal   makhani ", kind: "veg" }, have).value, { category: "Mains", name: "Dal makhani", kind: "veg" });
});
t("layout rule: seats per guest > 0 and <= 10, buffet 10-500 whole, bars 0-20 whole", () => {
  assert.deepEqual(F.layoutRule({ spg: "1", buf: "75", bars: "1" }), { ok: true, errors: {}, value: { seatsPerGuest: 1, buffetPer: 75, bars: 1 } });
  const bad = F.layoutRule({ spg: "0", buf: "9", bars: "21" });
  assert.equal(bad.ok, false); assert.ok(bad.errors.spg && bad.errors.buf && bad.errors.bars, "every field reports at once");
  assert.match(F.layoutRule({ spg: "10.5", buf: "100", bars: "0" }).errors.spg, /more than 0 and up to 10/);
  assert.match(F.layoutRule({ spg: "1", buf: "100.5", bars: "0" }).errors.buf, /no decimals/);
  assert.match(F.layoutRule({ spg: "1", buf: "501", bars: "0" }).errors.buf, /from 10 to 500/);
  assert.match(F.layoutRule({ spg: "", buf: "100", bars: "0" }).errors.spg, /Enter/, "blank no longer saves a silent default");
  assert.equal(F.layoutRule({ spg: "0.75", buf: "010", bars: "00" }).value.buffetPer, 10);
});
t("message templates: only the placeholders the server fills (exact, lower case)", () => {
  const pay = ["client", "studio", "event", "label", "amount", "due", "status"];
  assert.deepEqual(F.templatePlaceholders("Hi {client}, {amount} due {due}", pay), []);
  assert.deepEqual(F.templatePlaceholders("Hi {Client}, {amout} { due } {amout}", pay), ["{Client}", "{amout}", "{ due }"]);
  assert.deepEqual(F.templatePlaceholders("Hi {client} {amount}", ["client", "studio", "event"]), ["{amount}"], "follow-ups have no amount");
});
t("list filters: every word, any order, spaces / case ignored", () => {
  assert.deepEqual(F.tokens("  Grand   HYDERABAD "), ["grand", "hyderabad"]);
  assert.equal(F.matches("Hyderabad - The Grand Lawn", F.tokens("grand hyd")), true);
  assert.equal(F.matches("Hyderabad - The Grand Lawn", F.tokens("grand pune")), false);
  assert.equal(F.tokens("x".repeat(500)).join("").length, 100);
});

t("venues: city filter dedupes spellings, stale city stops filtering, multi-word search", () => {
  const src = read("public/venues-admin.js");
  const fn = (name) => { const i = src.indexOf("function " + name + "("); let d = 0, j = src.indexOf("{", i); for (; j < src.length; j++) { if (src[j] === "{") d++; else if (src[j] === "}" && !--d) break; } return src.slice(i, j + 1); };
  const ctx = { state: { q: "", type: "", city: "", ac: "", ev: "", inactive: false, rows: [
    { name: "Grand Lawn", city: "Hyderabad", active: true }, { name: "Sky Hall", city: "  hyderabad ", active: true }, { name: "Pune Club", city: "Pune", active: true }] } };
  vm.runInNewContext(fn("ckey") + fn("filtered") + fn("cities") + ";globalThis.filtered=filtered;globalThis.cities=cities;", ctx);
  assert.equal(JSON.stringify(ctx.cities().map((c) => c[0])), JSON.stringify(["Hyderabad", "Pune"]));
  ctx.state.city = "Hyderabad"; assert.equal(ctx.filtered().length, 2, "both spellings match");
  ctx.state.city = "Mumbai"; assert.equal(ctx.filtered().length, 3, "a city no venue has any more no longer hides everything");
  assert.equal(ctx.state.city, "");
  ctx.state.q = "  lawn   GRAND "; assert.equal(JSON.stringify(ctx.filtered().map((v) => v.name)), JSON.stringify(["Grand Lawn"]));
  ctx.state.q = "   "; assert.equal(ctx.filtered().length, 3);
});

t("control.html: dish add + layout rules use inline field errors, keep values, no silent defaults", () => {
  const h = read("public/control.html");
  assert.match(h, /<script src="cc-field-rules\.js\?v=\d+"><\/script>/);
  assert.match(h, /id="dc_errs" data-cc-errs/);
  assert.match(h, /FR\.dish\(\{category:ci\.value,name:ni\.value,kind:ki\.value\}, dishCache\)/);
  assert.match(h, /BPUI\.guard\(\$\("#dc_add"\)/, "no double submit");
  assert.doesNotMatch(h, /Enter a category and dish name\./, "old top-of-page message gone");
  // R97: layout rules moved to layout-rules.js (inline errors + merge of other keys are tested in r97-layout-rules.test.mjs)
  assert.match(h, /HelmLayoutRules\.mount\(\$\("#layoutRuleList"\)/);
  assert.doesNotMatch(h, /V\.money\(raw,\{field:"Buffet table per N guests"\}\)/, "buffet per N is a whole number, not money");
  assert.doesNotMatch(h, /setMsg\("ok","Layout rule saved\."\)/, "layout rule messages stay in their own box");
  // integer inputs carry no step="1"/max=, so the global hardener never mangles "2.5" -> 25 or clamps silently
  assert.doesNotMatch(h, /id="cm_pay_before"[^>]*max=/); assert.doesNotMatch(h, /id="cm_fu_max"[^>]*step="1"/);
  assert.doesNotMatch(h, /class="lr_buf" type="number" min="1" step="1"/);
});
t("comms-settings.js: every problem inline at its field, placeholders checked, no double submit", () => {
  const js = read("public/comms-settings.js");
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(js, /templatePlaceholders\(t, PH\[p\[1\]\]\)/);
  assert.match(js, /if \(saving\) return;/);
  assert.match(js, /F\(\)\.showErrors\(/);
});
t("event-reminders.js: range checked with a message under the field", () => {
  const js = read("public/event-reminders.js");
  assert.doesNotMatch(js, /inp\.max = "30"/); assert.match(js, /integer: true, min: 1, max: 30/);
  assert.match(js, /if \(btn\.disabled\) return;/);
});
t("studio-templates.js rename: typed value kept on failure, Enter / Escape, no double submit", () => {
  const js = read("public/studio-templates.js");
  assert.match(js, /async function renameSave\(r, inp, tsel, btn\)/);
  assert.match(js, /if \(btn\.disabled\) return;/);
  assert.match(js, /state\.draft = \{ id: r\.id, name: inp\.value, event_type: tsel\.value \}/);
  assert.doesNotMatch(js, /state\.err = v\.errors\[0\]\.msg; paint\(\); return;/, "old: error repaint threw away what was typed");
});
t("number hardener: a pasted decimal in a whole-number field keeps the whole part", () => {
  const api = read("public/store-api.js");
  assert.match(api, /if \(integer\) \{ var ip = cleaned\.indexOf\("\."\); if \(ip !== -1\) cleaned = cleaned\.slice\(0, ip\); \}/);
  assert.doesNotMatch(api, /if \(integer\) cleaned = cleaned\.replace\(\/\\\.\/g, ""\);/);
});
t("text: (c) (R) TM are plain text, not emoji (emoji selector still rejected)", () => {
  for (const ok of ["Coca-Cola®", "Paneer™ bites", "Pepsi©"]) assert.equal(F.text(ok, { label: "Dish name", noEmoji: true, needLetter: true }).ok, true, ok);
  for (const bad of ["Cola®️", "Tea‍x", "Dal ‼"]) assert.match(F.text(bad, { label: "Dish name", noEmoji: true }).error, /Emoji/, bad);
});
t("fieldError: a second error whose anchor is the previous message (rename row) does not throw", () => {
  // minimal DOM: enough for fieldError's insert / remove / aria wiring
  class El {
    constructor(tag) { this.tagName = tag; this.children = []; this.parentNode = null; this.attrs = {}; this.textContent = "";
      const cls = new Set(); this.classList = { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) }; this._l = {}; }
    get nextSibling() { const p = this.parentNode; if (!p) return null; return p.children[p.children.indexOf(this) + 1] || null; }
    get lastChild() { return this.children[this.children.length - 1] || null; }
    set className(v) { v.split(/\s+/).forEach((c) => c && this.classList.add(c)); }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === "id") this.id = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    hasAttribute(k) { return k in this.attrs; } removeAttribute(k) { delete this.attrs[k]; }
    appendChild(c) { return this.insertBefore(c, null); }
    insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); c.parentNode = this; return c; }
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; }
    addEventListener(ev, fn) { (this._l[ev] = this._l[ev] || []).push(fn); } dispatch(ev) { (this._l[ev] || []).forEach((f) => f()); }
  }
  const ctx = { document: { createElement: (t) => new El(t) } };
  ctx.window = ctx;
  vm.runInNewContext(read("public/cc-field-rules.js"), ctx);
  const FD = ctx.HelmCCFields, row = new El("div"), inp = new El("input"), save = new El("button"), cancel = new El("button");
  [inp, save, cancel].forEach((x) => row.appendChild(x));
  FD.fieldError(inp, "Enter a template name.", row.lastChild);
  assert.equal(row.children.length, 4); assert.equal(row.lastChild.textContent, "Enter a template name.");
  // Save clicked again with the same bad name: the caller reads lastChild (= the old message) as the anchor
  assert.doesNotThrow(() => FD.fieldError(inp, "Couldn't save - try again.", row.lastChild));
  assert.equal(row.children.length, 4, "old message replaced, not duplicated"); assert.equal(row.lastChild.textContent, "Couldn't save - try again.");
  assert.equal(inp.getAttribute("aria-invalid"), "true"); assert.equal(inp.getAttribute("aria-describedby"), row.lastChild.id);
  inp.dispatch("input");
  assert.equal(row.children.length, 3, "typing clears it"); assert.equal(inp.getAttribute("aria-invalid"), null);
});
console.log(`\ncc-inputs-sweep-b: ${n} passed`);
