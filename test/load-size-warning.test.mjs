// load-fit.js: warn before loading a layout bigger than the current hall; overlap note after fitting.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
globalThis.window = globalThis; new Function(read('public/load-fit.js'))();
const LF = globalThis.HelmLoadFit;
const t = (n, f) => { f(); console.log('  ✓ ' + n); };

t('extent = bounding box of the objects', () => {
  assert.deepEqual(LF.extent([{ x: 10, y: 5, width: 20, height: 10 }, { x: 300, y: 500, width: 50, height: 50 }]), { w: 350, h: 550 });
});
t('size = max(saved hall, objects)', () => {
  assert.deepEqual(LF.size({ items: [{ x: 0, y: 0, width: 10, height: 10 }], scale: { worldFt: { w: 350, h: 550 } } }), { w: 350, h: 550 });
  assert.deepEqual(LF.size({ items: [{ x: 0, y: 0, width: 400, height: 10 }], room: { w: 350, h: 550 } }), { w: 400, h: 550 });
  assert.deepEqual(LF.size([{ x: 0, y: 0, width: 30, height: 20 }]), { w: 30, h: 20 });
});
t('compare: longer / wider / fits', () => {
  const hall = { w: 200, h: 140 };
  assert.deepEqual(LF.compare({ w: 350, h: 550 }, hall), { longer: true, wider: true, any: true });
  assert.deepEqual(LF.compare({ w: 250, h: 100 }, hall), { longer: true, wider: false, any: true });
  assert.deepEqual(LF.compare({ w: 100, h: 150 }, hall), { longer: false, wider: true, any: true });
  assert.equal(LF.compare({ w: 200.3, h: 140 }, hall).any, false);
});
t('message in plain words, ft and m', () => {
  assert.equal(LF.message({ w: 350, h: 550 }, { w: 200, h: 140 }, 'ft'),
    "This layout is 350 × 550 ft but your hall is 200 × 140 ft. It's longer and wider than your hall, so items may overlap or be squeezed to fit.");
  assert.match(LF.message({ w: 250, h: 100 }, { w: 200, h: 140 }, 'ft'), /It's longer than your hall/);
  assert.match(LF.message({ w: 100, h: 150 }, { w: 200, h: 140 }, 'ft'), /It's wider than your hall/);
  assert.match(LF.message({ w: 328.084, h: 164.042 }, { w: 164.042, h: 98.4252 }, 'm'), /100 × 50 m but your hall is 50 × 30 m/);
  assert.equal(LF.message({ w: 10, h: 10 }, { w: 200, h: 140 }, 'ft'), '');
});
t('target hall respects the plan cap', () => {
  assert.deepEqual(LF.targetHall({ w: 350, h: 550 }, 1000), { w: 350, h: 550, capped: false });
  assert.deepEqual(LF.targetHall({ w: 350, h: 550 }, 400), { w: 350, h: 400, capped: true });
});
t('overlap count: only new overlaps / wall clamps', () => {
  const before = [{ id: 'a', x: 0, y: 0, width: 10, height: 10 }, { id: 'b', x: 20, y: 0, width: 10, height: 10 }, { id: 'c', x: 50, y: 50, width: 5, height: 5 }];
  const after = [{ id: 'a', x: 0, y: 0, width: 10, height: 10 }, { id: 'b', x: 5, y: 0, width: 10, height: 10 }, { id: 'c', x: 50, y: 50, width: 5, height: 5 }];
  assert.deepEqual(LF.overlapIds(before, after), ['a', 'b']);
  assert.deepEqual(LF.overlapIds(before, before), []);
  const pre = [{ id: 'x', x: 0, y: 0, width: 10, height: 10 }, { id: 'y', x: 5, y: 5, width: 10, height: 10 }];
  assert.deepEqual(LF.overlapIds(pre, pre), [], 'overlaps already in the source are not reported');
  assert.deepEqual(LF.overlapIds([{ id: 'w', x: 300, y: 0, width: 10, height: 10 }], [{ id: 'w', x: 190, y: 0, width: 10, height: 10 }], { clamp: true }), ['w']);
  assert.equal(LF.noteText(3), '3 items overlap after fitting — check the layout');
});
t('wiring: every load path asks first', () => {
  const b = read('public/builder.js'), st = read('public/studio-templates.js'), wz = read('public/layout-wizard.js');
  assert.match(b, /async function loadTemplate[\s\S]*?lfAsk\(/, 'built-in templates');
  assert.match(b, /\$\('#refEvents'\)\.addEventListener[\s\S]*?lfAsk\(lfSz\)[\s\S]*?loadItems\(stripStalePrices\(items\)/, 'reference a past layout');
  assert.match(b, /data-act="open"[\s\S]*?lfAsk\(lfSz\)[\s\S]*?applyLayout\(openData\)/, 'open saved layout');
  assert.match(st, /async function apply\(id\)[\s\S]*?B\.fn\("lfAsk"\)[\s\S]*?fitToHall/, 'studio templates');
  assert.match(wz, /bMine\.addEventListener\('click'[^\n]*HelmStudioTemplates\.openPicker/, 'wizard "Start from my template" goes through studio apply');
  for (const h of ['public/builder.html', 'public/capture.html']) assert.match(read(h), /<script src="load-fit\.js\?v=1"><\/script>/);
  assert.match(b, /function lfUseSize[\s\S]*?CAPS&&CAPS\.hall/);
});
console.log('load-size-warning: all passed');
