// 1018 (owner, prod, Control Center > Venues): (1) "Sound curfew time" / "Setup time window" showed with their
// restriction unticked; (2) "Enter the venue length. Enter the venue breadth." showed at the bottom near Notes;
// (3) the Metres / Feet toggle looked clipped; (4) list filters hid venues (1 of 4 shown) with no hint.
// Drives public/venues-admin.js with a tiny fake DOM (no browser needed).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// ---------- fake DOM ----------
const body = { tag: 'body', parentNode: null };
const connected = (e) => { for (let n = e; n; n = n.parentNode) if (n === body) return true; return false; };
const byId = {};
let focused = null, scrolled = null;
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.ls = {}; this.value = ''; this._t = ''; this.hidden = false; this.checked = false; this.className = ''; this.dataset = {}; this.parentNode = null;
    const self = this; this.classList = { toggle(c, on) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); self.className = [...s].join(' '); }, contains(c) { return self.className.split(/\s+/).includes(c); } }; }
  setAttribute(k, v) { v = String(v); this.attrs[k] = v; if (k === 'id') byId[v] = this; if (k === 'hidden') this.hidden = true; if (k === 'value') this.value = v; if (k === 'checked') this.checked = true;
    if (k === 'selected' && this.parentNode && this.parentNode.tag === 'select') this.parentNode.value = this.value; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  get id() { return this.attrs.id || ''; }
  appendChild(c) { c.parentNode = this; this.children.push(c);
    if (this.tag === 'select' && c.tag === 'option' && (this.children.length === 1 || 'selected' in c.attrs)) this.value = c.value; return c; }
  set textContent(v) { this._t = String(v); this.children = []; } get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); }
  addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); }
  fire(type, extra) { const out = []; const ev = Object.assign({ type, target: this, preventDefault() {} }, extra || {});
    for (let n = this; n; n = n.parentNode) (n.ls && n.ls[type] || []).forEach((f) => out.push(f(ev))); return Promise.all(out); }
  click() { if (this.tag === 'input' && this.attrs.type === 'checkbox') { this.checked = !this.checked; return this.fire('change'); } return this.fire('click'); }
  focus() { focused = this; }
  scrollIntoView(o) { scrolled = [this, o]; }
  all() { const out = []; const walk = (n) => { for (const c of n.children || []) { if (c instanceof El) { out.push(c); walk(c); } } }; walk(this); return out; }
  querySelectorAll(sel) { return qsa(this, sel); }
  querySelector(sel) { return qsa(this, sel)[0] || null; }
}
function matches(e, part) {
  const m = /^([a-z0-9]*)((?:\.[\w-]+)*)((?:\[[^\]]+\])*)(:checked)?$/i.exec(part); if (!m) throw new Error('selector: ' + part);
  if (m[1] && e.tag !== m[1]) return false;
  for (const c of m[2].split('.').filter(Boolean)) if (!e.classList.contains(c)) return false;
  for (const a of (m[3].match(/\[[^\]]+\]/g) || [])) { const [, k, v] = /^\[([\w-]+)(?:="?([^"\]]*)"?)?\]$/.exec(a); if (!(k in e.attrs)) return false; if (v !== undefined && e.attrs[k] !== v) return false; }
  if (m[4] && !e.checked) return false;
  return true;
}
function qsa(rootEl, sel) {
  const parts = sel.trim().split(/\s+/);
  return rootEl.all().filter((e) => { if (!matches(e, parts[parts.length - 1])) return false; let i = parts.length - 2, n = e.parentNode;
    while (i >= 0 && n && n !== rootEl.parentNode) { if (n instanceof El && matches(n, parts[i])) i--; n = n.parentNode; } return i < 0; });
}
const txt = (t) => ({ textContent: String(t), children: [] });
const docRoot = new El('div'); docRoot.parentNode = body;
const mk = (tag, id, parent) => { const e = new El(tag); if (id) e.setAttribute('id', id); (parent || docRoot).appendChild(e); return e; };
const tab = mk('button', 'tab-venues'); tab.className = 'tab'; tab.dataset.pane = 'venues'; tab.setAttribute('hidden', '');
const pane = mk('div', 'pane-venues'); pane.setAttribute('hidden', ''); const root = mk('div', 'vn_root', pane);
const document = { getElementById: (id) => (byId[id] && connected(byId[id]) ? byId[id] : null), createElement: (t) => new El(t), createTextNode: txt,
  querySelectorAll: (s) => docRoot.querySelectorAll(s) };

// ---------- fake store ----------
const rows = [
  { id: 'a', name: 'Taj Ballroom', venue_type: 'hotel_ballroom', ac_type: 'ac', city: 'Hyderabad', length_m: 40, width_m: 25, seated_capacity: 500, event_types: ['wedding'], restrictions: ['sound_curfew'], sound_curfew: '22:00:00', active: true },
  { id: 'b', name: 'Green Lawn', venue_type: 'lawn', ac_type: 'non_ac', city: 'Hyderabad', length_m: 80, width_m: 50, floating_capacity: 2000, event_types: ['wedding'], restrictions: [], active: true },
  { id: 'c', name: 'Royal Banquet', venue_type: 'banquet_hall', ac_type: 'ac', city: 'Hyderabad', length_m: 30, width_m: 20, seated_capacity: 300, event_types: ['wedding'], restrictions: [], active: true },
  // legacy row: a curfew time saved without the tick - the time must stay visible (never silently dropped)
  { id: 'd', name: 'Old Hall', venue_type: 'convention_centre', ac_type: 'ac', city: 'Pune', length_m: 90, width_m: 60, seated_capacity: 3000, event_types: [], restrictions: [], sound_curfew: '23:00:00', setup_window: '06:00-10:00', active: true }];
const saved = [];
const store = { auth: { user: () => ({ id: 'u' }), role: async () => 'admin', canView: async () => true, canEditArea: async () => true },
  venues: { list: async () => rows.map((r) => Object.assign({}, r)), save: async (id, v) => { saved.push([id, v]); return { id: id || 'new' }; }, setActive: async () => {}, loadSamples: async () => ({}) } };
const cx = { document, location: { hash: '#venues' }, localStorage: { getItem: () => null, setItem() {} }, setTimeout: (f) => f(), console };
cx.window = cx; cx.BPStore = store; cx.globalThis = cx;
vm.createContext(cx);
vm.runInContext(read('public/venues-core.js'), cx);
vm.runInContext(read('public/venues-admin.js'), cx);
const tick = () => new Promise((r) => setImmediate(r));
for (let i = 0; i < 5; i++) await tick();
const $ = (id) => document.getElementById(id);
const cards = () => root.querySelectorAll('.vn-card').length;
const pick = async (id, v) => { $(id).value = v; await $(id).fire('change'); };
let n = 0; const t = async (name, fn) => { await fn(); n++; };

await t('tab opens with every filter on Any and all 4 venues', async () => {
  assert.equal(tab.hidden, false); assert.equal(pane.hidden, false);
  assert.equal(cards(), 4);
  for (const id of ['vn_f_type', 'vn_f_city', 'vn_f_ac', 'vn_f_ev', 'vn_q']) assert.equal($(id).value, '', id + ' starts on Any');
  for (const id of ['vn_f_type', 'vn_f_city', 'vn_f_ac', 'vn_f_ev', 'vn_q']) assert.equal($(id).getAttribute('autocomplete'), 'off', id + ': browser autofill / restore off');
  assert.equal($('vn_count').hidden, true, 'no count line without a filter');
});
await t('filters show "Showing 1 of 4 venues · Clear filters"', async () => {
  await pick('vn_f_type', 'banquet_hall'); await pick('vn_f_city', 'Hyderabad'); await pick('vn_f_ac', 'ac'); await pick('vn_f_ev', 'wedding');
  assert.equal(cards(), 1);
  assert.equal($('vn_count').hidden, false);
  assert.equal($('vn_count').textContent, 'Showing 1 of 4 venues · Clear filters');
  await $('vn_clear').click();
  assert.equal(cards(), 4); assert.equal($('vn_f_type').value, ''); assert.equal($('vn_f_ev').value, ''); assert.equal($('vn_count').hidden, true);
});
await t('re-opening the tab resets leftover filters', async () => {
  await pick('vn_f_city', 'Pune'); assert.equal(cards(), 1);
  await tab.click(); await tick();
  assert.equal($('vn_f_city').value, ''); assert.equal(cards(), 4);
});
await t('onboarding entry (HelmVenuesAdmin.reload) also starts on Any', async () => {
  await pick('vn_f_type', 'lawn'); assert.equal(cards(), 1);
  await cx.HelmVenuesAdmin.reload(); await tick();
  assert.equal($('vn_f_type').value, ''); assert.equal(cards(), 4);
});
await t('curfew / setup inputs follow their restriction ticks; unticking clears', async () => {
  await $('vn_add').click();
  const cf = $('vf_curfew'), su = $('vf_setup');
  assert.equal(cf.parentNode.hidden, true, 'curfew time hidden while unticked');
  assert.equal(su.parentNode.hidden, true, 'setup window hidden while unticked');
  const cbCurfew = root.querySelector('input[name="vf_rs"][value="sound_curfew"]'), cbSetup = root.querySelector('input[name="vf_rs"][value="setup_window"]');
  await cbCurfew.click(); assert.equal(cf.parentNode.hidden, false); assert.equal(focused, cf, 'ticking focuses the time');
  await cbSetup.click(); assert.equal(su.parentNode.hidden, false);
  cf.value = '22:30'; su.value = '06:00-11:00';
  await cbCurfew.click(); assert.equal(cf.parentNode.hidden, true); assert.equal(cf.value, '', 'unticked -> value cleared');
  await cbSetup.click(); assert.equal(su.parentNode.hidden, true); assert.equal(su.value, '');
});
await t('length / breadth errors show under their own fields, first one scrolled to + focused', async () => {
  $('vf_name').value = 'New Hall'; $('vf_seat').value = '200';
  await root.querySelector('form').fire('submit');
  assert.equal(saved.length, 0, 'nothing saved');
  assert.equal($('vf_len_err').textContent, 'Enter the venue length.'); assert.equal($('vf_len_err').hidden, false);
  assert.equal($('vf_wid_err').textContent, 'Enter the venue breadth.');
  assert.equal($('vf_len_err').parentNode, $('vf_len').parentNode, 'message sits in the Length field box');
  assert.equal($('vf_wid_err').parentNode, $('vf_wid').parentNode, 'message sits in the Breadth field box');
  assert.equal($('vf_len').getAttribute('aria-invalid'), 'true'); assert.equal($('vf_len').getAttribute('aria-describedby'), 'vf_len_err');
  assert.equal(focused, $('vf_len')); assert.equal(scrolled[0], $('vf_len')); assert.equal(scrolled[1].block, 'center');
  assert.equal($('vf_err').textContent, 'Fix the 2 highlighted fields above.');
  assert.ok(!/Enter the venue length/.test($('vf_err').textContent), 'bottom box no longer repeats the field messages');
  $('vf_len').value = '30'; await $('vf_len').fire('input');
  assert.equal($('vf_len_err').hidden, true); assert.equal($('vf_len').getAttribute('aria-invalid'), null, 'typing clears that field');
  assert.equal($('vf_wid').getAttribute('aria-invalid'), 'true', 'other field still flagged');
});
await t('fixed form saves; unticked curfew sends nothing', async () => {
  $('vf_wid').value = '20';
  await root.querySelector('form').fire('submit'); await tick();
  assert.equal(saved.length, 1); const v = saved[0][1];
  assert.equal(v.length_m, 30); assert.equal(v.width_m, 20); assert.equal(v.sound_curfew, null); assert.equal(v.setup_window, null);
  assert.deepEqual([...v.restrictions], []);
});
await t('editing a ticked venue shows its curfew; a legacy untick-with-value row keeps its values', async () => {
  root.querySelectorAll('.vn-card').find((c) => c.attrs['data-id'] === 'a').querySelector('.btn').click();
  assert.equal($('vf_curfew').parentNode.hidden, false); assert.equal($('vf_curfew').value, '22:00'); assert.equal($('vf_setup').parentNode.hidden, true);
  root.querySelectorAll('.btn').find((b) => b.textContent === 'Cancel').click();
  root.querySelectorAll('.vn-card').find((c) => c.attrs['data-id'] === 'd').querySelector('.btn').click();
  assert.equal($('vf_curfew').parentNode.hidden, false); assert.equal($('vf_curfew').value, '23:00');
  assert.equal($('vf_setup').parentNode.hidden, false); assert.equal($('vf_setup').value, '06:00-10:00');
  await root.querySelector('form').fire('submit'); await tick();
  const v = saved[saved.length - 1][1]; assert.equal(v.sound_curfew, '23:00'); assert.equal(v.setup_window, '06:00-10:00');
});
await t('unit toggle is a segmented control the app theme cannot flatten; hidden rules beat .fld display', async () => {
  const css = read('public/venues.css');
  assert.match(css, /\.vn-unit\{[^}]*border:1px solid[^}]*border-radius:10px[^}]*width:max-content/);
  assert.match(css, /\.vn-unit:not\(#_\) \.btn\{[^}]*border:0[^}]*white-space:nowrap/);
  assert.match(css, /\.vn-unit:not\(#_\) \.btn\.on\{background:var\(--accent/);
  assert.match(css, /\.vn-form \.fld\[hidden\],\.vn-count\[hidden\],\.vn-ferr\[hidden\]\{display:none\}/);
  assert.match(css, /\.vn-ferr\{/);
  const js = read('public/venues-admin.js');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|\.style\.|style=/.test(js), 'DOM nodes only, no inline style');
});
console.log(`venues-admin-form: ${n} checks OK`);
