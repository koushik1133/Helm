// Photo Render: every placed product + its décor variant must reach the prompt, per event type,
// including mixed-variant groups and the compressed (long-layout) prompt levels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const P = createRequire(import.meta.url)('../public/photo-render-prompt.js');

const base = [
  { id: 's1', type: 'stage', x: 40, y: 2, width: 30, height: 14 },
  { id: 'a1', type: 'floralarch', x: 10, y: 60, width: 10, height: 3, properties: { style: 'hexagon', flower: 'rose', palette: 'blush' } },
  { id: 'a2', type: 'floralarch', x: 22, y: 60, width: 10, height: 3, properties: { style: 'ring', flower: 'orchid' } },
  { id: 'b1', type: 'balloonarch', x: 80, y: 60, width: 10, height: 3, properties: { palette: 'goldchrome' } },
  { id: 'c1', type: 'chiavari', x: 50, y: 40, width: 2, height: 2, properties: { style: 'ghost' } },
  { id: 't1', type: 'table', x: 30, y: 30, width: 6, height: 6, properties: { seats: 8 } },
];
const types = ['wedding', 'birthday', 'corporate', 'political', 'iftar', 'conference', 'concert', 'exhibition'];

for (const eventType of types) {
  test('prompt mentions every product + variant: ' + eventType, () => {
    const r = P.build({ eventType, items: base, world: { w: 120, h: 90 }, camera: 'perspective', style: 'daylight' });
    const pr = r.prompt;
    // non-floral profiles deliberately rename floral types (floralarch -> decorarch); every object must still be in the canonical JSON
    const alias = { floralarch: 'decorarch' };
    for (const it of base) assert.ok(pr.includes('"t":"' + it.type + '"') || pr.includes('"t":"' + alias[it.type] + '"'), eventType + ' missing ' + it.type);
    for (const w of ['hexagon metal frame', 'round ring (moon-gate) frame', 'gold and chrome', 'clear acrylic ghost']) assert.ok(pr.includes(w), eventType + ' missing variant ' + w);
  });
}

test('mixed-variant group describes both variants and survives compression', () => {
  const many = base.slice();
  for (let i = 0; i < 400; i++) many.push({ id: 'x' + i, type: i % 2 ? 'cocktail' : 'planter', x: (i * 7) % 110, y: 20 + (i * 3) % 60, width: 2 + (i % 5), height: 2 + (i % 3) });
  const r = P.build({ eventType: 'wedding', items: many, world: { w: 120, h: 90 } });
  assert.ok(r.prompt.length <= P.PROMPT_LIMIT);
  assert.ok(r.prompt.includes('hexagon metal frame') && r.prompt.includes('moon-gate'));
});
