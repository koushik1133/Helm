/* builder-toolbar.test.mjs — toolbar v2: one primary row (event · 2D|3D · Create layout · Render · Layout/View/Share menus ·
   tools · Save/capacity/hall/account), every former control still reachable by id, accessible menus, one floating stack. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const html = rd('public/builder.html'), css = rd('public/builder.css'), js = rd('public/builder.js');
const wt = rd('public/walkthrough.js'), fs = rd('public/fullscreen.js'), st = rd('public/studio-templates.js'), lw = rd('public/layout-wizard.js');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
const section = (id) => { const i = header.indexOf(`id="${id}"`); assert.ok(i > 0, id + ' exists'); return header.slice(i); };
const inMenu = (menu, id) => { const pop = header.slice(header.indexOf(`id="${menu}"`)); const end = pop.indexOf('<div class="tmenu"', 10); return (end > 0 ? pop.slice(0, end) : pop).includes(`id="${id}"`); };

// 1. every former header control is still in the page by id (moved, not recreated)
for (const id of ['toolsToggle', 'inspToggle', 'preset', 'refEvents', 'customBtn', 'unitSel', 'snapBtn', 'gridBtn', 'viewSeg', 'measureBtn',
  'undoBtn', 'redoBtn', 'clearBtn', 'projName', 'quoteBadge', 'verSel', 'designChip', 'backToFlowBtn', 'saveBtn', 'loadBtn', 'clientImgBtn',
  'exportBtn', 'jsonBtn', 'importBtn', 'importFile', 'capInput', 'capMeter', 'capLbl', 'capBanner', 'acctMenu', 'acct', 'themeBtn', 'dimsLabel'])
  ok(header.includes(`id="${id}"`), `${id} is in the toolbar`);
ok(/<button data-v="2d"[^>]*>2D<\/button><button data-v="3d"[^>]*>3D<\/button><button data-v="render"/.test(header), '[2D | 3D] switch + Render (render logic unchanged: still #viewSeg [data-v=render])');

// 2. grouping
for (const id of ['preset', 'refEvents', 'clearBtn']) ok(inMenu('layoutMenu', id), `${id} in Layout ▾`);
for (const id of ['viewMenuSlot', 'unitSel']) ok(inMenu('viewMenu', id), `${id} in View ▾`);
for (const id of ['clientImgBtn', 'loadBtn', 'exportBtn', 'jsonBtn', 'importBtn']) ok(inMenu('shareMenu', id), `${id} in Share ▾`);
ok(/id="clientImgBtn"[^>]*title="Re-take the 2D\/3D pictures used in the client booklet &amp; share link">📸 Refresh client pictures/.test(header), 'Refresh client pictures (same id/handler)');
ok(/id="snapBtn"[^>]*title="Snap to grid — objects line up on the grid when you drag them"/.test(header), 'Snap tooltip explains it');
ok(/id="undoBtn"[^>]*title="Undo \(⌘Z\)"/.test(header) && /id="redoBtn"[^>]*title="Redo \(⌘⇧Z\)"/.test(header), 'undo/redo tooltips');
ok(section('tb-right'.replace(/.*/, 'saveBtn')).includes('id="capInput"'), 'capacity sits right of Save');
ok(/class="capctl"[\s\S]*id="capMeter"[\s\S]*id="capInput"/.test(header), 'seats chip + capacity input merged into one control');
ok(header.includes('id="capBanner"') && !/<\/header>\s*<div class="capbanner"/.test(html), 'over-capacity warning is an inline chip, not an extra row');
ok(/banner\.title=msg/.test(js), 'warning chip carries the full text as a tooltip');
ok(!/id="moreMenu"/.test(html), 'old More ▾ folded into Share ▾');
// injected items land in the menus
ok(/getElementById\('viewMenuSlot'\)[\s\S]*slot\.prepend\(field\)/.test(wt), 'walkthrough / overview / floor plan / evening / labels → View ▾');
ok(/getElementById\('viewMenuSlot'\)[\s\S]*slot\.append\(bHead\)/.test(fs), 'Fullscreen [F] → View ▾');
ok(/insertBefore\(bSave, field\.nextSibling\)/.test(st) && /id: "st_saveBtn", role: "menuitem"/.test(st), 'Save as template / My templates follow the template picker inside Layout ▾');
ok(/querySelector\('\.tl'\)/.test(lw), 'wizard keeps the Create layout icon/label markup');

// 3. menu a11y
for (const m of ['layoutMenu', 'viewMenu', 'shareMenu']) {
  ok(new RegExp(`id="${m}Btn" aria-haspopup="true" aria-expanded="false" aria-controls="${m}"`).test(header), `${m} button a11y attrs`);
  ok(new RegExp(`id="${m}" role="menu" aria-labelledby="${m}Btn" hidden`).test(header), `${m} popup role=menu, hidden by default`);
}
ok(/b\.setAttribute\('aria-expanded','true'\)/.test(js) && /b\.setAttribute\('aria-expanded','false'\)/.test(js), 'aria-expanded kept in sync');
ok(/e\.key==='Escape'[\s\S]{0,80}close\(w,true\)/.test(js), 'Esc closes and returns focus to the button');
ok(/ArrowDown[\s\S]*ArrowUp[\s\S]*Home[\s\S]*End/.test(js), 'arrow / Home / End keys move through items');
ok(/document\.addEventListener\('click',e=>\{ wraps\.forEach\(w=>\{ if\(!w\.contains\(e\.target\)\) close\(w,false\)/.test(js), 'outside click closes');
ok(!/\son[a-z]+="/i.test(header) && !/\sstyle="/i.test(header), 'CSP: no inline handlers / styles in the toolbar');

// 4. responsive + overlap
ok(/@media \(max-width:1280px\)\{ header\.tbar \.tl\{display:none\}/.test(css), '≤1280px labels collapse to icons');
ok(/@media \(max-width:768px\)\{[\s\S]*\.tmenu-pop,\.tmenu-pop\.tm-right\{position:fixed;left:8px;right:8px/.test(css), '≤768px menus open full-width under the bar');
ok(/<div class="fabstack" id="fabStack">\s*<div class="navpad" id="navPad"[\s\S]*<div class="zoombar">/.test(html), 'pan pad + zoom share one floating stack');
ok(/\.fabstack\{position:absolute;right:14px;bottom:14px;z-index:9;display:flex;flex-direction:column;align-items:flex-end;gap:8px/.test(css), 'stack is a flex column with gaps');
ok(/\.fabstack \.zoombar,\.fabstack \.navpad,\.fabstack \.wt-fab,\.fabstack \.fs-fab,\.fabstack \.htour-fab\{position:static!important/.test(css), 'floating controls flow inside the stack (no absolute overlap)');
ok(/stack\.prepend\(fab\)/.test(wt) && /stack\.prepend\(bFab\)/.test(fs) && /stack\.append\(f\)/.test(js), 'walkthrough pill, fullscreen button and Tour pill join the stack');
ok(/\.hau-notes\{bottom:auto!important;top:64px/.test(css), 'trial / profile notices sit away from the canvas controls');
ok(/body\.fs-on header,body\.fs-on #leftPanel,body\.fs-on #rightPanel\{visibility:hidden\}/.test(rd('public/layout-wizard.css')), 'fullscreen still hides the toolbar');
console.log(`  ✓ builder-toolbar: ${n} checks — one row, ids preserved, menus accessible, single floating stack`);
