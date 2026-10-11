// render-event-context.test.mjs - LIVE BUG: a Political quote rendered as a wedding.
// Simulates builder ctx -> photo-render-ui (fresh quote meta + override) -> HelmPhotoPrompt.build.
// Stubs only: never calls the image service.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
const P = createRequire(import.meta.url)('../public/photo-render-prompt.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

// a fixture like the owner's "Rohith-Political" (350 x 550 ft, ~5,000 seats, no tables)
const it = (type, x, y, width, height, properties) => ({ id: type + x + y, type, x, y, width, height, rotation: 0, properties: properties || {} });
const RALLY = [it('stage', 125, 10, 100, 40), it('led', 140, 6, 70, 3), it('led', 60, 20, 30, 2), it('led', 260, 20, 30, 2)];
for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) RALLY.push(it('seatblock', 20 + c * 64, 90 + r * 100, 56, 80, { rows: 25, cols: 10 }));
RALLY.push(it('barricade', 10, 70, 330, 2), it('barricade', 10, 520, 330, 2), it('generator', 320, 20, 20, 12), it('generator', 10, 20, 20, 12),
  it('firstaid', 320, 300, 20, 20), it('exit', 160, 530, 30, 15), it('exit', 0, 300, 10, 30), it('chairrow', 175, 60, 2, 2, { seats: 1 }));
const WORLD = { w: 350, h: 550 };
const BAD = /flower|floral|rose|marigold|mandap|chiavari|couple|wedding|bridal|lawn|festoon|candle/i;
const body = (p) => p.split('\n').filter((l) => !/FORBIDDEN/.test(l)).join('\n');

// ---- the UI path in a VM: builder ctx (stale) + refreshMeta (fresh quote) ----
function loadUI(ctxObj) {
  const els = {};
  const document = { readyState: 'complete', getElementById: (id) => els[id] || null, createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {} }) };
  const win = { HelmPhotoPrompt: P, __helmPhotoCtx: () => Object.assign({}, ctxObj) };
  const sb = { window: win, document, console, Promise, Object, Array, String, Math, setTimeout, clearTimeout };
  vm.runInNewContext(rd('public/photo-render-ui.js'), sb);
  return win.HelmPhotoRenderUI;
}
const baseCtx = (eventType, extra) => Object.assign({ quoteId: 'q1', items: RALLY, world: WORLD, eventType, guests: 5000, setting: 'indoor', venueSettingSet: false,
  client: { setting: 'outdoor', city: 'Hyderabad', venueName: 'Parade Grounds' }, country: 'IN', eventDate: '2026-10-06', title: 'Rohith-Political', menuPackage: '' }, extra || {});
function renderPrompt(c) {
  return P.build({ items: c.items, world: c.world, eventType: c.eventType, guests: c.guests, setting: c.setting, eventDate: c.eventDate, country: c.country,
    eventName: c.title, venueName: (c.client || {}).venueName, city: (c.client || {}).city, menuPackage: c.menuPackage, style: 'golden' });
}

for (const ty of ['Political rally', 'political', 'Political', 'Rally', 'Public meeting', 'Political event', null, '']) {
  t('quote type ' + JSON.stringify(ty) + ' -> political profile, no wedding words', () => {
    const UI = loadUI(baseCtx(ty));
    const c = UI.effective(UI.withFresh(baseCtx(ty)));
    assert.equal(c.profile, 'political');
    const r = renderPrompt(c);
    assert.equal(r.profile, 'political');
    const m = body(r.prompt).match(BAD); assert.equal(m, null, 'found: ' + (m && m[0]));
    assert.match(r.prompt, /maidan/); assert.match(r.prompt, /plastic or padded event chairs/);
  });
}

t('stale builder tab: fresh quote type (Political) beats the stale one (Wedding)', () => {
  const UI = loadUI(baseCtx('Wedding'));
  const c = UI.effective(UI.withFresh(baseCtx('Wedding'), { eventType: 'Political rally', eventDate: '2026-10-06', client: { setting: 'outdoor' } }));
  assert.equal(c.profile, 'political'); assert.equal(renderPrompt(c).profile, 'political');
});

t('inference wins over the wedding default (no type, rally objects)', () => {
  assert.equal(P.profileKey('', RALLY), 'political');
  assert.equal(P.profileKey(null, RALLY.filter((x) => x.type !== 'generator' && x.type !== 'firstaid')), 'political');
  assert.equal(P.detect('', RALLY).detected, true);
  assert.equal(P.detect('Political rally', RALLY).detected, false);
});

t('wedding quote stays wedding', () => {
  const W = [it('stage', 80, 4, 40, 16), it('mandap', 90, 30, 20, 20), it('table', 20, 60, 6, 6), it('floral', 50, 50, 2, 2)];
  assert.equal(P.profileKey('Wedding', W), 'wedding');
  assert.equal(P.profileKey('', W), 'wedding');
  const UI = loadUI(baseCtx('Wedding', { items: W }));
  assert.equal(UI.effective(UI.withFresh(baseCtx('Wedding', { items: W }))).profile, 'wedding');
});

t('dialog context line', () => {
  const s = P.contextLine({ items: RALLY, world: WORLD, eventType: 'Political rally', setting: 'outdoor', eventDate: '2026-10-06' });
  assert.equal(s.text, 'Event: Political rally · 5,001 seats · 350×550 ft · Outdoor · 6 Oct 2026');
  const d = P.contextLine({ items: RALLY, world: WORLD, eventType: '', setting: 'outdoor' });
  assert.match(d.text, /^Event: Political rally \/ public meeting \(detected from layout\)/);
  const o = P.contextLine({ items: RALLY, world: WORLD, eventType: 'Political rally', setting: 'outdoor', override: 'concert' });
  assert.equal(o.profile, 'concert'); assert.equal(o.eventType, 'concert');
});

t('quote context reaches the prompt (venue, city, event name never as text)', () => {
  const r = renderPrompt(baseCtx('Political rally', { setting: 'outdoor' }));
  assert.match(r.prompt, /CONTEXT: event name "Rohith-Political" \(context only - never write it/);
  assert.match(r.prompt, /venue: Parade Grounds; location: Hyderabad, India/);
  assert.match(r.prompt, /planning markers \(red \/ amber = densely packed seating\)/);
});

t('builder ctx re-reads the quote (refreshMeta) and the dialog uses it', () => {
  const b = rd('public/builder.js'), u = rd('public/photo-render-ui.js');
  assert.match(b, /refreshMeta: async \(\) => \{[\s\S]{0,200}BPStore\.quotes\.get\(currentQuoteId\)/);
  assert.match(b, /PRICING\.eventType = q\.eventType \|\| null; PRICING\.eventDate/);
  assert.match(u, /c = effective\(await refreshMeta\(c\)\);/);
  assert.match(u, /venueName: cl\.venueName \|\| cl\.venue/);
});

console.log(`render-event-context: ${n} passed`);
