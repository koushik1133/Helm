// R8: booklet image status (missing / stale / ok), info shape tolerance, capture fallback reporting
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('  ✓ ' + name); };
globalThis.window = globalThis; globalThis.document = { querySelector: () => null };
(0, eval)(read('public/share-checklist.js'));
const SC = globalThis.HelmShareChecklist;
const CF = createRequire(import.meta.url)('../public/capture-frame.js');
const vs = [{ createdAt: '2026-10-05T00:00:00Z' }];

await t('imageStatus: missing / stale / ok per kind and style', () => {
  const s = SC.imageStatus({ '2d': { labels: '2026-10-06T00:00:00Z', plain: '2026-10-04T00:00:00Z' } }, vs);
  assert.deepEqual(s, { '2d': { labels: 'ok', plain: 'stale' }, '3d': { labels: 'missing', plain: 'missing' } });
});
await t('stale images are not reported as missing', () => {
  const info = { '2d': { labels: '2026-01-01T00:00:00Z', plain: '2026-01-01T00:00:00Z' }, '3d': { labels: '2026-01-01T00:00:00Z', plain: '2026-01-01T00:00:00Z' } };
  assert.deepEqual(SC.missingImages({ layout2d: true, layout3d: true }, {}, info), []);
});
await t('normInfo tolerates flat / string shapes and junk', () => {
  assert.deepEqual(SC.normInfo({ '2d_labels': 'a', '3d_plain': 'b' }), { '2d': { labels: 'a' }, '3d': { plain: 'b' } });
  assert.deepEqual(SC.normInfo(null), { '2d': {}, '3d': {} });
  assert.deepEqual(SC.missingImages({ layout2d: true }, { layout2d: { plain: false } }, { '2d_labels': 'x' }), []);
});
await t('missing only for ticked styles', () => {
  const m = SC.missingImages({ layout2d: true, layout3d: true }, { layout3d: { plain: false } }, { '2d': { labels: 'x', plain: 'x' } });
  assert.deepEqual(m, [{ section: 'layout3d', kind: '3d', variant: 'labels' }]);
});
await t('uploadSnapshots always re-checks and a failed check is not "missing"', () => {
  const s = read('public/share-checklist.js');
  assert.match(s, /always re-check[^\n]*\n\s*await loadInfo\(\);/);
  assert.match(s, /state\.infoErr = e/);
  assert.match(s, /okLabel: "Use existing images", cancelLabel: "Open builder to update"/);
});
await t('captureSummary: all ok, partial 3D failure, nothing saved', () => {
  const all = CF.captureSummary({ '2d_labels': true, '2d_plain': true, '3d_labels': true, '3d_plain': true });
  assert.equal(all.ok, true);
  const p = CF.captureSummary({ '2d_labels': true, '2d_plain': true, '3d_labels': 'WebGL unavailable' });
  assert.equal(p.ok, false); assert.deepEqual(p.failed, ['3d_labels', '3d_plain']);
  assert.match(p.message, /Saved 2D with labels, 2D without labels\. Not saved: 3D with labels \(WebGL unavailable\); 3D without labels\./);
  assert.match(CF.captureSummary({}).message, /^No client images saved/);
});
await t('builder capture: shared in-flight promise, 3D retry, per-picture upload errors, progress', () => {
  const b = read('public/builder.js');
  assert.match(b, /if\(clientImgBusy\) return clientImgBusy;/);
  assert.match(b, /for\(let a=0;a<2 && !p3\[v\];a\+\+\)/);
  assert.match(b, /try\{ await BPStore\.booklet\.putImage\(qid,k,v,pics\[v\]\); res\[k\+'_'\+v\]=true; \}/);
  assert.match(b, /say\('Capturing 2D…'\)/); assert.match(b, /say\('Capturing 3D…'\)/);
  assert.match(b, /The layout changed while capturing/);
});
console.log(`r8-capture: ${n} passed`);
