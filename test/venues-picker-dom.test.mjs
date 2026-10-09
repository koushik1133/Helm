// 0085: venue picker on the flow page, with a tiny fake DOM: pick -> fills + links (client JSON
// hidden fields), warnings shown; load with a saved link -> re-selected + warnings; unlink clears.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const byId = {};
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.ls = {}; this.value = ''; this._t = ''; this.hidden = false; this.className = ''; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'id') byId[v] = this; if (k === 'hidden') this.hidden = true; if (k === 'value') this.value = v; }
  appendChild(c) { c.parentNode = this; this.children.push(c); if (this.tag === 'select' && this.value === '' && this.children.length === 1) this.value = c.value || ''; return c; }
  insertBefore(c, ref) { c.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, c); return c; }
  set textContent(v) { this._t = String(v); if (v === '') this.children = []; } get textContent() { return this._t + this.children.map((c) => c.textContent).join(''); }
  addEventListener(t, f) { (this.ls[t] = this.ls[t] || []).push(f); }
  dispatchEvent(e) { e.target = this; (this.ls[e.type] || []).forEach((f) => f(e)); }
  querySelector(q) { const find = (n) => { for (const c of n.children) { if ((q[0] === '#' && c.attrs && c.attrs.id === q.slice(1)) || (q[0] === '.' && c.className === q.slice(1))) return c; const r = find(c); if (r) return r; } return null; }; return find(this); }
  focus() {}
}
const txt = (t) => ({ textContent: t, children: [] });
const doc = { getElementById: (id) => byId[id] || null, createElement: (t) => new El(t), createTextNode: txt };
const mk = (id, tag = 'input', parent) => { const e = new El(tag); e.setAttribute('id', id); if (parent) parent.appendChild(e); return e; };
const sec = mk('sec-venue', 'section'); const grid = new El('div'); grid.className = 'grid'; sec.appendChild(grid);
['v_name', 'v_addr', 'v_contact', 'v_setting', 'v_venue_id', 'v_venue_name', 'g_len', 'g_wid', 'c_guests', 'c_type'].forEach((i) => mk(i, 'input', grid));
const venues = [{ id: 'v1', name: 'SAMPLE - Green Meadows Lawn', city: 'Hyderabad', address: 'Shamshabad Road', setting: 'outdoor', floating_capacity: 2000,
  length_m: 80, width_m: 50, event_types: ['wedding', 'concert'], restrictions: ['sound_curfew'], sound_curfew: '22:00:00' }];
// saved link already on the quote (as flow loadPlan would set it)
byId.v_venue_id.value = 'v1'; byId.v_venue_name.value = 'SAMPLE - Green Meadows Lawn'; byId.c_guests.value = '2500'; byId.c_type.value = 'Concert';
let resolveList; const listP = new Promise((r) => (resolveList = r));
const cx = { window: {}, document: doc, Event: class { constructor(t) { this.type = t; } }, setTimeout: (f) => f(), console };
cx.window = cx; cx.globalThis = cx;
cx.BPStore = { auth: { user: () => ({ id: 'u' }) }, venues: { list: () => listP } };
vm.createContext(cx);
vm.runInContext(read('public/venues-core.js'), cx);
vm.runInContext(read('public/venue-picker.js'), cx);
resolveList(venues); await listP; await new Promise((r) => setImmediate(r));
const sel = byId.vp_pick, warn = byId.vp_warn;
assert.equal(sel.value, 'v1', 'saved link re-selected on load');
assert.equal(byId.vp_linked.hidden, false); assert.match(byId.vp_linked.textContent, /Linked to saved venue: SAMPLE - Green Meadows Lawn \(change \/ unlink\)/);
assert.match(warn.textContent, /2500 guests is more than/); assert.match(warn.textContent, /Sound curfew at 22:00/);
// unlink
byId.vp_unlink.dispatchEvent({ type: 'click' });
assert.equal(byId.v_venue_id.value, ''); assert.equal(byId.v_venue_name.value, ''); assert.equal(byId.vp_linked.hidden, true); assert.equal(warn.textContent, '');
// pick again -> fills fields (feet) + links
let dirty = 0; byId.v_venue_id.addEventListener('input', () => dirty++);
sel.value = 'v1'; sel.dispatchEvent({ type: 'change' });
assert.equal(byId.v_name.value, 'SAMPLE - Green Meadows Lawn'); assert.equal(byId.v_addr.value, 'Shamshabad Road, Hyderabad');
assert.equal(byId.g_len.value, '262'); assert.equal(byId.g_wid.value, '164'); assert.equal(byId.v_setting.value, 'outdoor');
assert.equal(byId.v_venue_id.value, 'v1'); assert.equal(byId.v_venue_name.value, 'SAMPLE - Green Meadows Lawn'); assert.ok(dirty > 0, 'autosave triggered');
assert.equal(byId.vp_linked.hidden, false);
console.log('venues-picker-dom: ok');
