// Builder header: the owner chose the classic (pre-#109) header back. Guards it and the bits kept from v2.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const html = readFileSync('public/builder.html', 'utf8');
const css = readFileSync('public/builder.css', 'utf8');
const head = (html.match(/<header[\s\S]*?<\/header>/) || [''])[0];
assert.match(head, /id="viewSeg"[\s\S]*data-v="2d"[\s\S]*data-v="3d"/, '2D Plan / 3D View switch in the header');
assert.match(head, /id="preset"/, 'template dropdown in the header');
assert.match(head, /id="customBtn"/, 'Create layout in the header');
assert.ok(!/id="layoutMenu"|id="viewMenu"|id="shareMenu"/.test(head), 'no v2 dropdown menus');
assert.match(html, /<\/header>\s*<div class="capbanner" id="capBanner"/, 'capacity banner right under the header');
assert.match(head, /id="projNameHint"/, 'name hint element kept for the JS');
assert.match(css, /#projNameHint\{display:none!important\}/, 'auto-name hint never shown');
assert.match(html, /id="fabStack"/, 'canvas control stack kept');
console.log('builder-toolbar: ok');
// toolbox: "Entrance" tool = an exit-type marker labelled Entrance (walkthrough uses it as an entry point)
const bjs = readFileSync('public/builder.js', 'utf8');
assert.match(bjs, /type==='exit'\?\[\[type,a,'Entrance'\],\[type,a,null\]\]/, 'Entrance tool next to Exit Zone');
assert.match(bjs, /addAsset\(ty, null, t\.dataset\.label \? \{label:t\.dataset\.label\} : undefined\)/, 'click adds with the Entrance label');
assert.match(bjs, /getData\('label'\); addAsset\(type, svgPointFt\(e\), vl/, 'drag-drop keeps the label');
console.log('builder-toolbar entrance: ok');
