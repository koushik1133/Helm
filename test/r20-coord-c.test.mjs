// r20 coord (c) (live QA on /sita): resource plan without ?quote= shows "Pick an event", "Qty needed" header,
// vendors "this event" with no bookings points at the resource plan's Book a partner, the saved-view "All" chip
// resets the vendor type tab, ONE sample-name display ("X (sample)", never "(sample) (sample)") shared by the
// inventory list and the pickers, and "Pull from discovery requirements" gated on discovery view + resources edit.
// Static source checks + pure helpers run in a vm. No network, no DB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const tests = []; const t = (n, f) => tests.push([n, f]);
const STORE = read('public/store-api.js');
const RES = read('public/resources.html');
const VEN = read('public/vendors.html');
const INV = read('public/inventory.html');
const CAP = read('public/capacity-shortage.js');
const SF = read('public/saved-filters.js');

function grab(src, re) { const m = re.exec(src); assert.ok(m, 'source not found: ' + re); return m[0]; }

/* ---------------------------------------------------------------- 25: one sample-name helper */
const sampleSrc = grab(STORE, /function sampleDisplayName\(n\) \{[\s\S]*?\n  \}/);
const sampleName = vm.runInNewContext('(' + sampleSrc + ')');

t('25 sampleName: "Demo · X" -> "X (sample)"', () => {
  assert.equal(sampleName('Demo · PA Speaker'), 'PA Speaker (sample)');
  assert.equal(sampleName('  Demo · Round table'), 'Round table (sample)');
});
t('25 sampleName: a seed name already ending in "(sample)" gets the suffix once', () => {
  assert.equal(sampleName('Demo · Pandit Sharma Ji (sample)'), 'Pandit Sharma Ji (sample)');
  assert.equal(sampleName('Demo · Pandit Sharma Ji (Sample)  '), 'Pandit Sharma Ji (sample)');
  assert.doesNotMatch(sampleName('Demo · Pandit Sharma Ji (sample)'), /\(sample\)\s*\(sample\)/);
});
t('25 sampleName: own (non-sample) names and odd input unchanged', () => {
  assert.equal(sampleName('PA Speaker'), 'PA Speaker');
  assert.equal(sampleName('My item (sample)'), 'My item (sample)');
  assert.equal(sampleName(null), '');
  assert.equal(sampleName(undefined), '');
  assert.equal(sampleName('Demo · (sample)'), 'Demo · (sample)');
});
t('25 BPStore.sampleName is exported from store-api.js', () => {
  assert.match(STORE, /\n  global\.BPStore = BPStore;\n  BPStore\.sampleName = sampleDisplayName;/);
});
t('25 capacity-shortage optName delegates to BPStore.sampleName, fallback strips "(sample)" too', () => {
  const src = grab(CAP, /function optName\(n\) \{[\s\S]*?\n  \}/);
  assert.match(src, /global\.BPStore\.sampleName\(n\)/);
  const noStore = vm.runInNewContext('var global={};(' + src + ')');
  assert.equal(noStore('Demo · Pandit Sharma Ji (sample)'), 'Pandit Sharma Ji (sample)');
  assert.equal(noStore('Demo · PA Speaker'), 'PA Speaker (sample)');
  assert.equal(noStore('PA Speaker'), 'PA Speaker');
  const withStore = vm.runInNewContext('var global={BPStore:{sampleName:function(n){return "S:"+n;}}};(' + src + ')');
  assert.equal(withStore('x'), 'S:x');
});
t('25 inventory: list + reserve + check-out use the same optName (BPStore.sampleName)', () => {
  const src = grab(INV, /function optName\(n\)\{[\s\S]*?:s; \}\n/);
  assert.match(src, /BPStore\.sampleName\(n\)/);
  const f = vm.runInNewContext('var window={};(' + src + ')');
  assert.equal(f('Demo · Pandit Sharma Ji (sample)'), 'Pandit Sharma Ji (sample)');
  // stock list, reservations, check-outs (open + cancelled) and the history row show the display name
  assert.match(INV, /<td><b>\$\{esc\(optName\(i\.name\)\)\}<\/b>/);
  assert.equal((INV.match(/<td><b>\$\{esc\(optName\(it\.name\)\)\}<\/b>/g) || []).length, 4);
  assert.doesNotMatch(INV, /<td><b>\$\{esc\(i\.name\)\}<\/b>/);
  assert.doesNotMatch(INV, /<td><b>\$\{esc\(it\.name\)\}<\/b>/);
  // the pickers still use it; values stay the record id / name
  assert.match(INV, /<option value="\$\{esc\(i\.id\)\}">\$\{esc\(optName\(i\.name\)\)\} — /);
  assert.match(INV, /<option value="\$\{esc\(p\.name\)\}" data-id="\$\{esc\(p\.id\)\}" data-kind="\$\{p\.kind\}">\$\{esc\(optName\(p\.name\)\)\}/);
});
t('25 resources pickers use the same sample-name format', () => {
  assert.match(RES, /const sn=\(n\)=>\{ try\{ if\(window\.BPStore&&typeof BPStore\.sampleName==="function"\) return BPStore\.sampleName\(n\);/);
  assert.match(RES, /<option value="\$\{esc\(i\.id\)\}">\$\{esc\(sn\(i\.name\)\)\}<\/option>/);
  assert.match(RES, /<option value="\$\{esc\(v\.id\)\}">\$\{esc\(sn\(v\.name\)\)\} — /);
});

/* ---------------------------------------------------------------- 21 / 22: resource plan */
t('21 resources without ?quote shows the shared "Pick an event" list (after sign-in + view checks)', () => {
  assert.match(RES, /<script src="pick-event\.js\?v=1"><\/script>/);
  const boot = grab(RES, /BPUI\.boot\(async \(\)=>\{[\s\S]*?\n  \}\);/);
  assert.match(boot, /if\(!id\)\{ if\(window\.HelmPickEvent\) HelmPickEvent\.show\(\$\("#notfound"\),"resources","resource plan"\); else \$\("#notfound"\)\.hidden=false; return; \}/);
  assert.ok(boot.indexOf('requireView("resources")') < boot.indexOf('HelmPickEvent.show'), 'picker after the view check');
  assert.ok(boot.indexOf('location.replace("login.html') < boot.indexOf('HelmPickEvent.show'), 'picker after the sign-in redirect');
  assert.doesNotMatch(boot, /if\(!id\)\{ \$\("#notfound"\)\.hidden=false; return; \}/);
  const PE = vm.runInNewContext(read('public/pick-event.js') + ';HelmPickEvent', {});
  assert.equal(PE._href('resources', 'q 1'), 'resources.html?quote=q%201');
});
t('22 needs table: the quantity column reads "Qty" (r24: Need · Qty · We have · Missing · Action)', () => {
  assert.match(RES, /<th scope="col">Need<\/th><th scope="col" class="num">Qty<\/th><th scope="col" class="num">We have<\/th><th scope="col">Missing<\/th><th scope="col">Action<\/th>/);
  assert.equal((RES.match(/<th scope="col"[^>]*>Need<\/th>/g) || []).length, 1);
});

/* ---------------------------------------------------------------- 27: pull from discovery */
t('27 "Pull from discovery requirements": hidden without discovery view, disabled without resources edit', async () => {
  assert.match(RES, /<div class="s-d2c171b" id="pullWrap" hidden><button type="button" class="btn sm" id="pullBtn">/);
  const src = grab(RES, /async function gatePull\(\)\{[\s\S]*?\n  \}/);
  const run = async (view, edit) => {
    const els = { '#pullBtn': { hidden: true, disabled: false, title: '', removeAttribute(k) { this[k] = ''; } }, '#pullWrap': { hidden: true } };
    const ctx = { $: (s) => els[s], canEdit: edit, BPStore: { auth: { canView: async (a) => { assert.equal(a, 'discovery'); if (view === 'throw') throw new Error('x'); return view; } } } };
    vm.createContext(ctx); vm.runInContext(src + ';this.gatePull=gatePull;', ctx);
    await ctx.gatePull(); return els;
  };
  let e = await run(false, true); assert.equal(e['#pullBtn'].hidden, true); assert.equal(e['#pullWrap'].hidden, true);
  e = await run('throw', true); assert.equal(e['#pullBtn'].hidden, true);
  e = await run(true, true); assert.equal(e['#pullBtn'].hidden, false); assert.equal(e['#pullWrap'].hidden, false); assert.equal(e['#pullBtn'].disabled, false);
  e = await run(true, false); assert.equal(e['#pullBtn'].hidden, false); assert.equal(e['#pullBtn'].disabled, true); assert.match(e['#pullBtn'].title, /can view the resource plan but not change it/);
  assert.match(RES, /function pullFromRequirements\(\)\{ if\(!canEdit\|\|\$\("#pullBtn"\)\.hidden\) return;/);
  assert.match(RES, /\$\("#addCard"\)\.hidden=!canEdit; \$\("#bookBtn"\)\.hidden=!canEdit; onKind\(\);[\s\S]{0,260}await gatePull\(\);/);
});

/* ---------------------------------------------------------------- 23: vendors for an event */
t('23 vendors ?quote with no bookings: own empty state + link to the resource plan bookings card', () => {
  assert.match(VEN, /else if\(quoteId && eventOnly && !eventVendors\.size\)\{/);
  assert.match(VEN, /No vendors booked for this event yet\. <a href="resources\.html\?quote=\$\{encodeURIComponent\(quoteId\)\}#bookings"/);
  assert.match(RES, /<section class="card rp-card s-1b0f499" id="bookings" aria-labelledby="bkTitle">[\s\S]{0,80}<h2 id="bkTitle">Vendors for this event<\/h2>/);
  assert.ok(VEN.indexOf('No vendors booked for this event yet') < VEN.indexOf('No partners match this filter'));
});

/* ---------------------------------------------------------------- 24: saved-view "All" resets the type tab */
function sfEnv() {
  const mk = (k, on) => { const b = { dataset: { k }, hidden: false, cls: new Set(on ? ['on'] : []), clicks: 0 };
    b.classList = { contains: (c) => b.cls.has(c) }; b.click = () => { b.clicks++; tabs.buttons.forEach((x) => x.cls.delete('on')); b.cls.add('on'); }; return b; };
  const tabs = { buttons: [] };
  tabs.buttons = [mk('', false), mk('vendor', false), mk('rental', true)];
  tabs.querySelectorAll = () => tabs.buttons; tabs.querySelector = (s) => (s === 'button.on' ? tabs.buttons.find((b) => b.cls.has('on')) || null : null);
  const search = { value: 'tent', fired: [], dispatchEvent(e) { this.fired.push(e.type); } };
  const inact = { checked: false, dispatchEvent() {} };
  const ids = { kindTabs: tabs, search, showInactive: inact };
  const doc = { readyState: 'complete', getElementById: (id) => ids[id] || null, addEventListener() {} };
  const g = { document: doc, setTimeout() {}, Event: function (type) { this.type = type; }, location: { pathname: '/x', search: '' } };
  g.window = g; vm.createContext(g); vm.runInContext(SF, g);
  return { SFm: g.HelmSavedFilters, tabs, search };
}
t('24 vendors adapter knows the type tabs (data-k, "" = All)', () => {
  const { SFm } = sfEnv();
  const c = SFm.PAGES.vendors;
  assert.equal(c.tabs, 'kindTabs'); assert.equal(c.tabKey, 'k'); assert.equal(c.tabAll, '');
});
t('24 "All" chip state resets Rentals -> All and clears the search', () => {
  const { SFm, tabs, search } = sfEnv();
  const cfg = SFm.PAGES.vendors;
  assert.equal(SFm.readState(cfg).tab, 'rental');
  SFm.applyState(cfg, { q: '' });
  assert.equal(tabs.buttons[0].clicks, 1);
  assert.ok(tabs.buttons[0].cls.has('on')); assert.ok(!tabs.buttons[2].cls.has('on'));
  assert.equal(search.value, ''); assert.deepEqual(search.fired, ['input']);
  assert.equal(SFm.readState(cfg).tab, '');
});
t('24 a saved vendor view with a type re-applies it', () => {
  const { SFm, tabs } = sfEnv();
  SFm.applyState(SFm.PAGES.vendors, { tab: 'vendor' });
  assert.ok(tabs.buttons[1].cls.has('on'));
});
t('24 other pages keep the data-f / "all" tab convention', () => {
  const { SFm } = sfEnv();
  assert.equal(SFm.PAGES.quotes.tabKey, undefined);
  assert.match(SF, /function tabKey\(cfg\) \{ return cfg\.tabKey \|\| "f"; \}/);
  assert.match(SF, /hasOwnProperty\.call\(cfg, "tabAll"\) \? cfg\.tabAll : "all"/);
});

let n = 0;
for (const [name, fn] of tests) { try { await fn(); n++; } catch (e) { console.error('FAIL - ' + name); throw e; } }
console.log('r20-coord-c: ' + n + '/' + tests.length + ' passed');
