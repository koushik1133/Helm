// R2: builder "Update client images" + share flow reuse of fresh builder renders
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

t('builder has the capture button + clean 2D / 3D capture hooks', () => {
  assert.match(read('public/builder.html'), /id="clientImgBtn"[^>]*hidden/);
  const b = read('public/builder.js');
  assert.match(b, /planBlob\(\{clean:true, maxW:1920\}\)/);
  assert.match(b, /querySelectorAll\('\.margins,\.measure'\)/);
  assert.match(b, /uploadSnapshot\(currentQuoteId,'3d'/);
  const d = read('public/builder-3d.js');
  assert.match(d, /window\.__capture3D=capture3D/);
  assert.match(d, /grid\.visible=false/); assert.match(d, /transform\.visible=false/); assert.match(d, /selHelper\.visible=false/);
});
t('freshEnough: stored image must be at/after the newest version', () => {
  globalThis.window = globalThis; globalThis.document = { querySelector: () => null };
  const src = read('public/share-checklist.js'); (0, eval)(src);
  const f = globalThis.HelmShareChecklist.freshEnough;
  const vs = [{ createdAt: '2026-10-01T00:00:00Z' }, { created_at: '2026-10-05T00:00:00Z' }];
  assert.equal(f('2026-10-06T00:00:00Z', vs), true);
  assert.equal(f('2026-10-04T00:00:00Z', vs), false);
  assert.equal(f(null, vs), false);
});
t('booklet image opens a lightbox', () => {
  const s = read('public/booklet.js'); assert.match(s, /function openLightbox/); assert.match(s, /snap-zoom/);
  assert.match(read('public/booklet.css'), /\.lightbox\{/);
});
console.log(`booklet-capture: ${n} passed`);
