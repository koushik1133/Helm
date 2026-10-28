// Builder round 20 (fix/r20-builder-owner) - owner feedback from the live free trial:
//   1  the r19 two-row builder header is reverted to the earlier one-row header; Render is visible again, also in the
//      free trial (it opens the realistic 3D look; the AI photo dialog stays a paid-plan feature, the server refuses it)
//   2  "Client images" is hidden in the free trial (click guard: "Available on a paid plan"); saved client images are untouched
//   3  H = home (the dashboard) in the app shell and the builder; the tours say so and point at the hide controls
//   4  live QA: a "?" tour button in the top bar; tour targets inside a scrolled sidebar are scrolled fully into view;
//      the dashboard tour no longer names a Reports item; the builder tour works on the studio pretty URL
//      (/<studio>/events/<id>/floor-plan); template loads are single-flight; the auto default floor of a brand-new
//      quote reads "Unsaved changes" (V1 is still empty); the 3D Floor plan camera frames the hall clear of the bars
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL', name); throw e; } };

const html = read('public/builder.html'), cap = read('public/capture.html'), css = read('public/builder.css'), js = read('public/builder.js');
const head = (html.match(/<header[\s\S]*?<\/header>/) || [''])[0];
// the header ids before r19 (git show 20077e7e^:public/builder.html), in order
const OLD_IDS = ["toolsToggle", "inspToggle", "preset", "refEvents", "customBtn", "unitSel", "gridLbl", "snapBtn", "gridBtn", "viewLbl", "viewSeg", "workLbl", "measureBtn", "undoBtn", "redoBtn", "clearBtn", "projName", "projNameHint", "projNameHintText", "projNameReset", "saveState", "quoteBadge", "verSel", "designChip", "backToFlowBtn", "saveBtn", "loadBtn", "clientImgBtn", "moreMenu", "exportBtn", "jsonBtn", "importBtn", "importFile", "capInput", "capMeter", "capLbl", "acctMenu", "acct", "themeBtn", "dimsLabel"];

/* ---------------- 1) the header ---------------- */
t('header: the one-row header from before r19 is back (same controls in the same order)', () => {
  assert.match(head, /^<header>/);
  assert.ok(!/class="hrow|hr19/.test(head + css), 'no r19 two-row markup / CSS');
  const ids = (h) => [...h.matchAll(/\sid="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids(head), OLD_IDS.flatMap((id) => (id === 'refEvents' ? ['refField', 'refEvents'] : [id])), 'same controls, same order (+ the trial-hidden Past events field id)');
  assert.ok(head.indexOf('id="preset"') < head.indexOf('id="viewSeg"') && head.indexOf('id="viewSeg"') < head.indexOf('id="undoBtn"')
    && head.indexOf('id="undoBtn"') < head.indexOf('id="projName"') && head.indexOf('id="projName"') < head.indexOf('id="capInput"'), 'left to right');
  assert.match(head, /<div class="seg" id="viewSeg"[^>]*><button data-v="2d"[^>]*>2D Plan<\/button><button data-v="3d"[^>]*>3D View<\/button><button data-v="render"[^>]*>✦ Render<\/button><\/div>/);
  assert.match(head, /id="undoBtn"[^>]*><svg viewBox="0 0 16 16"/, 'kept from r19: undo / redo icons (the arrow glyphs were missing from the font)');
  assert.match(css, /#refField\[hidden\],html\.helm-trial #refField\{display:none\}/, 'kept from r19: no separate past-layout picker in the trial');
  assert.equal((cap.match(/<header[\s\S]*?<\/header>/) || [''])[0], head, 'capture.html is generated from builder.html');
});
t('kept from r19: floor coverings painted first, the view dock under the plan, the first-run tour', () => {
  assert.match(js, /drawOrder2D\(store\.items\)\.forEach\(it=> svg\.appendChild\(renderItem\(it\)\)\)/);
  assert.match(js, /\(function wireViewDock\(\)\{/);
  assert.match(html, /<div class="fabstack" id="fabStack" role="toolbar" aria-label="View controls">/);
  assert.match(js, /scheduleBuilderTour\(\); \/\/ r19: first visit only/);
});

/* ---------------- 1b) Render in the free trial ---------------- */
t('free trial: Render is visible and opens the realistic 3D look; the AI photo dialog stays off', () => {
  const tlc = read('public/trial-lock.css'), tlj = read('public/trial-lock.js'), ui = read('public/photo-render-ui.js');
  assert.ok(!tlc.includes('#viewSeg [data-v="render"]'), 'not hidden');
  assert.ok(!tlj.includes('#viewSeg [data-v="render"]'), 'its click is not swallowed');
  assert.match(tlc, /html\.helm-trial #photoModal,/, 'the AI photo dialog stays hidden in the trial');
  assert.match(ui, /function open\(\) \{\n    if \(inTrial\(\)\) \{ toast\(TRIAL_MSG, \{ type: 'info', timeout: 5000 \}\); return; \}/, 'open() never shows the dialog in the trial');
  assert.match(ui, /AI photos of the plan come with a paid plan/);
  assert.match(ui, /HelmTrialLock\.isTrial\(\)\) return true; return document\.documentElement\.classList\.contains\('helm-trial'\);/);
  // the server keeps refusing photo renders for a trial studio (0173 wrapper)
  assert.match(read('supabase/migrations/0173_trial_lockdown.sql'), /'public\.photo_render_begin\(uuid,integer,text,text,text,numeric\)'\] loop/);
});

/* ---------------- 2) Client images in the free trial ---------------- */
t('free trial: Client images is hidden (click guard: "Available on a paid plan"); nothing is captured or removed', () => {
  assert.match(js, /function builderInTrial\(\)\{ try\{ if\(window\.HelmTrialLock && HelmTrialLock\.isTrial && HelmTrialLock\.isTrial\(\)\) return true; return document\.documentElement\.classList\.contains\('helm-trial'\); \}catch\(_\)\{ return false; \} \}/);
  assert.match(js, /if\(off\)\{ cb\.setAttribute\('aria-disabled','true'\); cb\.title='Available on a paid plan'; cb\.classList\.add\('trial-off'\); \}/);
  assert.match(js, /\$\('#clientImgBtn'\)\.addEventListener\('click',\(\)=>\{\n  if\(builderInTrial\(\)\)\{ syncClientImgTrial\(\); BPUI\.toast\('Client images are available on a paid plan\.',\{type:'info'\}\); return; \}/, 'the click does nothing else in the trial');
  assert.match(js, /cb\.hidden=!clientImagesSupported\(\); syncClientImgTrial\(\);/);
  assert.match(js, /new MutationObserver\(syncClientImgTrial\)\.observe\(document\.documentElement,\{attributes:true, attributeFilter:\['class'\]\}\)/, 'follows the server answer / an upgrade');
  assert.match(css, /header #clientImgBtn\.trial-off,html\.helm-trial header #clientImgBtn\{display:none!important\}/, 'hidden in the trial');
  const seg = js.slice(js.indexOf('function syncClientImgTrial'), js.indexOf('function clientImagesSupported'));
  assert.ok(!/putImage|delete|remove\(/.test(seg.replace(/removeAttribute|classList\.remove/g, '')), 'no image write / delete');
});

/* ---------------- 3) H = home + tours ---------------- */
t('H goes home: app shell (not while typing / in a dialog / with a modifier) and the builder', () => {
  const sh = read('public/shell-b.js');
  const sc = sh.slice(sh.indexOf('function shortcuts()'), sh.indexOf('/* add-on modules'));
  assert.match(sc, /if \(e\.defaultPrevented \|\| e\.metaKey \|\| e\.ctrlKey \|\| e\.altKey \|\| e\.isComposing\) return;\n\s*if \(typing\(e\.target\) \|\| modalOpen\(\)\)/);
  assert.match(sc, /if \(k === "h" && !e\.shiftKey\) \{ e\.preventDefault\(\); if \(!\/\^dashboard\(\\\.html\)\?\$\/\.test\(page\)\) location\.href = abs\("dashboard\.html"\); return; \}/);
  assert.ok(sc.indexOf('k === "h"') > sc.indexOf('if (gAt && Date.now() - gAt < 1500)'), 'G then H is not hijacked');
  assert.match(sh, /function typing\(t\) \{[\s\S]{0,140}tag === "INPUT" \|\| tag === "TEXTAREA" \|\| tag === "SELECT" \|\| !!t\.isContentEditable;/);
  assert.match(sh, /\["Navigate", \[\["H", "Go home \(Dashboard\)"\]\]\.concat\(go\)\]/, 'listed on the ? shortcuts sheet');
  assert.match(js, /if\(\(e\.key==='h'\|\|e\.key==='H'\) && !e\.metaKey && !e\.ctrlKey && !e\.altKey && !e\.shiftKey && !e\.isComposing && !e\.repeat\)\{/);
  assert.match(js, /const isTyping=n=>!!\(n && \(\(n\.tagName && \/INPUT\|SELECT\|TEXTAREA\/\.test\(n\.tagName\)\) \|\| n\.isContentEditable\)\);/);
  assert.match(js, /if\(!isTyping\(t\) && !isTyping\(ae\) && !document\.body\.classList\.contains\('wt-on'\)\)\{ e\.preventDefault\(\); location\.href='\/dashboard\.html'; return; \}/);
  // after the "a dialog owns the keyboard" check
  const kb = js.slice(js.indexOf("window.addEventListener('keydown',e=>{\n  // a dialog owns the keyboard"));
  assert.ok(kb.indexOf('if(anyModalOpen()) return;') < kb.indexOf("e.key==='h'"));
});
t('tours: H and the hide controls are explained (dashboard, shell, builder)', () => {
  const D = read('public/dashboard.html'), sh = read('public/shell-b.js'), tour = read('public/tour.js');
  assert.match(D, /title:"Dashboard", desc:"[^"]*or press H on your keyboard \(when you are not typing\)\."/);
  assert.match(D, /title:"Keep the sidebar open", desc:"The sidebar tucks away/, 'hide: the sidebar');
  assert.match(D, /title:"Hide the money"/, 'hide: amounts');
  assert.match(D, /tap the eye on a card to hide it/, 'hide: dashboard cards');
  assert.match(sh, /Press H \(when you are not typing\) to jump home to the dashboard\./);
  const pt = read('public/page-tours.js');   // R46: the steps live in page-tours.js
  const blk = pt.slice(pt.indexOf('"builder.html": ['), pt.indexOf('"quotes.html": ['));
  assert.match(blk, /\{ sel: "header \.brand", title: "Back home", desc: "[^"]*press H \(when you are not typing\) to jump home to the dashboard/);
  assert.match(blk, /To hide them, press the down arrow \(⌄\); the small “⊕ View” button brings them back\./, 'hide: the view dock');
  assert.match(blk, /title: "Hide amounts"/);
  assert.match(blk, /\{ sel: "#clientImgBtn", trial: false,/, 'the trial-hidden button is not toured');
  assert.match(blk, /get desc\(\) \{ return inTrial\(\)\n\s*\? "[^"]*AI photos of the plan come with a paid plan\."/, 'Render step says what the trial gets');
  // every builder tour target exists on the page
  for (const m of blk.matchAll(/sel: (\[[^\]]*\]|"[^"]*")/g)) {
    const first = JSON.parse(m[1].startsWith('[') ? m[1] : '[' + m[1] + ']')[0];
    const id = /#([\w-]+)/.exec(first), cls = /\.([\w-]+)/.exec(first);
    if (first === '.wt-field' || first === '#wtStart' || first.startsWith('.bp-priv-slot')) continue;   // mounted at runtime (walkthrough.js / shell-b-privacy.js)
    assert.ok(id ? html.includes('id="' + id[1] + '"') : html.includes(cls[1]), 'target on the page: ' + first);
  }
});

/* ---------------- 4) live QA ---------------- */
t('tour is easy to find: a "?" button in the top bar (desktop) whose menu starts the same tour as the rail button', () => {
  const sh = read('public/shell-b.js'), sc = read('public/shell-b.css');
  // R46: the "?" opens the shared help menu; its "Tour this page" item runs startTour (same as the rail button)
  assert.match(sh, /var tourTop = el\("button", "hb-ibtn hb-ttour"\); tourTop\.type = "button"; tourTop\.title = "Help: tour this page, keyboard shortcuts";/);
  assert.match(sh, /safe\(function \(\) \{ helpMenu\(helpWrap, tourTop\); \}\);\n\s*tools\.insertBefore\(helpWrap, bellSlot\);/);
  assert.match(sh, /tourMi\.addEventListener\("click", function \(\) \{ close\(true\); safe\(startTour\); \}\);/);
  assert.match(sc, /@media \(max-width: 819px\) \{ html\[data-shell="b"\] \.hb-ttour \{ display: none !important; \} \}/);
  const D = read('public/dashboard.html');
  assert.match(D, /Click the \? button in the top bar and pick “Tour this page”, or “Tour this page” in the sidebar/);
  assert.match(D, /title:"Admin & Control Center", desc:"Business shows your money and Insights your numbers\./, 'no Reports item named');
});
t('tour: a target clipped inside a scrolled box is brought fully into it before the ring is drawn', () => {
  const tour = read('public/tour.js');
  assert.match(tour, /function revealInScroller\(t\) \{/);
  assert.match(tour, /if \(tgt\) \{\n\s*revealInScroller\(tgt\);\n\s*\/\/ Scroll the target into view BEFORE measuring/);
  // behaviour: a sidebar list scrolled 300px down, the Dashboard item at its top shows only an 18px sliver
  const box = { scrollTop: 300, scrollHeight: 900, clientHeight: 400, parentElement: null, getBoundingClientRect: () => ({ top: 100, bottom: 500, height: 400 }) };
  const item = { parentElement: box, getBoundingClientRect: () => ({ top: 82 + (300 - box.scrollTop), bottom: 118 + (300 - box.scrollTop), height: 36 }) };
  const fn = tour.slice(tour.indexOf('function revealInScroller'), tour.indexOf('  function place()'));
  const cx = { document: { body: {}, documentElement: {} }, getComputedStyle: (a) => ({ overflowY: a === box ? 'auto' : 'visible' }) };
  vm.runInNewContext(fn + '\nrevealInScroller(item);', Object.assign(cx, { item }));
  assert.equal(box.scrollTop, 270, 'scrolled up so the whole item (+12px) is inside the list');
});
t('builder tour on the studio pretty URL: the page key comes from HelmUrl (floor-plan -> builder)', () => {
  const tour = read('public/tour.js');
  assert.match(tour, /routed = H && typeof H\.route === "function" && H\.route\(\) && typeof H\.page === "function" \? H\.page\(\) : null;/);
  assert.match(tour, /const base = \(routed \|\| location\.pathname\.split\("\/"\)\.pop\(\) \|\| "index"\)/);
  assert.match(read('public/store-api.js'), /"floor-plan": \["events", "floor-plan", "builder", "quote"\]/);
  const hi = html.indexOf('store-api.js?v='), ti = html.indexOf('tour.js?v=');
  assert.ok(hi > 0 && ti > hi, 'store-api.js (HelmUrl) loads before tour.js on the builder');
  assert.match(js, /const BUILDER_TOUR_SEEN='helm_tour_seen_builder';/, 'same key the engine writes for page "builder"');
});
t('template loads are single-flight: a stale pending load is dropped, a slow one says "Loading"', () => {
  const st = read('public/studio-templates.js');
  assert.match(st, /var seq = G\.__helmTplLoad = \(G\.__helmTplLoad \|\| 0\) \+ 1;\n\s*var live = function \(\) \{ return G\.__helmTplLoad === seq; \};/);
  assert.match(st, /clearTimeout\(slow\);\n\s*if \(!live\(\)\) return;/, 'after the read');
  assert.match(st, /if \(fitChoice === "cancel" \|\| !live\(\)\) return;/, 'after the fit question');
  assert.match(st, /toast\("Loading the template…"\)/);
  assert.match(js, /const tplSeq=window\.__helmTplLoad=\(window\.__helmTplLoad\|\|0\)\+1;/, 'built-in / past-event picks make pending loads stale');
  assert.match(js, /if\(fitChoice==='cancel' \|\| window\.__helmTplLoad!==tplSeq\) return;/);
});
t('a brand-new quote\'s auto default floor reads "Unsaved changes" (nothing written by itself)', () => {
  assert.match(js, /_autoDefaultLoaded=true;\n\s*toast\('Loaded a default '\+\(q\.eventType\|\|''\)\+' layout — not saved yet, press Save to keep it'\);[\s\S]{0,500}resetHistory\(\); markGenUnsaved\(\); renderAll\(\);/);
  assert.match(js, /function scheduleAutosave\(\)\{\n\s*if\(RO \|\| !currentLayoutId\) return;/, 'a quote never autosaves');
});
t('3D Floor plan camera: the hall fits the clear band between the Move/Rotate/Scale bar and the hint bar', () => {
  const cx = { window: {}, console }; cx.window = cx; vm.createContext(cx);
  vm.runInContext(read('public/walkthrough.js'), cx);
  const TD = cx.HelmWalkthrough.topDown, fov = 48, tanV = Math.tan(fov * Math.PI / 360);
  assert.deepEqual(JSON.parse(JSON.stringify(TD({ w: 200, h: 140 }))), { pos: [0, 210, 0.01], target: [0, 0, 0] }, 'no view: as before');
  const hall = { w: 170, h: 150 }, v = { aspect: 1.6, fovDeg: fov, top: 0.1, bottom: 0.08, side: 0.02 };
  const r = TD(hall, v), d = r.pos[1];
  const halfH = d * tanV, halfW = halfH * v.aspect;
  // the hall's far / near edges on screen, as fractions of the height from the top (target shifted toward -z)
  const cz = r.target[2], yFar = 0.5 - ((cz - (-hall.h / 2)) / (2 * halfH)), yNear = 0.5 + ((hall.h / 2 - cz) / (2 * halfH));
  assert.ok(yFar >= v.top - 1e-9, 'far edge below the top bar ' + yFar);
  assert.ok(yNear <= 1 - v.bottom + 1e-9, 'near edge above the hint bar ' + yNear);
  assert.ok(hall.w / 2 <= halfW * (1 - 2 * v.side) + 1e-6, 'width fits');
  assert.ok(r.target[2] < 0 && Math.abs(r.pos[2] - r.target[2] - 0.01) < 0.011, 'camera straight above its target');
  const wt = read('public/walkthrough.js');
  assert.match(wt, /else if \(kind === 'top'\) fly\(Object\.assign\(\{ fov: OVERVIEW_FOV \}, topDown\(hall, topDownView\(v0\)\)\)\);/);
  assert.match(wt, /top: cover\('tools3d', 'top'\), bottom: cover\('hint3d', 'bottom'\)/);
});

console.log(`r20-builder: ${n} checks passed`);
