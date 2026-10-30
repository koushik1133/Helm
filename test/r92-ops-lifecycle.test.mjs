// R92 Ops: Live status filter + mobile/tablet CSS + locked Reassign + task lifecycle migration 0311.
//   1 filter bar markup + re-applied after every renderDashboard (incl. the no-tasks early return)
//   2 filter behaviour (run in a vm): search / person / section / status / QC pending; rows + empty groups hidden by
//     class, group counts updated, per-event localStorage (broken storage tolerated), Clear restores
//   3 locked Reassign (accepted / in progress / completed) + QC buttons only for completed + pending
//   4 no inline style on the suggestion buttons; CSS: pointer:coarse 44px + 16px inputs, tablet block, crew-shifts, work.html
//   5 work.html / runsheet: no Reject / Accept once answered; refused answers shown as-is (store-api taskAnswer)
//   6 migration 0311 + APPLY + MANIFEST + run-all + page tour
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL ' + name); throw e; } };
const ops = read('public/ops.html'), work = read('public/work.html'), rs = read('public/runsheet.html'), api = read('public/store-api.js');

await t('1 filter bar + re-apply after render', async () => {
  for (const id of ['opsFilter', 'of_q', 'of_person', 'of_section', 'of_status', 'of_clear']) assert.ok(ops.includes(`id="${id}"`), id);
  const body = ops.slice(ops.indexOf('function renderDashboard(){'), ops.indexOf('/* r92: Live status filter - '));
  assert.match(body, /Pick a section above[^\n]*applyOpsFilter\(\); return; \}/, 'early return re-applies');
  assert.match(body, /applyOpsFilter\(\);\n  \}\n\s*$/, 'end of render re-applies');
});

// ---- tiny DOM for the filter block ----
class Cls { constructor() { this.s = new Set(); } toggle(c, on) { on ? this.s.add(c) : this.s.delete(c); } contains(c) { return this.s.has(c); } }
class E {
  constructor(tag) { this.tag = tag; this.classList = new Cls(); this.dataset = {}; this.children = []; this.value = ''; this.hidden = false; this.disabled = false; this._t = ''; this.id = ''; this.ls = {}; }
  set textContent(v) { this._t = String(v); this.children = []; } get textContent() { return this._t; }
  appendChild(c) { this.children.push(c); return c; }
  querySelectorAll(sel) { return sel === '.trow[data-id]' ? this.rows || [] : []; }
  querySelector(sel) { return sel === '.gh .muted' ? this.count : null; }
  addEventListener(tp, f) { this.ls[tp] = f; }
}
function harness(store) {
  const els = {}; for (const id of ['opsFilter', 'of_q', 'of_person', 'of_section', 'of_status', 'of_clear', 'of_count']) els['#' + id] = new E(id === 'of_q' ? 'input' : 'select');
  const mkGrp = (ids, label) => { const g = new E('div'); g.count = new E('span'); g.count.textContent = label; g.rows = ids.map((i) => { const r = new E('div'); r.dataset.id = i; return r; }); return g; };
  const g1 = mkGrp(['1', '2', '3'], '1/3 done'), g2 = mkGrp(['4'], '0/1 done'), links = new E('div'); links.id = 'workerLinks';
  const tasks = [
    { id: '1', title: 'Stage frame', category: 'Stage setup', assignee_name: 'Ravi', status: 'completed', verify_status: 'pending' },
    { id: '2', title: 'Stage lights', category: 'Stage setup', assignee_name: 'Ravi', status: 'accepted', verify_status: 'unverified' },
    { id: '3', title: 'Backdrop <b>', category: 'Stage setup', assignee_name: 'Asha', status: 'unassigned', crew_id: 'c', verify_status: 'unverified' },
    { id: '4', title: 'Lunch', category: 'Catering', assignee_name: '', status: 'rejected', verify_status: 'unverified' },
  ];
  const block = ops.slice(ops.indexOf('  /* r92: Live status filter - '), ops.indexOf('  function verifyChip(t){'));
  const STATUS = ops.match(/const STATUS_LABEL=\{[^\n]*\};/)[0], SHOWN = ops.match(/const shownStatus=[^\n]*;/)[0];
  const ctx = { tasks, quoteId: 'q1', CATS: ['Stage setup', 'Catering'], JSON, Object, String, Set,
    $: (s) => els[s] || null,
    document: { createElement: (tg) => new E(tg), querySelectorAll: (s) => (s === '#dashboard .grp' ? [g1, g2, links] : []) },
    localStorage: store };
  vm.createContext(ctx);
  vm.runInContext(STATUS + SHOWN + block + '\nthis.applyOpsFilter=applyOpsFilter; this.setOpsFilter=setOpsFilter;', ctx);
  return { ctx, els, g1, g2 };
}
const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, m }; };

await t('2 filter behaviour', async () => {
  const store = mem(); const h = harness(store);
  h.ctx.applyOpsFilter();
  const opts = (id) => h.els['#' + id].children.map((o) => o.value);
  assert.deepEqual(opts('of_person'), ['', 'Asha', 'Ravi', 'Unassigned']);
  assert.deepEqual(opts('of_section'), ['', 'Stage setup', 'Catering']);
  assert.deepEqual(opts('of_status'), ['', 'assigned', 'accepted', 'completed', 'rejected', 'qc_pending'], 'shownStatus (unassigned+crew = assigned) + QC pending');
  assert.equal(h.els['#of_person'].children[1].textContent, 'Asha', 'options via textContent');
  assert.equal(h.g1.count.textContent, '1/3 done'); assert.equal(h.els['#of_clear'].disabled, true);
  h.ctx.setOpsFilter('q', 'stage');
  assert.deepEqual(h.g1.rows.map((r) => r.classList.contains('f-hide')), [false, false, true]);
  assert.equal(h.g2.classList.contains('f-hide'), true, 'empty group hidden');
  assert.equal(h.g1.count.textContent, '1/2 done (of 3)');
  assert.equal(h.els['#of_count'].textContent, '2 of 4 tasks');
  assert.equal(JSON.parse(store.m['helm.opsFilter.q1']).q, 'stage', 'saved per event');
  h.ctx.setOpsFilter('q', ''); h.ctx.setOpsFilter('status', 'qc_pending');
  assert.deepEqual(h.g1.rows.map((r) => r.classList.contains('f-hide')), [false, true, true]);
  h.ctx.setOpsFilter('status', 'assigned');
  assert.deepEqual(h.g1.rows.map((r) => r.classList.contains('f-hide')), [true, true, false], 'status uses shownStatus');
  h.ctx.setOpsFilter('status', ''); h.ctx.setOpsFilter('person', 'Unassigned');
  assert.equal(h.g1.classList.contains('f-hide'), true); assert.equal(h.g2.classList.contains('f-hide'), false);
  // a fresh page for the same event restores the filter
  const h2 = harness(store); h2.ctx.applyOpsFilter();
  assert.equal(h2.els['#of_person'].value, 'Unassigned'); assert.equal(h2.g1.classList.contains('f-hide'), true);
  h2.els['#of_clear'].ls.click();
  assert.equal(h2.g1.classList.contains('f-hide'), false); assert.equal(h2.g1.count.textContent, '1/3 done');
  // storage that throws never breaks the page
  const bad = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const h3 = harness(bad); h3.ctx.applyOpsFilter(); h3.ctx.setOpsFilter('q', 'lunch');
  assert.equal(h3.g2.classList.contains('f-hide'), false); assert.equal(h3.g1.classList.contains('f-hide'), true);
});

await t('3 locked Reassign + QC buttons', async () => {
  assert.match(ops, /\['rejected','assigned'\]\.includes\(t\.status\)\?`<button type="button" class="btn sm reassign"/);
  assert.match(ops, /\['accepted','in_progress','completed'\]\.includes\(t\.status\)\?`<button type="button" class="btn sm reassign-locked" disabled title="Locked: task accepted"/);
  assert.match(ops, /canVerify && t\.status==='completed' && t\.verify_status==='pending'/);
});

await t('4 CSS + no inline style on suggestions', async () => {
  const sugg = ops.slice(ops.indexOf('async function renderSuggestions'), ops.indexOf('async function refresh('));
  assert.ok(!/style=/.test(sugg), 'no style= in renderSuggestions');
  assert.match(sugg, /class="btn sm sugg\$\{s\.available\?'':' busy'\}"/);
  assert.match(ops, /\.sugg\{margin:0 6px 6px 0\} \.sugg\.busy\{opacity:\.6\}/);
  const coarse = ops.slice(ops.indexOf('@media (pointer:coarse)'));
  assert.match(coarse, /\.btn,\.btn\.sm,\.account button,\.tabs button\{min-height:44px/);
  assert.match(coarse, /\.titem\{min-height:44px\}/); assert.match(coarse, /input,select\{min-height:44px;font-size:16px\}/);
  assert.match(ops, /@media \(min-width:641px\) and \(max-width:1024px\)\{\s*\.crewrow\{grid-template-columns:minmax\(0,1fr\) minmax\(0,1fr\)\}\s*\.tasklist\{max-height:none\}\s*\.trow \.cat\{[^}]*overflow-wrap:anywhere/);
  assert.match(read('public/crew-shifts.css'), /@media \(pointer:coarse\)\{\.cs-cell\{width:40px;height:40px[^}]*\}\.cs-form input,\.cs-form select,\.cs-edit input\{height:44px/);
  assert.match(work, /\.btn\{height:48px\}/); assert.match(work, /\.eq \.btn\{height:44px\}/); assert.match(work, /\.thumbs button\{width:36px;height:36px/);
  assert.match(work, /@media \(min-width:768px\)\{\s*\.wrap\{max-width:960px\}\s*#tasks\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
  assert.ok(work.includes('<div id="tasks"></div>'), 'grid container is #tasks');
});

await t('5 answers are final in the crew screens', async () => {
  assert.match(work, /if\(t\.status==='assigned'\) acts=`[^`]*data-a="reject"/, 'Reject only for assigned');
  assert.match(work, /else if\(t\.status==='accepted'\) acts=`<button type="button" class="btn primary" data-a="start">Start task<\/button>`;/, 'accepted: no Reject');
  assert.ok(!/rejected:\[\["accept"/.test(rs), 'run-sheet: no Accept after a rejection');
  assert.match(api, /function taskAnswer\(r\) \{\s*if \(r && r\.ok === false && r\.refused\)/);
  assert.equal((api.match(/\.then\(taskAnswer\)/g) || []).length, 3, 'worker respond, evidence, crew respond');
  assert.ok(work.includes('e&&e.refused ? e.message'), 'work.html shows the refusal'); assert.ok(rs.includes('e&&e.refused ? e.message'));
});

await t('6 migration 0311 / APPLY / MANIFEST / run-all / tour', async () => {
  const m = read('supabase/migrations/0311_r92_task_lifecycle.sql'), a = read('supabase/APPLY-0311.sql'), man = read('supabase/migrations/MANIFEST');
  assert.ok(!/[^\x00-\x7f]/.test(m) && !/[^\x00-\x7f]/.test(a), 'ASCII only');
  assert.ok(a.includes(m), 'APPLY carries the migration body'); assert.match(a, /^begin;$/m); assert.match(a, /^commit;$/m); assert.match(a, /-- VERIFY/);
  assert.match(m, /raise exception 'STOP 0311/);
  assert.ok(man.includes('forward  supabase/migrations/0311_r92_task_lifecycle.sql'));
  assert.ok(!/\b(drop table|delete from|truncate|drop column|drop function)\b/i.test(m), 'nothing dropped / deleted');
  assert.match(m, /create trigger zzzz_r311_task_flow before update on public\.event_tasks/);
  for (const mv of ['unassigned>assigned', 'assigned>accepted', 'rejected>assigned', 'accepted>completed', 'completed>in_progress']) assert.ok(m.includes(`'${mv}'`), mv);
  assert.ok(!m.includes("'accepted>rejected'") && !m.includes("'rejected>accepted'"), 'owner 2a: answers are final');
  assert.match(m, /__pre0311\(%s\)', r\.fn, r\.args\)\) is null then/, 'wrap once');
  assert.ok(read('scripts/db-test/run-all.sh').includes('tests/db/r92-task-lifecycle-0311.sql'));
  assert.ok(read('public/page-tours.js').includes('sel: "#opsFilter"'));
});

console.log(`r92-ops-lifecycle: ${n}/6 passed`);
