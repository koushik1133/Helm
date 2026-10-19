// r21 (0242): ONE studio-wide target margin for the Insights benchmarks, set in Control Center.
// Insights reads the studio value (fallback 30), the per-device value is retired (offered once to an editor),
// Control Center field with validation, store-api wiring, SQL shape (additive, guarded, self-check rows).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const INS = read('public/insights.html'), JS = read('public/insights-costs.js'), API = read('public/store-api.js'), CC = read('public/control.html');
const TMJ = read('public/target-margin-settings.js'), CSS = read('public/insights-polish.css'), SPLIT = read('public/control-split.js'), CAT = read('public/search-catalog.js');
const M = read('supabase/migrations/0242_studio_target_margin.sql'), A = read('supabase/APPLY-0242.sql'), MAN = read('supabase/migrations/MANIFEST');
let n = 0, fail = 0; const pending = [];
const t = (name, fn) => { pending.push((async () => { try { await fn(); n++; console.log('ok -', name); } catch (e) { fail++; console.log('FAIL -', name, e.message); } })()); };

/* ---- a tiny DOM, enough for insights-costs.js mount() ---- */
class El {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this._text = ''; this.listeners = {}; this.parentNode = null; this.hidden = false; this.style = {}; this.className = '';
    const self = this; this.classList = { add(c) { self.className = (self.className + ' ' + c).trim(); }, remove() {}, toggle() {}, contains(c) { return self.className.split(/\s+/).includes(c); } }; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  click() { (this.listeners.click || []).forEach((f) => f({ target: this, preventDefault() {} })); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  get clientWidth() { return 800; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 400 }; }
  scrollIntoView() {} closest() { return null; }
  get offsetWidth() { return 200; } get offsetHeight() { return 60; }
  all(pred, out = []) { this.children.forEach((c) => { if (pred(c)) out.push(c); c.all(pred, out); }); return out; }
}
const doc = { createElement: (t) => new El(t), createElementNS: (ns, t) => new El(t), createTextNode: (s) => { const e = new El('#text'); e._text = String(s); return e; }, documentElement: new El('html') };
function load(store) {
  const ls = { m: Object.assign({}, store), getItem(k) { return k in this.m ? this.m[k] : null; }, setItem(k, v) { this.m[k] = String(v); }, removeItem(k) { delete this.m[k]; } };
  const ctx = { window: {}, document: doc, localStorage: ls, console }; ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(JS, ctx);
  return { X: ctx.window.HelmInsightsCosts, ls };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
const rows = [{ id: 'E1', code: 'E1', event_type: 'Wedding', currency: 'INR', revenue: 1000, profit: 280, cost_total: 720, vendors: 720, date: '2026-10-10' }];
async function mount(store, server, save) {
  const { X, ls } = load(store), cost = new El('div'), bench = new El('div');
  const ui = X.mount(cost, bench, { money: (v) => 'Rs' + v, studioCurrency: () => 'INR', hidden: () => false, fmtDate: (d) => d, href: (id) => 'event.html?id=' + id,
    targetMargin: () => Promise.resolve(server), saveTargetMargin: save || (() => Promise.reject(new Error('no'))) });
  ui.set({ rows, from: '2026-10-01', to: '2026-10-31' });
  await tick();
  return { ui, ls, bench };
}
const btn = (root, re) => root.all((e) => e.tagName === 'BUTTON' && re.test(e.textContent))[0];

t('insights: studio value is used for everyone (28% margin vs 25 target = on target), no per-device input', async () => {
  const { ui, bench } = await mount({}, { target_margin_pct: 25, default_pct: 30, can_edit: false });
  assert.equal(ui.target(), 25);
  assert.match(bench.textContent, /Target margin25%/);
  assert.match(bench.textContent, /Set for the whole studio/);
  assert.match(bench.textContent, /An admin can change it in Control Center/);
  assert.equal(bench.all((e) => e.tagName === 'INPUT').length, 0);
  assert.match(bench.textContent, /1 on target/);
});
t('insights: nothing saved -> 30% default (28% margin = watch)', async () => {
  const { ui, bench } = await mount({}, { target_margin_pct: null, default_pct: 30, can_edit: true });
  assert.equal(ui.target(), 30); assert.match(bench.textContent, /Studio default \(30%\)/); assert.match(bench.textContent, /1 to watch/);
  assert.equal(bench.all((e) => e.tagName === 'A' && e.href === 'control.html#target-margin').length, 1);
});
t('migration: device 25%, studio none, editor -> offered once; "Save" saves 25 for the studio and removes the device value', async () => {
  let saved = null;
  const { ui, ls, bench } = await mount({ helm_ins_target_margin: '25' }, { target_margin_pct: null, default_pct: 30, can_edit: true },
    (v) => { saved = v; return Promise.resolve({ target_margin_pct: v, can_edit: true }); });
  assert.equal(ui.target(), 30);   // not applied until saved for the studio
  const b = btn(bench, /Save 25% for the whole studio/); assert.ok(b, 'offer shown');
  b.click(); await tick();
  assert.equal(saved, 25); assert.equal(ui.target(), 25); assert.equal(ls.getItem('helm_ins_target_margin'), null);
  assert.equal(btn(bench, /for the whole studio/), undefined);
});
t('migration: "Keep 30%" dismisses for good (device value removed, nothing saved)', async () => {
  let saved = null;
  const { ui, ls, bench } = await mount({ helm_ins_target_margin: '25' }, { target_margin_pct: null, default_pct: 30, can_edit: true }, (v) => { saved = v; return Promise.resolve({}); });
  btn(bench, /Keep 30%/).click(); await tick();
  assert.equal(saved, null); assert.equal(ui.target(), 30); assert.equal(ls.getItem('helm_ins_target_margin'), null);
});
t('migration: no offer for a non-editor, when the studio already has a value, or for a 30 / out-of-range device value', async () => {
  for (const [dev, server] of [['25', { target_margin_pct: null, can_edit: false }], ['25', { target_margin_pct: 35, can_edit: true }], ['30', { target_margin_pct: null, can_edit: true }], ['-20', { target_margin_pct: null, can_edit: true }]]) {
    const { ls, bench } = await mount({ helm_ins_target_margin: dev }, server);
    assert.equal(btn(bench, /for the whole studio/), undefined, dev + ' ' + JSON.stringify(server));
    assert.equal(ls.getItem('helm_ins_target_margin'), null);
  }
});
t('migration: server older than 0242 -> keep the device value (or 30), nothing removed', async () => {
  const { ui, ls, bench } = await mount({ helm_ins_target_margin: '22' }, null);
  assert.equal(ui.target(), 22); assert.equal(ls.getItem('helm_ins_target_margin'), '22'); assert.match(bench.textContent, /needs database update 0242/);
});
t('a decimal studio target reads cleanly in the why line (28 vs 27.6 -> 0.4 pts)', () => {
  const { X } = load({});
  const w = X.benchmarks([rows[0]], { target: 27.6, money: (v) => 'Rs' + v })[0].why;
  assert.match(w, /^Margin 28% - 0\.4 pts above your 27\.6% target/);
});
t('insights.html passes the studio target reader / saver; old per-device saver gone', () => {
  assert.match(INS, /targetMargin:\(\)=>BPStore\.insights\.targetMargin\(\), saveTargetMargin:\(v\)=>BPStore\.insights\.setTargetMargin\(v\)/);
  assert.doesNotMatch(JS, /localStorage\.setItem/);
  assert.doesNotMatch(JS, /Saved on this device/);
  assert.doesNotMatch(JS, /innerHTML|insertAdjacentHTML|outerHTML|setAttribute\("style"/);
  assert.match(CSS, /\.ic-tval \{/); assert.match(CSS, /\.ic-offer \{/);
});
t('store-api: get / set wiring, client-side 0..90 check, friendly 0242 message', async () => {
  assert.match(API, /rpc\("get_studio_target_margin", \{\}\)/);
  assert.match(API, /rpc\("set_studio_target_margin", \{ p_pct: Math\.round\(n \* 10\) \/ 10 \}\)/);
  assert.match(API, /n < 0 \|\| n > 90/);
  assert.match(API, /APPLY-0242\.sql/);
});
t('Control Center: card in Pricing, label + help text, validation, editors only', () => {
  assert.match(CC, /<div class="card" id="tmCard" hidden>\s*<h3>Target margin<\/h3>/);
  assert.match(CC, /<label for="tm_pct">Target margin %<\/label><input id="tm_pct" type="number" min="0" max="90"/);
  assert.match(CC, /Used by Insights benchmarks to colour events green\/amber\/red\./);
  assert.match(CC, /<script src="target-margin-settings\.js\?v=\d+"><\/script>/);
  assert.match(SPLIT, /"#target-margin":"pricing"/);
  assert.match(CAT, /\["pricing", "Target margin %"/);
  assert.match(TMJ, /i\.disabled = !canEdit/); assert.match(TMJ, /\$\("tm_actions"\)\.hidden = !canEdit/);
  assert.doesNotMatch(TMJ, /innerHTML|insertAdjacentHTML/);
  const ctx = { window: {} }; ctx.globalThis = ctx; vm.createContext(ctx); vm.runInContext(TMJ, ctx);
  const V = ctx.window.HelmTargetMarginSettings.validate;
  assert.deepEqual({ ...V('25') }, { ok: true, value: 25, error: '' });
  assert.equal(V(' 27.5% ').value, 27.5); assert.equal(V('0').ok, true); assert.equal(V('90').ok, true);
  for (const bad of ['', '91', '-1', 'abc', '1e1', '90.5', '100']) assert.equal(V(bad).ok, false, bad);
});
t('SQL 0242: additive + guarded, own studio, controls edit to write, 0..90, merge-upsert, no pricing change', () => {
  assert.match(M, /raise exception 'STOP: phase29 \/ phase57/);
  assert.match(M, /create or replace function public\.get_studio_target_margin\(\)\nreturns jsonb language plpgsql stable security definer set search_path = ''/);
  assert.match(M, /create or replace function public\.set_studio_target_margin\(p_pct numeric\)\nreturns jsonb language plpgsql volatile security definer set search_path = ''/);
  assert.match(M, /public\.has_area\('insights', 'view'\) or public\.has_area\('controls', 'view'\)/);
  assert.match(M, /not public\.has_area\('controls', 'edit'\)/);
  assert.match(M, /not \(p_pct >= 0 and p_pct <= 90\)/);
  assert.match(M, /on conflict \(org_id, key\) do update/);
  assert.match(M, /\|\| jsonb_build_object\('targetMarginPct', v\)/);
  assert.doesNotMatch(M, /^\s*(drop|delete|truncate|alter table|update)\b/im);
  assert.doesNotMatch(M.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n'), /set_pricing_config|'pricing'/);   // code only, comments may name it
  assert.match(M, /revoke all on function public\.set_studio_target_margin\(numeric\) from anon/);
  assert.match(MAN, /forward  supabase\/migrations\/0242_studio_target_margin\.sql/);
  assert.ok(A.includes(M.trim()), 'APPLY embeds the migration verbatim');
  assert.match(A, /^begin;$/m); assert.match(A, /^commit;$/m); assert.match(A, /-- VERIFY \(every row must say ok = true\)/);
  assert.ok(![...A].some((c) => c.charCodeAt(0) > 127) && ![...M].some((c) => c.charCodeAt(0) > 127), 'ASCII only');
});

await Promise.all(pending);
console.log(`\n${n} passed, ${fail} failed`);
if (fail) process.exit(1);
