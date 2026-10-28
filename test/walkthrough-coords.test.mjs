// Walkthrough stop target  vs  3D mesh placement (builder-3d.js)  vs  2D SVG transform (builder.js).
// Reads the REAL source lines (no hand-copied formulas) and compares, for 20 random single-item layouts
// in random / odd-sized halls, the stop's look-at point with the mesh group's world centre, and the
// walkthrough's "front" vector with the mesh's local +z after three.js Ry(rotation.y).
// R49: a stop now frames a 3D box built from the ROTATED footprints, so the check is "the stop's frame box is centred
// on the mesh"; plus a rotated GROUP (the old bbox ignored rotation and aimed up to 15 ft off).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const rd = (f) => readFileSync(path.join(DIR, f), 'utf8');

// ---- walkthrough (pure part) ----
const cx = { window: {} }; cx.globalThis = cx; vm.createContext(cx);
vm.runInContext(rd('capture-frame.js'), cx);
cx.window.HelmCaptureFrame = cx.window.HelmCaptureFrame || cx.HelmCaptureFrame;
vm.runInContext(rd('walkthrough.js'), cx);
const WT = cx.window.HelmWalkthrough;

// ---- builder-3d mesh placement, taken verbatim from the source ----
const B3 = rd('builder-3d.js');
const grab = (re, what) => { const m = B3.match(re); assert.ok(m, 'builder-3d.js: cannot find ' + what); return m[0]; };
const sxLine = grab(/const sx = fx => [^;]+;/, 'sx');
const szLine = grab(/const sz = fy => [^;]+;/, 'sz');
const placeLine = grab(/g\.position\.set\(sx\(it\.x\+it\.width\/2\),0,sz\(it\.y\+it\.height\/2\)\); g\.rotation\.y=-\(it\.rotation\|\|0\)\*Math\.PI\/180;/, 'mesh placement');
// tiny stand-in for a THREE.Group: position + rotation.y, local→world exactly like three.js r128
// (Object3D.matrix = T * R(Euler XYZ with only y) ; makeRotationY = [[c,0,s],[0,1,0],[-s,0,c]])
const place = new Function('WORLD', 'it', `${sxLine}${szLine}
  const g = { position: { set(x, y, z) { this.x = x; this.y = y; this.z = z; } }, rotation: { y: 0 } };
  ${placeLine}
  return g;`);
const toWorld = (g, lx, ly, lz) => { const c = Math.cos(g.rotation.y), s = Math.sin(g.rotation.y);
  return [g.position.x + c * lx + s * lz, g.position.y + ly, g.position.z - s * lx + c * lz]; };

// ---- builder.js 2D: translate(cx cy) rotate(deg) ----
const B2 = rd('builder.js');
assert.ok(/transform:`translate\(\$\{cx\} \$\{cy\}\) rotate\(\$\{it\.rotation\}\)`/.test(B2), '2D item transform changed');
const svg2D = (it, lx, ly) => { const t = (it.rotation || 0) * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
  return [it.x + it.width / 2 + lx * c - ly * s, it.y + it.height / 2 + lx * s + ly * c]; };   // SVG rotate(): clockwise in y-down

// ---- seeded random ----
let seed = 1234567; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const FT_PER_M = 3.280839895;
// zone stops that target exactly one item, plus the stage
const TYPES = ['stage', 'dancefloor', 'buffet', 'bar', 'photobooth', 'mandap', 'floralarch', 'fountain', 'chandelier', 'chariot', 'caketable', 'piano', 'ledscreen', 'videowall'];
const KEY = { buffet: 'dining', ledscreen: 'screen', videowall: 'screen' };
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

let n = 0;
for (let k = 0; k < 20; k++) {
  // odd halls: metre-sized (stored in ft), very wide, very deep, tiny-but-valid
  const hall = pick([
    () => ({ w: +(30 * FT_PER_M).toFixed(4), h: +(18.5 * FT_PER_M).toFixed(4) }),
    () => ({ w: 40 + Math.round(rnd() * 500), h: 30 + Math.round(rnd() * 300) }),
    () => ({ w: 550, h: 60 }), () => ({ w: 60, h: 420 }), () => ({ w: 12.5, h: 11 }),
  ])();
  const type = TYPES[k % TYPES.length];
  const w = +(2 + rnd() * Math.min(60, hall.w - 2)).toFixed(2), h = +(2 + rnd() * Math.min(40, hall.h - 2)).toFixed(2);
  const it = { id: 'i' + k, type, x: +(rnd() * (hall.w - w)).toFixed(2), y: +(rnd() * (hall.h - h)).toFixed(2), width: w, height: h,
    rotation: pick([0, 90, 180, 270, -45, 30, 135, 359, Math.round(rnd() * 720 - 360)]), properties: {}, label: '' };
  const WORLD = { w: hall.w, h: hall.h };   // builder-3d reads the live global WORLD; walkthrough gets the same object
  const stops = WT.walkthroughStops([it], WORLD, { aspect: 16 / 9 });
  const stop = stops.find((s) => s.owns.includes(it.id));
  assert.ok(stop, `${type}: no stop owns it`);
  const g = place(WORLD, it);
  // 1) the stop frames a box centred on the mesh (x, z) - unless a small room's overview shows it whole
  if (stop.view === 'frame') { const fb = stop.frame.box;
    near((fb.min[0] + fb.max[0]) / 2, g.position.x, 0.02, `#${k} ${type} frame centre x vs mesh.x (hall ${hall.w}x${hall.h}, rot ${it.rotation})`);
    near((fb.min[2] + fb.max[2]) / 2, g.position.z, 0.02, `#${k} ${type} frame centre z vs mesh.z`); }
  // 2) mesh centre == 2D centre mapped with the walkthrough's own S() (x - W/2, z = y - H/2)
  const c2 = svg2D(it, 0, 0);
  near(g.position.x, c2[0] - hall.w / 2, 1e-9, `#${k} mesh.x vs 2D centre`); near(g.position.z, c2[1] - hall.h / 2, 1e-9, `#${k} mesh.z vs 2D centre`);
  // 3) every rotated footprint corner: 2D SVG == 3D mesh (sign + degrees/radians + z flip)
  for (const [lx, ly] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]) {
    const p2 = svg2D(it, lx, ly), p3 = toWorld(g, lx, 0, ly);
    near(p3[0], p2[0] - hall.w / 2, 1e-9, `#${k} corner x`); near(p3[2], p2[1] - hall.h / 2, 1e-9, `#${k} corner z`);
  }
  // 4) "front" (stage / screen face = local +z) — walkthrough's rot(0,1,deg) vs the mesh after Ry
  if (stop.view === 'frame' && (type === 'stage' || type === 'ledscreen' || type === 'videowall')) {
    const f3 = toWorld(g, 0, 0, 1); const fx = f3[0] - g.position.x, fz = f3[2] - g.position.z;
    const cam = [stop.pos[0] - stop.target[0], stop.pos[2] - stop.target[2]], L = Math.hypot(cam[0], cam[1]);
    // the camera stands on the front side (allowing clearSpot nudges / wall clamps: just require the same half-plane)
    assert.ok((cam[0] * fx + cam[1] * fz) / L > 0, `#${k} ${type} camera is behind the face (rot ${it.rotation}) cam=${cam} front=${[fx, fz]}`);
  }
  n++;
}
// rotated GROUP: two buffets (one rotated 90) and two chair rows (one rotated 90) - the frame box contains every
// rotated footprint corner and is centred on their union (the old bbox() used raw x..x+width: up to 15 ft off)
{
  const H = { w: 200, h: 140 };
  for (const L of [
    [{ id: 'b1', type: 'buffet', x: 20, y: 60, width: 40, height: 4, rotation: 90 }, { id: 'b2', type: 'buffet', x: 45, y: 60, width: 4, height: 4, rotation: 0 }],
    [{ id: 'c1', type: 'chairrow', x: 20, y: 40, width: 50, height: 3, rotation: 90, properties: { rows: 1, cols: 20 } }, { id: 'c2', type: 'chairrow', x: 40, y: 60, width: 20, height: 3, rotation: 0, properties: { rows: 1, cols: 8 } }],
  ]) {
    const S = WT.walkthroughStops(L, H, { aspect: 16 / 9 }), st = S.find((s) => s.owns.includes(L[0].id));
    assert.ok(st && st.view === 'frame' && L.every((i) => st.owns.includes(i.id)), 'one stop for the group');
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const i of L) for (const [lx, ly] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) { const p = svg2D(i, lx * i.width / 2, ly * i.height / 2);
      const x = p[0] - H.w / 2, z = p[1] - H.h / 2; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
      assert.ok(x >= st.frame.box.min[0] - 1e-6 && x <= st.frame.box.max[0] + 1e-6 && z >= st.frame.box.min[2] - 1e-6 && z <= st.frame.box.max[2] + 1e-6, 'rotated corner inside the frame box'); }
    near((st.frame.box.min[0] + st.frame.box.max[0]) / 2, (x0 + x1) / 2, 0.6, 'group frame centred on the rotated footprints (x)');
    near((st.frame.box.min[2] + st.frame.box.max[2]) / 2, (z0 + z1) / 2, 0.6, 'group frame centred on the rotated footprints (z)');
    n++;
  }
}
console.log(`walkthrough-coords: ${n} checks - stops frame the mesh centre; 2D == 3D footprint + front vector; rotated groups OK`);
