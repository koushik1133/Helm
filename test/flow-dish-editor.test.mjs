// Quote flow step 5: per-course dish editor (public/flow-dish-editor.js) + its wiring in flow.html.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const E = require('../public/flow-dish-editor.js');
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// ---- pure helpers
assert.deepEqual(E.group([{ category: 'Starters', dish_name: 'A' }, { category: 'Mains', dish_name: 'B' }, { category: 'Starters', dish_name: 'C' }, { dish_name: 'D' }])
  .map(([c, r]) => [c, r.map((x) => x.dish_name)]), [['Starters', ['A', 'C']], ['Mains', ['B']], ['Other', ['D']]]);
assert.deepEqual(E.courses([{ category: 'Starters' }, { category: 'starters' }], [{ category: 'Mains' }]), ['Starters', 'Mains']);
assert.ok(E.courses([], []).length > 3, 'fallback courses');
assert.equal(E.findDish([{ id: 1, name: 'Paneer Tikka' }], '  paneer  tikka ').id, 1);
const pkg = { dishes: [{ c: 'S', n: 'A' }, { c: 'M', n: 'B' }] };
assert.equal(E.isCustom([], pkg), false, 'empty list is never custom');
assert.equal(E.isCustom([{ dish_name: 'b' }, { dish_name: 'A' }], pkg), false, 'same dishes as the package');
assert.equal(E.isCustom([{ dish_name: 'A' }], pkg), true, 'edited list');
assert.equal(E.isCustom([{ dish_name: 'A' }], null), true, 'dishes with no package');
assert.equal(E.validName('  ').ok, false); assert.equal(E.validName('<b>').ok, false); assert.equal(E.validName('x'.repeat(121)).ok, false);
assert.equal(E.validName(' Dal  makhani ').value, 'Dal makhani');

// ---- tiny fake DOM
function mkDoc() {
  const doc = {
    createElement(tag) { const e = { tagName: tag.toUpperCase(), children: [], dataset: {}, attrs: {}, listeners: {}, ownerDocument: doc, className: '', value: '',
      appendChild(c) { this.children.push(c); c.parent = this; return c; },
      set textContent(t) { this.children = []; this._t = t; }, get textContent() { return (this._t || '') + this.children.map((c) => c.textContent).join(''); },
      setAttribute(k, v) { this.attrs[k] = v; }, addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
      focus() {}, select() {} }; return e; },
    getElementById(id) { const walk = (n) => { if (n.id === id) return n; for (const c of n.children || []) { const r = walk(c); if (r) return r; } return null; }; return walk(doc.root); },
  };
  return doc;
}
const all = (n, pred, out = []) => { if (pred(n)) out.push(n); (n.children || []).forEach((c) => all(c, pred, out)); return out; };
const btn = (host, text) => all(host, (n) => n.tagName === 'BUTTON' && n.textContent.includes(text));
const click = async (b) => { for (const f of b.listeners.click || []) await f(); };

const doc = mkDoc(); const host = doc.createElement('div'); doc.root = host;
let menu = [{ id: 'm1', quote_id: 'q', dish_id: 'd1', dish_name: 'Paneer Tikka', category: 'Starters', qty: 40, seq: 1 }];
const catalog = [{ id: 'd1', name: 'Paneer Tikka', category: 'Starters' }, { id: 'd2', name: 'Biryani', category: 'Mains' }];
const calls = []; let n = 10;
const store = {
  eventMenu: {
    list: async () => menu.slice(),
    add: async (q, d) => { calls.push(['add', d]); const c = catalog.find((x) => x.id === d); const r = { id: 'm' + (++n), quote_id: q, dish_id: d, dish_name: c.name, category: c.category, qty: null }; menu.push(r); return r; },
    remove: async (id) => { calls.push(['remove', id]); menu = menu.filter((m) => m.id !== id); },
    setQty: async (id, q) => { calls.push(['qty', id, q]); menu.find((m) => m.id === id).qty = q; },
  },
  dishCatalog: { list: async () => catalog.slice(), add: async (c, name) => { calls.push(['cat', c, name]); const d = { id: 'd' + (++n), name, category: c }; catalog.push(d); return d; } },
};
const toasts = []; const ui = { toast: (m) => toasts.push(m), friendlyError: (e) => String(e && e.message || e), guard: async (_b, f) => f() };
const ed = E.mount(host, { store, ui, quoteId: 'q', editable: true });
await ed.init();
assert.match(host.textContent, /Starters/); assert.match(host.textContent, /Paneer Tikka/);
// add an existing catalog dish (course taken from the catalog)
assert.equal(await ed._add('Starters', 'biryani'), true);
assert.deepEqual(calls.at(-1), ['add', 'd2']);
assert.match(host.textContent, /Mains/);
// duplicate refused
assert.equal(await ed._add('Mains', 'Biryani'), false); assert.match(toasts.at(-1), /already on the menu/);
// a brand-new dish goes into the catalog first, under the chosen course
assert.equal(await ed._add('Desserts', 'Gulab Jamun'), true);
assert.deepEqual(calls.slice(-2).map((c) => c[0]), ['cat', 'add']); assert.equal(calls.at(-2)[1], 'Desserts');
// rename keeps the quantity and adds before removing
calls.length = 0;
assert.equal(await ed._rename(menu[0], 'Hara Bhara Kebab'), true);
assert.deepEqual(calls.map((c) => c[0]), ['cat', 'add', 'qty', 'remove']);
assert.equal(menu.find((m) => m.dish_name === 'Hara Bhara Kebab').qty, 40);
assert.ok(!menu.some((m) => m.id === 'm1'));
// a failed add during rename never removes the old dish
const keep = menu[0]; const origAdd = store.eventMenu.add; store.eventMenu.add = async () => { throw new Error('menu is locked'); };
calls.length = 0; assert.equal(await ed._rename(keep, 'Something Else'), false);
assert.ok(menu.some((m) => m.id === keep.id), 'old dish kept'); assert.ok(!calls.some((c) => c[0] === 'remove'));
assert.match(toasts.at(-1), /locked/); store.eventMenu.add = origAdd;
// remove via the button (keyboard: real <button>s)
const before = menu.length; const rm = btn(host, 'Remove')[0]; assert.ok(rm.attrs['aria-label'].startsWith('Remove ')); await click(rm);
assert.equal(menu.length, before - 1);
// add form has labelled course select + name input; Enter adds
const sel = doc.getElementById('dishAddCourse'), inp = doc.getElementById('dishAddName');
assert.ok(sel && inp); assert.ok(all(host, (x) => x.tagName === 'LABEL' && x.htmlFor === 'dishAddName').length === 1);
inp.value = 'Biryani'; if (menu.some((m) => m.dish_name === 'Biryani')) inp.value = 'Jeera Rice';
const cnt = menu.length; await inp.listeners.keydown[0]({ key: 'Enter', preventDefault() {} }); assert.equal(menu.length, cnt + 1);
// read-only mode hides controls
ed.setEditable(false); assert.equal(btn(host, 'Remove').length, 0); assert.equal(doc.getElementById('dishAddName'), null);
// custom detection against a package
assert.equal(ed.isCustom(pkg), true);

// ---- flow.html wiring
const h = read('public/flow.html'), js = read('public/flow-dish-editor.js');
assert.match(h, /<div class="dished" id="dishEditor"/);
assert.match(h, /flow-dish-editor\.js\?v=1/);
assert.match(h, /HelmDishEditor\.mount\(host,\{ store:BPStore, ui:BPUI, quoteId:id, editable:canEdit && !\(plan&&plan\.menu_locked\) \}\)/);
assert.match(h, /dishEd\.isCustom\(appliedPkg\) && !\(await BPUI\.confirm\(/, 'custom list asks via BPUI.confirm before replacing');
assert.doesNotMatch(h.slice(h.indexOf('async function applyPackage')), /[^.]confirm\("Replace/, 'no native confirm');
assert.match(h, /appliedPkg=t; if\(dishEd\) await dishEd\.reload\(\);/);
assert.doesNotMatch(h, /ta\.value=next/, 'package dishes no longer overwrite the notes box');
assert.match(h, /id="p_menu"/, 'notes textarea kept');
assert.doesNotMatch(js.replace(/\/\*[\s\S]*?\*\//, ''), /innerHTML|style=|\.style\.|onclick/, 'CSP-safe DOM building');
console.log('flow-dish-editor: ok');
