/* three-boot.js — the ONE place the builder's 3D library is loaded (ES module).
   builder-3d.js (a classic script) does `await import('/three-boot.js?v=N')` on the first 3D / Render
   use, so the 2D builder never downloads three.js. Everything is self-hosted under
   /vendor/three-<ver>/ (scripts/vendor-three.mjs; sha384 of every file in scripts/three-vendor.SHA384SUMS + public/vendor/README.md), so the CSP
   stays script-src 'self' (no CDN, no SRI drift) and no importmap is needed: the vendored addons
   import the core by relative path, so they share this exact module instance.

   It returns one plain (frozen) namespace object shaped like the r128 global build
   (THREE.OrbitControls, THREE.TransformControls, THREE.GLTFLoader, THREE.BufferGeometryUtils.*),
   so the existing `THREE.*` code keeps working; builder-3d.js assigns it to window.THREE.

   Colour pipeline: r128 had no colour management (hex / CSS colours and canvas textures were used
   as-is, output was linear unless Render mode asked for sRGB). Disabling ColorManagement keeps that
   exact look; see THREEJS-UPGRADE-PLAN.md before ever turning it on (every colour would shift). */
import * as NS from './vendor/three-0.186.1/three.module.min.js';
import { OrbitControls } from './vendor/three-0.186.1/addons/controls/OrbitControls.js';
import { TransformControls } from './vendor/three-0.186.1/addons/controls/TransformControls.js';
import { GLTFLoader } from './vendor/three-0.186.1/addons/loaders/GLTFLoader.js';
import * as BufferGeometryUtils from './vendor/three-0.186.1/addons/utils/BufferGeometryUtils.js';

NS.ColorManagement.enabled = false;   // r128 parity: no sRGB→linear conversion of input colours

const THREE = Object.assign({}, NS, { OrbitControls, TransformControls, GLTFLoader, BufferGeometryUtils: Object.assign({}, BufferGeometryUtils) });
// r155+ dropped the "legacy" light units: punctual / hemisphere irradiance is no longer multiplied by π
// inside the shaders. Multiply r128-era intensities by this to keep the same brightness.
THREE.LEGACY_LIGHT_SCALE = Math.PI;
export default Object.freeze(THREE);
