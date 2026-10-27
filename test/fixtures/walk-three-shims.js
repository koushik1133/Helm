/* walk-three-shims.js — test fixture for test/walkaround-visual.harness.mjs ONLY (never served to users).
 * Harness-only shims for the three r128 "examples/js" add-ons the builder lazy-loads from jsDelivr.
 * The harness blocks every non-localhost request and no local copy of examples/js@0.128.0 exists, so
 * THREE (the real, SRI-identical r128 three.min.js) is preloaded by an init script and these stand-ins
 * are defined next to it. builder-3d.js's ensure3DLibs() then short-circuits (typeof THREE !== 'undefined').
 *
 * OrbitControls.update() reproduces r128's math exactly for the zero-input case the walkthrough uses
 * (offset -> spherical, clamp phi to [minPolar,maxPolar], makeSafe, clamp radius to [minD,maxD],
 * position = target + offset, camera.lookAt(target)). No mouse handling: the harness never drags.
 * Each stand-in is only defined when the preloaded three build does not already provide it, so a later
 * three.js upgrade (with the real add-ons served locally) needs no change here. The harness reads the live
 * camera / scene through window.__helm3D.inspect() (test-only, behind window.__HELM_WALK_TEST__).
 */
(function () {
  if (typeof THREE === 'undefined') return;
  const T = THREE;

  function OrbitControls(object, domElement) {
    this.object = object; this.domElement = domElement;
    this.enabled = true; this.target = new T.Vector3();
    this.minDistance = 0; this.maxDistance = Infinity; this.minZoom = 0; this.maxZoom = Infinity;
    this.minPolarAngle = 0; this.maxPolarAngle = Math.PI; this.minAzimuthAngle = -Infinity; this.maxAzimuthAngle = Infinity;
    this.enableDamping = false; this.dampingFactor = 0.05; this.enableZoom = true; this.zoomSpeed = 1;
    this.enableRotate = true; this.rotateSpeed = 1; this.enablePan = true; this.panSpeed = 1; this.screenSpacePanning = true;
    this.keyPanSpeed = 7; this.autoRotate = false; this.autoRotateSpeed = 2; this.enableKeys = true;
    this.keys = { LEFT: 'ArrowLeft', UP: 'ArrowUp', RIGHT: 'ArrowRight', BOTTOM: 'ArrowDown' };
    this.mouseButtons = { LEFT: T.MOUSE.ROTATE, MIDDLE: T.MOUSE.DOLLY, RIGHT: T.MOUSE.PAN };
    this.touches = { ONE: T.TOUCH.ROTATE, TWO: T.TOUCH.DOLLY_PAN };
    const scope = this, offset = new T.Vector3(), spherical = new T.Spherical(), EPS = 1e-6;
    const quat = new T.Quaternion().setFromUnitVectors(object.up, new T.Vector3(0, 1, 0)), quatInverse = quat.clone().invert();
    const lastPosition = new T.Vector3(), lastQuaternion = new T.Quaternion();
    this.getPolarAngle = () => spherical.phi; this.getAzimuthalAngle = () => spherical.theta;
    this.saveState = () => {}; this.reset = () => {}; this.dispose = () => {}; this.listenToKeyEvents = () => {};
    this.update = function () {
      const position = scope.object.position;
      offset.copy(position).sub(scope.target); offset.applyQuaternion(quat);
      spherical.setFromVector3(offset);
      let min = scope.minAzimuthAngle, max = scope.maxAzimuthAngle;
      if (isFinite(min) && isFinite(max)) spherical.theta = Math.max(min, Math.min(max, spherical.theta));
      spherical.phi = Math.max(scope.minPolarAngle, Math.min(scope.maxPolarAngle, spherical.phi));
      spherical.makeSafe();
      spherical.radius = Math.max(scope.minDistance, Math.min(scope.maxDistance, spherical.radius));
      offset.setFromSpherical(spherical); offset.applyQuaternion(quatInverse);
      position.copy(scope.target).add(offset);
      scope.object.lookAt(scope.target);
      if (lastPosition.distanceToSquared(scope.object.position) > EPS || 8 * (1 - lastQuaternion.dot(scope.object.quaternion)) > EPS) {
        scope.dispatchEvent({ type: 'change' }); lastPosition.copy(scope.object.position); lastQuaternion.copy(scope.object.quaternion); return true;
      }
      return false;
    };
    this.update();
  }
  OrbitControls.prototype = Object.create(T.EventDispatcher.prototype); OrbitControls.prototype.constructor = OrbitControls;
  if (!T.OrbitControls) T.OrbitControls = OrbitControls;

  class TransformControls extends T.Object3D {
    constructor(camera, dom) { super(); this.camera = camera; this.domElement = dom; this.object = undefined; this.dragging = false; this.mode = 'translate';
      this.showX = this.showY = this.showZ = true; this.translationSnap = null; this.rotationSnap = null; this.size = 1; this.visible = false; }
    attach(o) { this.object = o; this.visible = true; return this; }
    detach() { this.object = undefined; this.visible = false; return this; }
    setMode(m) { this.mode = m; } setSize(s) { this.size = s; } setSpace() {} setTranslationSnap(v) { this.translationSnap = v; } setRotationSnap(v) { this.rotationSnap = v; }
    dispose() {}
  }
  if (!T.TransformControls) T.TransformControls = TransformControls;

  function mergeBufferGeometries(geos) {
    if (!geos || !geos.length) return null;
    const indexed = geos[0].index !== null;
    const list = geos.map((g) => (indexed === (g.index !== null) ? g : (g.index ? g.toNonIndexed() : g)));
    const allIdx = list.every((g) => g.index !== null), names = Object.keys(list[0].attributes);
    for (const g of list) for (const n of names) if (!g.attributes[n]) return null;
    const out = new T.BufferGeometry();
    for (const n of names) {
      const a0 = list[0].attributes[n], Ctor = a0.array.constructor; let len = 0;
      for (const g of list) len += g.attributes[n].count * a0.itemSize;
      const arr = new Ctor(len); let off = 0;
      for (const g of list) { const a = g.attributes[n]; for (let i = 0; i < a.count; i++) for (let k = 0; k < a0.itemSize; k++) arr[off + i * a0.itemSize + k] = a.array[i * a.itemSize + k]; off += a.count * a0.itemSize; }
      out.setAttribute(n, new T.BufferAttribute(arr, a0.itemSize, a0.normalized));
    }
    if (allIdx) {
      const idx = []; let base = 0;
      for (const g of list) { const ia = g.index.array; for (let i = 0; i < ia.length; i++) idx.push(ia[i] + base); base += g.attributes.position.count; }
      out.setIndex(idx);
    }
    return out;
  }
  if (!T.BufferGeometryUtils) T.BufferGeometryUtils = { mergeBufferGeometries };

  function GLTFLoader() {}
  GLTFLoader.prototype.load = function (url, ok, prog, err) { if (err) setTimeout(() => err(new Error('GLTF disabled in harness')), 0); };
  GLTFLoader.prototype.setDRACOLoader = function () { return this; };
  if (!T.GLTFLoader) T.GLTFLoader = GLTFLoader;

})();
