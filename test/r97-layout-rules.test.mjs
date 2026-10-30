// R97 Settings > Layout rules: one editor (layout-rules.js) + 6 new options wired into the generator + 0313 DB check.
//   1 core: limits match the database (0313), plain-English errors, decimals / whole numbers
//   2 core: an untouched rule saves byte-for-byte the same JSON (new keys at their built-in value are never stored);
//     other keys merged, never dropped; a changed new key is stored
//   3 core: preview sentence for a sample guest count (one buffet line, round tables only when the generator uses them)
//   4 generator defaults unchanged: builder.js applies each new key only when present, into the existing fields,
//     and the built-in values in layout-rules.js equal the generator's (spt 8, aisle 8, exits 2, head/canopy/lounge off)
//   5 DOM (vm + tiny fake DOM): steppers, dirty tracking, one Save, reset, copy, read-only, no HTML sinks
//   6 wiring: control.html, store-api create, page tour, migration + APPLY + MANIFEST + run-all
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL ' + name); throw e; } };
const src = read('public/layout-rules.js');

/* ---------- tiny fake DOM, enough for layout-rules.js ---------- */
function makeDoc() {
  class El {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.dataset = {}; this.attrs = {}; this._text = ''; this.listeners = {}; this.hidden = false; this.disabled = false; this.className = ''; this.value = ''; this.checked = false; }
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this); }
    set textContent(v) { this.children = []; this._text = String(v); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k]; } removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
    fire(ev, extra) { (this.listeners[ev] || []).forEach((f) => f(Object.assign({ preventDefault() {}, key: '' }, extra || {}))); }
    focus() {}
    all() { return this.children.flatMap((c) => [c, ...c.all()]); }
    querySelectorAll(sel) { const cls = sel.replace(/^\./, ''); return this.all().filter((e) => (' ' + e.className + ' ').includes(' ' + cls + ' ')); }
    querySelector(sel) { const m = sel.match(/^\[data-id="(.+)"\]$/); if (m) return this.all().find((e) => String(e.dataset.id) === m[1]) || null; return this.querySelectorAll(sel)[0] || null; }
  }
  return { createElement: (t) => new El(t) };
}
function load() {
  const doc = makeDoc(), win = { document: doc, addEventListener() {}, sessionStorage: { getItem() { return null; }, setItem() {} } };
  win.window = win; win.globalThis = win;
  const ctx = vm.createContext({ window: win, document: doc, sessionStorage: win.sessionStorage, Promise, Object, Array, String, Number, Math, JSON });
  vm.runInContext(src.replace('typeof window !== "undefined" ? window : globalThis', 'window'), ctx);
  return { L: win.HelmLayoutRules, doc };
}
const { L } = load(); const C = L.core;
const raw = (o) => Object.fromEntries(C.FIELDS.concat(C.TOGGLES).map((f) => [f.key, C.shown(o, f.key, 'wedding')]));

await t('1 limits match the database (0313)', () => {
  const f = (k) => C.FIELDS.find((x) => x.key === k);
  assert.equal(C.checkNumber(f('seatsPerGuest'), '0').ok, false);
  assert.equal(C.checkNumber(f('seatsPerGuest'), '0.25').value, 0.25);
  assert.equal(C.checkNumber(f('seatsPerGuest'), '10').ok, true);
  assert.match(C.checkNumber(f('seatsPerGuest'), '10.5').error, /more than 0 and up to 10/);
  assert.match(C.checkNumber(f('seatsPerGuest'), '0.333').error, /2 decimals/);
  assert.match(C.checkNumber(f('buffetPer'), '9').error, /from 10 to 500/);
  assert.match(C.checkNumber(f('bars'), '1.5').error, /whole number/);
  assert.match(C.checkNumber(f('seatsPerTable'), '21').error, /from 2 to 20/);
  assert.match(C.checkNumber(f('aisleFt'), '2').error, /from 3 to 30/);
  assert.match(C.checkNumber(f('exits'), '').error, /^Enter/);
  assert.match(C.checkNumber(f('exits'), '-1').error, /must be a number/);
  const sql = read('supabase/migrations/0313_r97_layout_rules_check.sql');
  for (const [k, lo, hi] of [['buffetPer', 10, 500], ['bars', 0, 20], ['seatsPerTable', 2, 20], ['aisleFt', 3, 30], ['exits', 0, 20]]) {
    assert.ok(sql.includes(`"${k}":[${lo},${hi},`), k + ' SQL limit'); assert.equal(f(k).min, lo); assert.equal(f(k).max, hi);
  }
  assert.match(sql, /n <= 0 or n > 10 or n \* 100 <> trunc\(n \* 100\)/);
});

await t('2 untouched rule saves the same JSON; new keys only when changed; other keys kept', () => {
  for (const [type, rules] of Object.entries(C.HELM)) {
    const b = C.build(rules, raw.call(null, rules));
    assert.equal(b.ok, true); assert.equal(JSON.stringify(b.value), JSON.stringify(rules), type + ' unchanged');
    assert.ok(C.rawSame(raw(rules), raw(rules)));
  }
  const withExtra = { ...C.HELM.wedding, custom: 'keep', seatsPerTable: 10 };
  const r = raw(withExtra); assert.equal(r.seatsPerTable, 10);
  r.seatsPerTable = '8'; r.headTable = true; r.aisleFt = '6';
  const b = C.build(withExtra, r);
  assert.equal(b.value.custom, 'keep'); assert.equal('seatsPerTable' in b.value, false, 'built-in 8 removes the key');
  assert.equal(b.value.headTable, true); assert.equal(b.value.aisleFt, 6);
  assert.equal(C.build(C.HELM.wedding, { ...raw(C.HELM.wedding), bars: '' }).ok, false);
  // "1.0" typed equals stored 1 (no false "unsaved")
  assert.ok(C.rawSame({ ...raw(C.HELM.wedding), seatsPerGuest: '1.0' }, raw(C.HELM.wedding)));
  // a missing switch shows what the builder does without it (stage on, dance floor off)
  assert.equal(C.shown({}, 'stage', 'wedding'), true); assert.equal(C.shown({}, 'dancefloor', 'wedding'), false);
});

await t('3 preview sentence', () => {
  assert.equal(C.preview(raw(C.HELM.wedding), 'wedding', 300),
    'For 300 guests: 300 seats, about 38 round tables of 8, a buffet line, 1 bar, stage, dance floor with DJ, 2 exits.');
  assert.equal(C.preview(raw(C.HELM.conference), 'conference', 60),
    'For 60 guests: 60 seats, no buffet line (under 100 guests), no bar, stage, 2 exits.');
  assert.match(C.preview({ ...raw(C.HELM.concert), seatsPerTable: 10, canopy: true, headTable: true, lounge: true, exits: 4 }, 'concert', 500),
    /200 seats, about 20 round tables of 10, a buffet line, 2 bars, ceremony canopy, dance floor with DJ, head table, lounge, 4 exits\./);
});

await t('4 generator defaults unchanged', () => {
  const b = read('public/builder.js');
  const blk = b.slice(b.indexOf('const rule = await BPStore.layoutRules.get(rawType)'), b.indexOf("toast('Applied \"'"));
  for (const [k, id, fn] of [['seatsPerTable', 'c_spt', 'setV'], ['aisleFt', 'c_aisle', 'setV'], ['exits', 'c_exits', 'setV'],
    ['headTable', 'c_head', 'setChk'], ['canopy', 'c_canopy', 'setChk'], ['lounge', 'c_lounge', 'setChk']])
    assert.ok(blk.includes(`if(rule.${k}!=null) ${fn}('${id}', rule.${k});`), k);
  // the older keys are applied exactly as before
  assert.ok(blk.includes("if(rule.buffetPer!=null && guests) setChk('c_buffet', guests>=(+rule.buffetPer));"));
  // built-in values = the generator's own fallbacks
  assert.match(b, /const spt=o\.spt\|\|8/); assert.match(b, /aisle=o\.aisle\|\|8/); assert.match(b, /const exits=o\.exits!=null\?o\.exits:2;/);
  const h = read('public/builder.html');
  assert.match(h, /id="c_head">/); assert.doesNotMatch(h, /id="c_head" checked/); assert.doesNotMatch(h, /id="c_canopy" checked/); assert.doesNotMatch(h, /id="c_lounge" checked/);
  const bi = Object.fromEntries(C.FIELDS.concat(C.TOGGLES).filter((f) => f.builtin != null).map((f) => [f.key, f.builtin]));
  assert.deepEqual(JSON.parse(JSON.stringify(bi)), { seatsPerTable: 8, aisleFt: 8, exits: 2, canopy: false, headTable: false, lounge: false });
  // spt only forces round tables when it is stored, and it is never stored at 8
  assert.match(b, /const useRounds = \(o\.spt!=null\)/);
});

await t('5 DOM: steppers, dirty, one Save, reset, copy, read-only', async () => {
  const { L: L2, doc } = load();
  const rows = [{ id: 'a', event_type: 'wedding', seq: 1, rules: { ...C.HELM.wedding } }, { id: 'b', event_type: 'concert', seq: 2, rules: { ...C.HELM.concert, x: 1 } }];
  const saved = []; const store = { update: async (id, p) => { saved.push([id, p]); }, create: async (r) => ({ id: 'c', ...r }) };
  const host = doc.createElement('div');
  const api = L2.mount(host, { rows, canEdit: true, store });
  const q = (c) => host.querySelector(c), qa = (c) => host.querySelectorAll(c);
  assert.equal(qa('lrx-tab').length, 2); assert.equal(api.dirty(), 0); assert.equal(q('.lrx-bar').hidden, true);
  assert.ok(qa('lrx-in').every((i) => i.type === 'text'), 'no native spinners');
  assert.ok(!/[A-Z]{4,}/.test(qa('lrx-lab').map((l) => l.textContent).join(' ')), 'no ALL-CAPS labels');
  const bars = qa('lrx-in').find((i) => i.dataset.key === 'bars');
  const plus = bars.parentNode.children[2]; plus.fire('click');
  assert.equal(bars.value, '2'); assert.equal(api.dirty(), 1); assert.equal(q('.lrx-bar').hidden, false);
  assert.match(q('.lrx-bar-msg').textContent, /Unsaved changes: Wedding/);
  assert.match(q('.lrx-pv-text').textContent, /2 bars/);
  const spt = qa('lrx-in').find((i) => i.dataset.key === 'seatsPerTable'); spt.value = '50'; spt.fire('input');
  assert.match(spt.parentNode.parentNode.querySelector('.lrx-err').textContent, /from 2 to 20/);
  q('.lrx-save').fire('click'); await new Promise((r) => setTimeout(r, 0));
  assert.equal(saved.length, 0, 'invalid value blocks the save'); assert.match(q('.lrx-status').textContent, /Fix the highlighted/);
  const spt2 = qa('lrx-in').find((i) => i.dataset.key === 'seatsPerTable'); spt2.value = '10'; spt2.fire('input');
  q('.lrx-save').fire('click'); await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
  assert.equal(saved.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(saved[0])), ['a', { rules: { ...C.HELM.wedding, bars: 2, seatsPerTable: 10 } }]);
  assert.equal(api.dirty(), 0); assert.match(q('.lrx-status').textContent, /Saved/);
  // reset to Helm default -> dirty again, values back
  q('.lrx-reset').fire('click');
  assert.equal(qa('lrx-in').find((i) => i.dataset.key === 'bars').value, '1'); assert.equal(api.dirty(), 1);
  // copy from concert
  const sel = q('.lrx-copy'); sel.value = 'b'; sel.fire('change');
  assert.equal(qa('lrx-in').find((i) => i.dataset.key === 'seatsPerGuest').value, '0.4');
  // read-only
  const { L: L3, doc: d3 } = load(); const h3 = d3.createElement('div');
  L3.mount(h3, { rows, canEdit: false, store });
  assert.ok(h3.querySelectorAll('lrx-in').filter((i) => i.dataset.key).every((i) => i.disabled));
  assert.equal(h3.querySelector('.lrx-save'), null); assert.equal(h3.querySelector('.lrx-reset'), null); assert.equal(h3.querySelector('.lrx-add'), null);
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|document\.write|style\s*=/);
});

await t('6 wiring', () => {
  const h = read('public/control.html');
  assert.match(h, /<script src="layout-rules\.js\?v=\d+"><\/script>/); assert.match(h, /href="layout-rules\.css\?v=\d+"/);
  assert.match(h, /HelmLayoutRules\.mount\(\$\("#layoutRuleList"\), \{ rows:rules, canEdit, store:BPStore\.layoutRules, errMsg \}\)/);
  assert.match(h, /canEdit=await BPStore\.auth\.canEditArea\("controls"\)/);
  const api = read('public/store-api.js');
  assert.match(api, /async create\(row\) \{[\s\S]{0,600}from\("layout_rules"\)\.insert\(rec\)/);
  const css = read('public/layout-rules.css');
  for (const line of css.split('\n')) if (/^[.#a-z@]/i.test(line) && !line.startsWith('@media') && !line.startsWith('}')) assert.match(line, /^\.lrx/, 'scoped: ' + line);
  const tours = read('public/page-tours.js'); assert.match(tours, /#layoutRuleList \.lrx-list/); assert.doesNotMatch(tours, /\.lr_save/);
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0313_r97_layout_rules_check\.sql/);
  const ap = read('supabase/APPLY-0313.sql'); assert.match(ap, /^-- APPLY-0313\.sql/); assert.match(ap, /begin;[\s\S]*commit;[\s\S]*VERIFY/);
  assert.match(read('supabase/migrations/0313_r97_layout_rules_check.sql'), /set search_path = ''/);
  assert.doesNotMatch(read('supabase/migrations/0313_r97_layout_rules_check.sql'), /[^\x00-\x7f]/, 'ASCII');
  assert.match(read('scripts/db-test/run-all.sh'), /R97-LAYOUT-RULES-0313: ALL PASS \\\(24\/24\\\)/);
});

console.log(`r97-layout-rules: ${n} passed`);
