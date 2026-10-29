// Every builder catalogue item must have: a 2D symbol (renderItem case or a deliberate box), a toolbox
// glyph, a 3D model (premium kit or classic switch — never the grey fallback box) and a price.
// Also smoke-runs the premium 3D kit against a stub THREE so a typo in a new model fails here, not in the browser.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const b = read('public/builder.js'), b3 = read('public/builder-3d.js'), sa = read('public/store-api.js');

const a0 = b.indexOf('const ASSETS = {'), a1 = b.indexOf('\n};', a0);
const assets = [...b.slice(a0, a1).matchAll(/^\s*([a-z_0-9]+):\s*\{\s*label:'[^']*',\s*category:'([a-z]+)'(.*)$/gm)].map((m) => ({ t: m[1], seat: /props:\{(rows|seats)/.test(m[3]) || /^(chiavari|barstool)$/.test(m[1]) }));
assert.ok(assets.length >= 85, 'parsed builder assets: ' + assets.length);

const casesIn = (src) => new Set([...src.matchAll(/case '([a-z_0-9]+)'/g)].map((m) => m[1]));
const r0 = b.indexOf('function renderItem('), r1 = b.indexOf('function toolIcon(', r0);
const sym2d = casesIn(b.slice(r0, r1));
const g0 = b.indexOf('function assetGlyph('), g1 = b.indexOf('\n}\n', g0);
const glyph = casesIn(b.slice(g0, g1));
const m0 = b3.indexOf('function buildPremium('), m1 = b3.indexOf('  /* ---------------- label sprites', m0);
const models3d = casesIn(b3.slice(m0, b3.indexOf('  function buildFurniture(', m0)));
const f0 = b3.indexOf('  function buildFurniture('), all3d = new Set([...models3d, ...casesIn(b3.slice(f0, b3.indexOf('  /* ---------------- label sprites', f0)))]);
const DEF = new Function('return {' + b.match(/const DEFAULT_PRICES = \{[^\n]*\n([\s\S]*?)\n\};/)[1] + '}')();
const OBJ = new Function('return {' + sa.match(/const OBJECT_PRICE = \{\n([\s\S]*?)\n  \};/)[1] + '}')();
// plain-box items in 2D are intentional (simple rectangles that read well top-down)
const BOX_2D = new Set(['speaker', 'coatcheck', 'restroom', 'gifttable', 'caketable', 'linearray', 'subwoofer', 'monitor', 'foh', 'movinghead', 'videowall', 'distro', 'cableramp', 'greenroom', 'viprisers', 'stagebarrier', 'photobooth', 'chairrow', 'seatblock', 'headtable', 'longtable']);
const missing = [];
for (const { t, seat } of assets) {
  if (!sym2d.has(t) && !BOX_2D.has(t)) missing.push('2D:' + t);
  if (!all3d.has(t)) missing.push('3D:' + t);
  if (!seat && (DEF[t] == null || OBJ[t] == null)) missing.push('price:' + t);
}
assert.deepEqual(missing, [], 'catalogue gaps');
// new pack: icon + price + 3D model present, never renamed
for (const t of ['entrancegate', 'phoolchadar', 'jhoola', 'haldi', 'mehendi', 'selfieframe', 'welcomeboard', 'fairylights', 'couplesofa', 'livecounter', 'kidszone', 'aircooler']) {
  assert.ok(glyph.has(t), 'toolbox glyph ' + t); assert.ok(models3d.has(t), '3D ' + t); assert.ok(DEF[t] > 0, 'price ' + t); }
// legacy ids that saved layouts reference are never removed
for (const t of ['floralarch', 'mandap', 'stage', 'table', 'chiavari', 'arch', 'drape', 'chandelier', 'redcarpet', 'lighting', 'led']) assert.ok(assets.some((a) => a.t === t), 'kept ' + t);

/* ---- smoke-run every premium model against a recording THREE stub ---- */
const k0 = b3.indexOf('  /* ---------------- premium model kit'), k1 = b3.indexOf('  function buildFurniture(');
const ch0 = b3.indexOf('  function chairGeometry(){'), ch1 = b3.indexOf('  /* ---------------- per-type furniture builders');
class V { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set(x, y, z) { Object.assign(this, { x, y, z }); return this; } setScalar() { return this; } copy() { return this; } }
class Obj { constructor() { this.position = new V(); this.rotation = new V(); this.scale = new V(1, 1, 1); this.children = []; this.material = { clone: () => ({}) }; } add(o) { assert.ok(o, 'added object'); this.children.push(o); } clone() { return new Obj(); } }
let meshes = 0;
class Geo { constructor() { this.attributes = { position: { count: 4, getX: () => 0, setZ: () => {} } }; } translate() { return this; } rotateX() { return this; } dispose() {} computeVertexNormals() {} }
const THREE = new Proxy({
  Group: Obj, Vector3: V, Vector2: V, Color: class {},
  Mesh: class extends Obj { constructor(g, m) { super(); meshes++; assert.ok(g && m, 'mesh needs geometry + material'); } },
  InstancedMesh: class extends Obj { constructor(g, m, n) { super(); assert.ok(n > 0); this.instanceMatrix = {}; this.instanceColor = {}; } setMatrixAt() {} setColorAt() {} },
  Matrix4: class { compose() {} }, Quaternion: class { setFromEuler() {} }, Euler: class { set() {} },
  QuadraticBezierCurve3: class {}, MeshStandardMaterial: class { dispose() {} }, MeshBasicMaterial: class { dispose() {} },
  BufferGeometryUtils: { mergeGeometries: (p) => { assert.ok(p.length > 5); return new Geo(); } },
  DoubleSide: 2,
}, { get: (o, k) => (k in o ? o[k] : Geo) });
const kit = new Function('THREE', 'rotOff', `
  const col=c=>({c}); const mat=(c,o)=>({c,o});
  function boxMesh(){ return new THREE.Mesh(new THREE.BoxGeometry(), {}); }
  ${b3.slice(ch0, ch1)}
  ${b3.slice(k0, k1)}
  return { buildPremium };`)(THREE, (x, y) => [x, y]);
const sizes = Object.fromEntries([...b.slice(a0, a1).matchAll(/^\s*([a-z_0-9]+):\s*\{[^}]*?w:\s*([\d.]+),\s*h:\s*([\d.]+)/gm)].map((m) => [m[1], [+m[2], +m[3]]]));
for (const t of models3d) {
  const [w, h] = sizes[t] || [6, 6];
  for (const scale of [1, 0.4, 2.5]) {   // tiny + huge resizes must not throw
    const chairs = [], g = new Obj(); meshes = 0;
    const ok = kit.buildPremium({ id: 'it-' + t, type: t, x: 10, y: 10, width: w * scale, height: h * scale, rotation: 30, color: '#c2410c', label: t, properties: { seats: 8 } }, chairs, g);
    assert.equal(ok, true, 'premium handles ' + t);
    assert.ok(g.children.length > 0, 'model has parts: ' + t);
    if (t === 'table' || t === 'cocktail' || t === 'longtable' || t === 'headtable') assert.equal(chairs.length, 8, 'chairs ringed for ' + t);
  }
}
assert.equal(kit.buildPremium({ id: 'x', type: 'podium', width: 3, height: 3, properties: {} }, [], new Obj()), false, 'classic types fall through');
console.log('builder-catalogue-complete: ok (' + assets.length + ' items, ' + models3d.size + ' premium models)');
