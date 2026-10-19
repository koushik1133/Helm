// stage-strip-scroll.test.mjs - owner screenshot 18 Oct 2026 (event 10182026-01, Planning, viewing Settlement):
// the stage strip scrolled sideways with "Lead" cut off and no cue that more stages exist, the viewed stage was
// off-screen, the header scrolled away, "Move event to Settlement" was clickable although the date had not
// arrived, and "Record advance" showed although an advance was in.
// Source checks on event.html / event-polish.css + the old-database gate fallback run in a vm sandbox.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const EV = read('public/event.html'), CSS = read('public/event-polish.css');
const tests = [];
const t = (name, fn) => tests.push([name, fn]);

t('strip: both strips (card + compact sticky) are painted from one function and re-centred after a stage change', () => {
  assert.match(EV, /paintStrip\(\$\("#steps"\),cur,vis\); paintStrip\(\$\("#stepsMini"\),cur,vis\);/);
  // a re-paint resets the scroll: it is restored first, then the strip glides to the current / viewed stage
  assert.match(EV, /st\.scrollLeft=keep;/);
  assert.match(EV, /if\(first \|\| st\.dataset\.tk!==tk\)\{ st\.dataset\.tk=tk; centerStrip\(st, !first\); \}/);
  assert.match(EV, /const on=st\.querySelector\('\.step\[aria-pressed="true"\]'\)\|\|st\.querySelector\('\.step\[aria-current="step"\]'\);/);
  assert.match(EV, /on\.offsetLeft-\(st\.clientWidth-on\.offsetWidth\)\/2/);
  // the old "nudge 24px if off-screen" scroll is gone
  assert.doesNotMatch(EV, /st\.scrollLeft\+=r\.left-c\.left-24/);
});

t('strip: the viewed stage is outlined + tagged "Viewing", distinct from the filled current stage', () => {
  assert.match(EV, /\(viewing\?" viewing":""\)/);
  assert.match(EV, /viewing\?el\("span",\{class:"vtag",text:"Viewing"\}\):null/);
  assert.match(CSS, /html\[data-theme\] \.steps \.step\.viewing\{background:var\(--panel\);border:2px solid var\(--accent\)/);
  // the panel says which stage it belongs to and where the event really is
  assert.match(EV, /el\("span",\{class:"sp-eye",text:"Viewing"\}\)/);
  assert.match(EV, /text:"The event is at "\+stageLabel\(STAGES\[cur\]\)/);
});

t('strip: edge fades + arrow buttons when it overflows, keyboard accessible, nothing clipped', () => {
  for (const id of ['stepWrap', 'evStickIn']) assert.ok(EV.includes(`id="${id}"`), id);
  assert.equal((EV.match(/<button type="button" class="stp-arr l" aria-label="Show earlier stages" hidden>/g) || []).length, 2);
  assert.equal((EV.match(/<button type="button" class="stp-arr r" aria-label="Show later stages" hidden>/g) || []).length, 2);
  assert.match(EV, /w\.classList\.toggle\("ov-l",l\); w\.classList\.toggle\("ov-r",r\);/);
  assert.match(EV, /st\.addEventListener\("scroll",upd,\{passive:true\}\)/);
  assert.match(EV, /e\.key==="ArrowRight"\?i\+1:e\.key==="ArrowLeft"\?i-1:e\.key==="Home"\?0:e\.key==="End"/);
  // a hidden arrow never strands keyboard focus
  assert.match(EV, /if\(!on && document\.activeElement===b\)/);
  assert.match(CSS, /\.stepwrap\.ov-l \.steps\{-webkit-mask-image:linear-gradient\(to right,transparent 0,#000 44px\)/);
  assert.match(CSS, /\.stepwrap \.steps\{position:relative;margin-top:0;padding:5px 6px 7px;scroll-padding-inline:40px/);
  assert.match(CSS, /\.stp-arr:focus-visible\{outline:2px solid var\(--accent\)/);
  assert.match(CSS, /prefers-reduced-motion:reduce\)\{\.evstick-in\{animation:none\}\}/);
  assert.match(EV, /behavior:\(smooth&&!reduceMotion\(\)\)\?"smooth":"auto"/);
});

t('sticky: compact header + strip under the app top bar on desktop only', () => {
  assert.match(CSS, /\.evstick\{position:sticky;top:var\(--hb-top,0px\);height:0;z-index:700\}/);
  assert.match(CSS, /@media \(max-width:899px\)\{\.evstick\{display:none!important\}\}/);
  assert.match(EV, /const wide=matchMedia\("\(min-width: 900px\)"\);/);
  assert.match(EV, /new IntersectionObserver\(/);
  assert.match(EV, /past=!e\.isIntersecting && r\.height>0 && r\.bottom<=topPx\(\)\+1/);
  assert.match(EV, /n\.textContent="Now: "\+stageLabel\(STAGES\[cur\]\)\+\(vis!==cur\?" · viewing "/);
  assert.match(CSS, /#stagePanel\{scroll-margin-top:calc\(var\(--hb-top,0px\) \+ 110px\)\}/);
});

t('move: always shown, DISABLED with the reason when a gate blocks it; admins get a separate override', () => {
  assert.match(EV, /disabled:blocked\|\|loading\|\|stageBusy, "aria-describedby":\(blocked\|\|loading\)\?whyId:null/);
  assert.match(EV, /list==null \? localStageGates\(s\.k\) : list/);
  assert.match(EV, /if\(blocked && !hard\.length\)\{/);
  assert.match(EV, /text:"Override as admin…"/);
  assert.doesNotMatch(EV, /Move anyway \(admin\)/);
});

// run localStageGates (old database without lifecycle_stage_blockers) on the owner's case
function gates(ev, planSummary, today) {
  const a = EV.indexOf('  function localStageGates(k){'), b = EV.indexOf('  const infoKey=');
  assert.ok(a > 0 && b > a, 'localStageGates source');
  const stg = EV.slice(EV.indexOf('  const STAGES=['), EV.indexOf('  const stageIndex='));
  const ctx = { ev, planSummary, BPStore: { todayLocal: () => today }, niceDay: (d) => 'D' + d };
  vm.createContext(ctx);
  vm.runInContext(stg.replace('const STAGES', 'var STAGES') + '\nvar stageIndex=(k)=>Math.max(0,STAGES.findIndex(s=>s.k===k));\n' + EV.slice(a, b) + '\nthis.f=localStageGates;', ctx);
  return (k) => JSON.parse(JSON.stringify(ctx.f(k)));
}
t('old database: Planning -> Settlement before the event date is blocked (date not arrived)', () => {
  const g = gates({ lifecycleStage: 'planning', eventDate: '2026-11-07' }, { menu_locked: true }, '2026-10-18');
  assert.deepEqual(g('settlement').map((x) => x.gate), ['settlement']);
  assert.match(g('settlement')[0].message, /has not arrived/);
  assert.deepEqual(g('event_day').map((x) => x.gate), ['event_day']);
  assert.deepEqual(g('resources'), []);
  assert.deepEqual(g('confirmed'), []);   // backward: no forward gate
  const after = gates({ lifecycleStage: 'planning', eventDate: '2026-11-07' }, null, '2026-11-08');
  assert.deepEqual(after('settlement'), []);
  const nodate = gates({ lifecycleStage: 'event_day', eventDate: null }, null, '2026-10-18');
  assert.match(nodate('settlement')[0].message, /no date/);
  const menu = gates({ lifecycleStage: 'confirmed', eventDate: '2026-11-07' }, { menu_locked: false }, '2026-10-18');
  assert.deepEqual(menu('planning').map((x) => x.message), ['Planning needs: menu locked']);
});

t('advance: an advance already in reads "Advance recorded ₹X — record another payment", never "Record advance" again', () => {
  assert.match(EV, /BPStore\.milestones\.payments\(id\)/);
  assert.match(EV, /Number\(paidSoFar\)>0/);
  assert.match(EV, /return "Advance recorded"\+\(canFin&&amt>0\?" "\+inr\(amt\):""\)\+" — record another payment";/);
  assert.match(EV, /id="nextPayBtn"/);
  assert.match(EV, /\[advanceIn\(\)\?advanceDoneLabel\(\):"Record advance","flow\.html\?quote="\+q\+"#sec-pay"\]/);
  // no flash of "Record advance" while payments are still loading
  assert.match(EV, /if\(!sumsLoaded\)\{ bar\.hidden=true; return false; \}/);
  assert.match(EV, /sumsLoaded=true;\s*render\(\);/);
});

t('pins: event.html loads event-polish.css v3', () => {
  assert.match(EV, /href="\/event-polish\.css\?v=8"/);
});

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + ': ' + (e && e.stack || e)); }
}
console.log(`\nstage-strip-scroll: ${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
