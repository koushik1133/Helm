/* render-dialog-polish.test.mjs - owner feedback on the "✦ Photo render" dialog:
 * plain wording only (no technical words), camera presets computed from the layout (best angle /
 * current view / top-down / entrance eye level / highlight), decor theme dropdown ("None" adds no
 * theme sentence), plain quality labels; stubbed dialog open/close + error mapping. Pure Node. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (f) => readFileSync(join(ROOT, f), 'utf8');
const P = createRequire(import.meta.url)('../public/photo-render-prompt.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

// ---- layouts from the builder's own generator (same harness as layout-generator-overlap) ----
const js = rd('public/builder.js');
const block = (s0) => { let i = js.indexOf('{', s0), d = 0; for (; i < js.length; i++) { if (js[i] === '{') d++; else if (js[i] === '}' && --d === 0) break; } return js.slice(s0, i + 1); };
const fn = (name) => { const s = js.indexOf('function ' + name + '('); assert.ok(s >= 0, name);
  let i = js.indexOf('{', js.indexOf(')', s)), d = 0; for (; i < js.length; i++) { if (js[i] === '{') d++; else if (js[i] === '}' && --d === 0) break; } return js.slice(s, i + 1); };
const decl = (h) => { const s = js.indexOf(h); assert.ok(s >= 0, h); return block(s) + ';'; };
const line = (h) => { const s = js.indexOf(h); assert.ok(s >= 0, h); return js.slice(s, js.indexOf('\n', s)); };
const G = new Function([
  decl('const ASSETS = {'), 'const WORLD = { w: 200, h: 140 };', line('const clamp = '), line('const round1 = '),
  line('const DESIGN_PITCH='), 'let _packFit = null; let uid = 1; const nid = () => "o" + (uid++); const catColor = () => "#000";',
  line('const GEN_OVERLAY = '), line('const SEAT_SQFT_FALLBACK='), line('const SEAT_UNIT = '), line('const FLOOR_SEATS = '), line('const GEN_SEATING = '),
  ...['makeItem', 'genSeats', 'sumSeats', 'setBlockSeats', 'exactSeats', 'seatSqftFor', 'seatFitWarning', 'seatBottom', 'countSeats', 'tally', 'frontZone', 'supportZone', 'seatTheatre', 'seatRounds', 'seatBanquetLong', 'seatBanquetRounds', 'boothGrid',
    'seatPerimeter', 'seatCocktail', 'seatHalfRoundsTheatre', 'clampItem', 'genRect', 'rectsHit', 'resolveOverlaps', 'generateVariants'].map(fn),
  'return { WORLD, generateVariants };'].join('\n'))();

const HALLS = [[80, 50], [200, 140], [262, 164]];
const TYPES = [{ type: 'wedding', guests: 200, bars: 2, buffet: true, stage: true, dance: true },
  { type: 'political', guests: 500, stage: true, press: true }, { type: 'concert', guests: 500, bars: 2, stage: true },
  { type: 'corporate', guests: 150, stage: true, bars: 1 }];

// is a plan point visible in the camera's frustum?
function sees(v, aspect, px, pz, h) {
  const F = norm([v.target[0] - v.pos[0], v.target[1] - v.pos[1], v.target[2] - v.pos[2]]), R = norm(cross(F, [0, 1, 0])), U = cross(R, F);
  const p = [px - v.pos[0], h - v.pos[1], pz - v.pos[2]], z = dot(p, F); if (z <= 0) return false;
  const tv = Math.tan(v.fov * Math.PI / 360);
  return Math.abs(dot(p, R)) / z <= tv * aspect * 1.001 && Math.abs(dot(p, U)) / z <= tv * 1.001;
}
const norm = (a) => { const L = Math.hypot(...a); return a.map((x) => x / L); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

t('every camera computes a valid view for wedding / political / concert / corporate layouts in 80×50, 200×140, 262×164', () => {
  let views = 0;
  for (const [w, h] of HALLS) for (const o of TYPES) {
    G.WORLD.w = w; G.WORLD.h = h;
    for (const v of G.generateVariants(o)) {
      const items = v.items, world = { w, h };
      for (const kind of ['auto', 'top', 'eye']) {
        const c = P.cameraView(kind, items, world, { aspect: 1.5 });
        assert.ok(c.ok, `${w}x${h} ${o.type} "${v.name}" ${kind}: ${c.why}`);
        views++;
        if (kind === 'eye') {
          const px = c.pos[0] + w / 2, py = c.pos[2] + h / 2;
          assert.ok(px >= 0 && px <= w && py >= 0 && py <= h, 'eye inside the hall');
          assert.equal(c.pos[1], 5.25);
        }
        if (kind === 'auto') {
          // whole hall in frame; looking down 35–45°
          for (const [x, z] of [[-w / 2, -h / 2], [w / 2, -h / 2], [-w / 2, h / 2], [w / 2, h / 2]]) assert.ok(sees(c, 1.5, x, z, 0), `${w}x${h} ${o.type} auto frames the hall corner ${x},${z}`);
          const d = [c.target[0] - c.pos[0], c.target[1] - c.pos[1], c.target[2] - c.pos[2]];
          const pitch = Math.atan2(-d[1], Math.hypot(d[0], d[2])) * 180 / Math.PI;
          assert.ok(pitch >= 35 && pitch <= 45.5, 'pitch ' + pitch);
          assert.ok(Math.abs(c.pos[0] - c.target[0]) > 0.5 || Math.abs(c.pos[2] - c.target[2]) > 0.5, 'not straight down');
        }
      }
      for (const f of ['stage', 'dance', 'entrance', 'seating']) {
        const c = P.cameraView('focus', items, world, { aspect: 1.5, focus: f });
        assert.ok(c.ok, `${w}x${h} ${o.type} focus ${f}: ${c.why}`); views++;
      }
    }
  }
  console.log('    (' + views + ' camera views checked)');
});

t('best angle: camera behind / above the entrance looking toward the stage, slightly off-centre; highlight is closer', () => {
  const W = { w: 80, h: 50 };
  const items = [{ type: 'stage', x: 30, y: 2, width: 20, height: 8 }, { type: 'seatblock', x: 10, y: 20, width: 25, height: 20 },
    { type: 'seatblock', x: 45, y: 20, width: 25, height: 20 }, { type: 'redcarpet', x: 37, y: 12, width: 6, height: 36 }];
  const a = P.cameraView('auto', items, W, { aspect: 1.5 });
  assert.ok(a.pos[2] > a.target[2], 'stage at top edge -> camera on the entrance (bottom) side');
  assert.ok(a.pos[2] > 25, 'behind the entrance edge');
  assert.ok(Math.abs(a.pos[0]) > 2, 'off-centre');
  const s = P.cameraView('focus', items, W, { aspect: 1.5, focus: 'stage' });
  const dist = (v) => Math.hypot(v.pos[0] - v.target[0], v.pos[1] - v.target[1], v.pos[2] - v.target[2]);
  assert.ok(dist(s) < dist(a), 'stage highlight is a closer aerial');
  assert.ok(s.target[2] < a.target[2], 'aimed at the stage');
  // rotated plan: stage on the right edge -> camera on the left
  const r = P.cameraView('auto', [{ type: 'stage', x: 70, y: 15, width: 8, height: 20 }], W, { aspect: 1.5 });
  assert.ok(r.pos[0] < r.target[0]);
  // no stage: frame the centroid of the objects; empty floor still valid
  const ns = P.cameraView('auto', [{ type: 'table', x: 5, y: 5, width: 6, height: 6 }, { type: 'table', x: 25, y: 5, width: 6, height: 6 }], W, {});
  assert.ok(ns.ok && Math.abs(ns.target[0] - (18 - 40)) < 0.01);
  assert.ok(P.cameraView('auto', [], W, {}).ok && P.cameraView('eye', [], W, {}).ok && P.cameraView('top', [], W, {}).topDown);
});

t('eye camera is nudged out of objects that block the entrance', () => {
  const W = { w: 80, h: 50 };
  const items = [{ type: 'stage', x: 30, y: 2, width: 20, height: 8 }, { type: 'bar', x: 30, y: 38, width: 20, height: 12 }];
  const e = P.cameraView('eye', items, W, {});
  assert.ok(e.ok, e.why);
  const px = e.pos[0] + 40, py = e.pos[2] + 25;
  assert.ok(!(px > 30 && px < 50 && py > 38 && py < 50), 'outside the bar');
  assert.equal(P.validView({ kind: 'eye', pos: [0, 5.25, 19], target: [0, 4, -19] }, items, W).ok, false, 'inside the bar is rejected');
  assert.equal(P.validView({ kind: 'auto', pos: [0, 3, 40], target: [0, 0, 0] }, items, W).ok, false, 'too low aerial rejected');
  assert.equal(P.validView({ kind: 'auto', pos: [0, 50, 900], target: [0, 0, 0] }, items, W).ok, false, 'too far rejected');
});

// ---- prompt per theme ----
const LAY = [{ type: 'stage', x: 30, y: 2, width: 20, height: 8 }, { type: 'seatblock', x: 10, y: 20, width: 25, height: 20, properties: { rows: 5, cols: 10 } }];
t('decor theme: None adds no theme sentence; each theme adds its own concise text; Other uses the typed text', () => {
  const none = P.build({ items: LAY, world: { w: 80, h: 50 }, themeKey: 'none' });
  assert.doesNotMatch(none.prompt, /Decor theme requested/); assert.match(none.prompt, /Decor theme: none - realistic decor matching the objects as designed; no added theme\./);
  assert.equal(none.theme, '');
  assert.doesNotMatch(P.build({ items: LAY, world: { w: 80, h: 50 } }).prompt, /Decor theme requested/, 'default = none');
  const keys = Object.keys(P.THEMES).filter((k) => k !== 'none');
  assert.equal(keys.length, 10);
  for (const k of keys) {
    const ev = Object.keys(P.PROFILES).find((pk) => P.PROFILES[pk].themes.includes(k));   // each theme on an event type it fits
    const b = P.build({ items: LAY, world: { w: 80, h: 50 }, themeKey: k, eventType: ev === 'political' ? 'Political rally' : ev });
    assert.ok(P.THEMES[k].text.length > 20 && P.THEMES[k].text.length <= 200, k);
    assert.ok(b.prompt.includes('Decor theme requested by the planner: ' + P.THEMES[k].text + '.'), k);
  }
  assert.match(P.build({ items: LAY, world: { w: 80, h: 50 }, theme: 'teal and copper' }).prompt, /Decor theme requested by the planner: teal and copper\./);
  assert.match(P.build({ items: LAY, world: { w: 80, h: 50 }, focus: 'stage' }).prompt, /FOCUS: the photo should feature the stage area prominently/);
  assert.doesNotMatch(P.build({ items: LAY, world: { w: 80, h: 50 } }).prompt, /FOCUS:/);
  assert.equal(P.build({ items: LAY, world: { w: 80, h: 50 }, camera: 'hero' }).camera, 'hero', 'old saved value still understood');
});

// ---- dialog markup ----
const html = rd('public/builder.html');
const dlg = html.slice(html.indexOf('<div class="modal" id="photoModal"'), html.indexOf('</form>', html.indexOf('id="photoForm"')));
t('dialog: camera / highlight / theme dropdowns, plain quality + count labels', () => {
  assert.match(dlg, /<option value="auto" selected>Best angle \(automatic\)<\/option>/);
  assert.match(dlg, /<option value="current">My current 3D view<\/option>/);
  assert.match(dlg, /<option value="top">Top-down \(plan view\)<\/option>/);
  assert.match(dlg, /<option value="eye">From the entrance \(eye level\)<\/option>/);
  assert.match(dlg, /Turn the 3D view to the angle you like, then render\./);
  assert.doesNotMatch(dlg, /Hero aerial/);
  assert.match(dlg, /<option value="standard">Standard<\/option>/);
  assert.match(dlg, /<option value="high">High detail \(slower\)<\/option>/);
  assert.match(dlg, /Photos: 1–4/);
  assert.match(dlg, /<option value="none" selected>None — just make it realistic<\/option>/);
  for (const k of Object.keys(P.THEMES)) assert.match(dlg, new RegExp('<option value="' + k + '"'));
  assert.match(dlg, /<option value="other">Other…<\/option>/);
  assert.match(dlg, /id="phThemeWrap" hidden/);
  for (const f of ['stage', 'dance', 'entrance', 'seating']) assert.match(dlg, new RegExp('id="phFocus"[\\s\\S]*<option value="' + f + '"'));
});

// ---- no technical words anywhere a user can see ----
const BAD = /openai|\bapi\b|secret|migration|edge function|\bfunction\b|deploy|backend|\bsql\b|server|0095|\.md\b/i;
function uiStrings(src) {   // quoted string literals in the UI code that read like messages (contain a space)
  const out = []; const re = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g; let m;
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  while ((m = re.exec(code))) { const s = m[1] != null ? m[1] : m[2]; if (/ /.test(s) && /[A-Za-z]{3}/.test(s) && !/^[\w.#\[\]=" -]+$/.test(s) || /[.!?…—]$/.test(s)) out.push(s); }
  return out;
}
const visible = (h) => h.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]+>/g, ' ');
t('no technical words in the dialog, the Control Center card, or the render UI / settings messages', () => {
  assert.doesNotMatch(visible(dlg), BAD);
  const ctl = rd('public/control.html'), card = ctl.slice(ctl.indexOf('<div class="card" id="prCard"'), ctl.indexOf('</div>', ctl.indexOf('id="pr_save"')));
  assert.doesNotMatch(visible(card), BAD);
  for (const f of ['public/photo-render-ui.js', 'public/photo-render-settings.js']) {
    const ss = uiStrings(rd(f)); assert.ok(ss.length > 5, f);
    for (const s of ss) assert.doesNotMatch(s, BAD, f + ': ' + s);
  }
  assert.doesNotMatch(rd('public/photo-render-ui.js'), /(toast|showOff|textContent =)[^;]*e\.message/, 'raw error text never shown');
  assert.doesNotMatch(rd('public/photo-render-settings.js'), /e\.message/);
  assert.match(rd('docs/PHOTO-RENDER-SETUP.md'), /OPENAI_API_KEY/, 'internal setup doc kept');
});

// ---- stubbed dialog: open / close, dormant message, error mapping ----
function el(id) {
  return { id, hidden: false, value: '', disabled: false, textContent: '', className: '', children: [], listeners: {},
    addEventListener(k, f) { (this.listeners[k] ||= []).push(f); }, focus() {}, replaceChildren() { this.children = []; },
    appendChild(c) { this.children.push(c); return c; }, querySelectorAll() { return []; }, remove() {} };
}
const ids = {}; const $ = (id) => (ids[id] ||= el(id));
$('phCamera').value = 'auto'; $('phThemeSel').value = 'none'; $('phFocus').value = ''; $('phStyle').value = 'golden'; $('phQuality').value = 'standard'; $('phCount').value = '2';
const toasts = [];
const win = { HelmPhotoPrompt: P, BPUI: { toast: (m) => toasts.push(m) },
  BPStore: { photoRender: { available: () => true, probe: async () => false, settings: async () => ({ enabled: true, can_render: true, can_manage: true, used_this_month: 1, monthly_quota: 60 }), list: async () => [] } },
  __helmPhotoCtx: () => ({ quoteId: 'q1', supported: true, items: LAY, world: { w: 80, h: 50 }, setting: 'outdoor' }) };
const doc = { readyState: 'complete', getElementById: $, createElement: () => el('x'), querySelector: () => null, addEventListener() {} };
vm.runInNewContext(rd('public/photo-render-ui.js'), Object.assign({ window: win, document: doc, setTimeout, clearTimeout, Promise, Date, AbortController, console }, win));
const UI = win.HelmPhotoRenderUI;
await new Promise((r) => setTimeout(r, 0));
UI.open();
await new Promise((r) => setTimeout(r, 10));
t('dialog open -> dormant plain message', () => {
  assert.equal($('photoModal').hidden, false);
  assert.equal($('photoOff').hidden, false);
  assert.equal($('photoOffMsg').textContent, 'Photo renders aren’t switched on for your studio yet.');
  assert.equal($('photoSetup').hidden, false, 'admins see the contact-support line');
  assert.equal($('phCamHint').hidden, true); assert.equal($('phThemeWrap').hidden, true);
  const f = UI.readForm();
  assert.deepEqual([f.camera, f.themeKey, f.theme, f.focus, f.n], ['auto', 'none', '', '', 2]);
  $('phThemeSel').value = 'other'; $('phTheme').value = 'teal & copper';
  const g = UI.readForm(); assert.equal(g.themeKey, null); assert.equal(g.theme, 'teal & copper');
  UI.close(); assert.equal($('photoModal').hidden, true);
});
t('camera options -> capture views (stubs)', () => {
  const c = win.__helmPhotoCtx();
  const a = UI.cameraOpts('auto', c, ''); assert.ok(a.view && a.view.pos.length === 3 && a.labels === 'none');
  const f = UI.cameraOpts('auto', c, 'stage'); assert.ok(f.view && f.view.pos[1] < a.view.pos[1]);
  assert.equal(UI.cameraOpts('top', c).topDown, true);
  assert.equal(UI.cameraOpts('eye', c).view.pos[1], 5.25);
  assert.deepEqual(UI.cameraOpts('current', c).view, a.view, '3D view not open -> best angle');
  win.__helm3D = { isActive: () => true, getView: () => ({ pos: [1, 2, 3], target: [0, 0, 0], fov: 50 }) };
  assert.equal(JSON.stringify(UI.cameraOpts('current', c).view), JSON.stringify({ pos: [1, 2, 3], target: [0, 0, 0], fov: 50 }));
});
t('error codes map to plain messages', () => {
  for (const code of ['render_quota', 'render_rate_limited', 'render_failed', 'render_timeout', 'render_blocked', 'render_busy', 'not_found', 'weird', undefined]) {
    const m = UI.plainError({ code, message: 'OPENAI_API_KEY missing from edge function secrets' });
    assert.doesNotMatch(m, BAD); assert.ok(m.length > 10);
  }
});
console.log('\nrender-dialog-polish: ' + n + ' passed.');
