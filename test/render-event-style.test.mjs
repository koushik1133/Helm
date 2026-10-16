// render-event-style.test.mjs - political events must not be prompted as weddings.
// Pure prompt-builder test: never calls the image service.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const P = createRequire(import.meta.url)('../public/photo-render-prompt.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

const it = (type, x, y, width, height, properties) => ({ id: type + x + y, type, x, y, width, height, rotation: 0, properties: properties || {} });
const ITEMS = [it('stage', 100, 10, 80, 30), it('podium', 135, 20, 6, 4), it('led', 110, 6, 60, 3),
  it('seatblock', 40, 80, 90, 80, { rows: 20, cols: 15 }), it('seatblock', 150, 80, 90, 80, { rows: 20, cols: 15 }),
  it('barricade', 10, 60, 260, 2), it('table', 20, 200, 6, 6, { seats: 8 }), it('floral', 10, 10, 4, 4)];
const WEDDING = /\b(wedding|bridal|bride|groom|mandap|floral\w*|flowers?|roses?|marigolds?|garlands?|petals?|chandeliers?|candle\w*|ivory|ballroom|couple|festoon|fairy)\b/i;
// a negated statement may name a forbidden thing; every positive instruction must not
const NEG = /FORBIDDEN|NEGATIVE|Do not introduce|\bno chandeliers\b|nothing celebratory/i;

const STYLES = ['golden', 'daylight', 'evening', 'ballroom'];
for (const style of STYLES) for (const setting of ['outdoor', 'indoor']) {
  t('political (' + style + ', ' + setting + '): no wedding terms outside the negative prompt', () => {
    const r = P.build({ items: ITEMS, world: { w: 280, h: 260 }, eventType: 'Political / rally', guests: 600, style, setting, country: 'IN' });
    assert.equal(r.profile, 'political');
    const bad = r.prompt.split('\n').filter((l) => !NEG.test(l) && WEDDING.test(l));
    assert.deepEqual(bad, [], 'wedding vocabulary leaked:\n' + bad.join('\n'));
  });
}

t('political prompt carries rally descriptors + a negative prompt', () => {
  const r = P.build({ items: ITEMS, world: { w: 280, h: 260 }, eventType: 'Political rally', style: 'ballroom' });
  assert.match(r.prompt, /podium/i); assert.match(r.prompt, /flags/i); assert.match(r.prompt, /barricade/i); assert.match(r.prompt, /stage/i);
  assert.match(r.prompt, /NEGATIVE PROMPT[^\n]*wedding[^\n]*mandap[^\n]*florals/i);
  for (const w of ['wedding', 'bridal', 'mandap', 'florals', 'chandeliers']) assert.ok(r.negative.includes(w), 'negative lacks ' + w);
  assert.match(r.prompt, /indoor public hall/i);
  assert.doesNotMatch(r.prompt, /luxury event photographer/i);
});

t('a plan with barricades + crowd seating and no event type is detected as political', () => {
  const crowd = [it('stage', 100, 10, 80, 30)];
  for (let i = 0; i < 4; i++) crowd.push(it('seatblock', 20 + i * 60, 80, 50, 60, { rows: 10, cols: 10 }));
  crowd.push(it('barricade', 10, 60, 260, 2), it('podium', 135, 20, 6, 4));
  assert.equal(P.build({ items: crowd, world: { w: 280, h: 200 } }).profile, 'political');
});

t('weddings keep their florals/ballroom and get a negative prompt against rally styling', () => {
  const r = P.build({ items: [it('mandap', 100, 10, 40, 40), it('floral', 10, 10, 4, 4), it('table', 20, 100, 6, 6)], world: { w: 200, h: 140 }, eventType: 'Wedding', style: 'ballroom' });
  assert.equal(r.profile, 'wedding');
  assert.match(r.prompt, /chandelier/i); assert.match(r.prompt, /mandap/i);
  assert.match(r.prompt, /NEGATIVE PROMPT[^\n]*political flags/i);
});

t('every profile has descriptors and a negative prompt', () => {
  for (const k of Object.keys(P.PROFILES)) {
    const v = P.VENUE_STYLE[k]; assert.ok(v && v.descriptors && v.negative.length, 'missing VENUE_STYLE for ' + k);
  }
});

console.log('render-event-style: ' + n + ' passed');
