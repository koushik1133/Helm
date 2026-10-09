// R10: legend labels wrap to two lines instead of being cut ("8-seat round ta… ×7" live).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const cx = { window: {} }; cx.globalThis = cx; vm.createContext(cx);
vm.runInContext(readFileSync(new URL('../public/capture-frame.js', import.meta.url), 'utf8'), cx);
const CF = cx.window.HelmCaptureFrame || cx.HelmCaptureFrame;
// the live panel: 384×1080 at capture size, also check a narrow one
for (const [w, h] of [[384, 1080], [240, 700], [160, 400]]) {
  const legend = [{ n: 1, name: 'Stage', count: 1 }, { n: 3, name: '8-seat round table', count: 7 }, { n: 5, name: '7-seat round table', count: 7 }, { n: 7, name: 'Guest seating', seats: 105, count: 2 }];
  const L = CF.legendLayout(legend, w, h);
  for (const R of L.rows) {
    assert.ok(!/…/.test(R.text) || R.text.length > 40, 'no ellipsis on short labels (' + w + '): ' + R.text);
    if (R.lines) assert.ok(R.lines.length <= 2);
  }
  const t = L.rows.find((R) => R.n === 3).text;
  assert.match(t, /8-seat round table ×7/, 'full label kept at ' + w + 'px: ' + t);
}
console.log('r10-legend-wrap: ok');
