// R96 Cancel task: Ops Cancel button + reason modal, store-api cancel -> rpc cancel_task, cancelled rows greyed with the
// reason, crew link / runsheet show "Cancelled by the office" with no actions, page tour, migration 0312 wiring.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { try { await fn(); n++; } catch (e) { console.error('FAIL ' + name); throw e; } };
const ops = read('public/ops.html'), work = read('public/work.html'), rs = read('public/runsheet.html'), api = read('public/store-api.js');

// render ops taskRow in a vm
function rowHtml(task, canEditOps) {
  const pick = (re) => { const m = ops.match(re); assert.ok(m, String(re)); return m[0]; };
  const start = ops.indexOf('  function taskRow(t, byId, label){'), end = ops.indexOf('  function workerLinkFor(');
  const src = [pick(/const CANCELLABLE=[^\n]*;/), pick(/const STATUS_LABEL=\{[^\n]*\};/), pick(/const shownStatus=[^\n]*;/), ops.slice(start, end)].join('\n');
  const ctx = { canEditOps, canVerify: false, esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`),
    gateChip: () => '', verifyChip: () => '', evidenceBtn: () => '', fmtTime: () => 'Oct 30, 10:00', out: '' };
  vm.createContext(ctx);
  vm.runInContext(src + '\nout=taskRow(task, {}, "x");', Object.assign(ctx, { task }));
  return ctx.out;
}

await t('1 Cancel button only for Staff editors on assigned / accepted / in_progress', async () => {
  for (const st of ['assigned', 'accepted', 'in_progress']) {
    assert.match(rowHtml({ id: 'a', title: 'T', status: st }, true), /class="btn sm danger tcancel"[^>]*>Cancel</, st);
    assert.doesNotMatch(rowHtml({ id: 'a', title: 'T', status: st }, false), /tcancel/, st + ' view-only');
  }
  for (const st of ['unassigned', 'completed', 'cancelled', 'rejected']) assert.doesNotMatch(rowHtml({ id: 'a', title: 'T', status: st }, true), /tcancel/, st);
});
await t('2 cancelled row greyed with the escaped reason, no Reassign / Cancel', async () => {
  const h = rowHtml({ id: 'a', title: 'T', status: 'cancelled', cancel_reason: 'Rain <b>', cancelled_at: '2026-10-30T10:00:00Z' }, true);
  assert.match(h, /class="trow is-cancelled"/);
  assert.match(h, /<span class="st cancelled">Cancelled<\/span>/);
  assert.match(h, /class="creason">Cancelled: Rain &#60;b&#62; · Oct 30, 10:00</);
  assert.doesNotMatch(h, /reassign|tcancel/);
  assert.match(ops, /\.st\.cancelled\{/); assert.match(ops, /\.trow\.is-cancelled/);
});
await t('3 modal: reason required 3-300, calls BPStore.ops.cancel, Ops filter keeps cancelled', async () => {
  for (const id of ['cancelTaskModal', 'cancelTaskForm', 'ct_task', 'ct_reason', 'ct_err', 'ct_back', 'ct_save']) assert.ok(ops.includes(`id="${id}"`), id);
  assert.match(ops, /<textarea id="ct_reason" required minlength="3" maxlength="300"/);
  assert.match(ops, /reason\.length<3/); assert.match(ops, /reason\.length>300/);
  assert.match(ops, /await BPStore\.ops\.cancel\(ctTaskId,reason\)/);
  assert.match(ops, /querySelectorAll\("\.tcancel"\)\.forEach\(b=>b\.addEventListener\("click",\(\)=>openCancelTask/);
  assert.match(ops, /!\$\("#cancelTaskModal"\)\.hidden/, 'auto refresh paused while the modal is open');
  assert.match(ops, /STATUS_LABEL=\{[^}]*cancelled:"Cancelled"/, 'filter status option');
  const modal = ops.slice(ops.indexOf('id="cancelTaskModal"'), ops.indexOf('id="schedModal"'));
  assert.doesNotMatch(modal, /style=/, 'no inline style (CSP)');
});
await t('4 store-api cancel -> rpc cancel_task', async () => {
  assert.match(api, /cancel: \(taskId, reason\) => rpc\("cancel_task", \{ p_task: taskId, p_reason: String\(reason \|\| ""\)\.trim\(\) \}\)/);
});
await t('5 crew link + runsheet: "Cancelled by the office", no actions', async () => {
  assert.match(work, /LABEL=\{[^}]*cancelled:"Cancelled"/);
  assert.match(work, /else if\(t\.status==='cancelled'\) acts=`<span class="cxl">Cancelled by the office<\/span>`;/);
  assert.match(rs, /t\.status==="cancelled"\?"Cancelled by the office"/);
  assert.doesNotMatch(rs.match(/const TASK_ACTS=\{[^\n]*\};/)[0], /cancelled/);
});
await t('6 page tour + migration 0312 wiring', async () => {
  assert.match(read('public/page-tours.js'), /use Cancel \(a reason is required\)/);
  const mig = read('supabase/migrations/0312_r96_cancel_task.sql');
  assert.match(read('supabase/migrations/MANIFEST'), /^forward  supabase\/migrations\/0312_r96_cancel_task\.sql$/m);
  assert.match(mig, /create or replace function public\.cancel_task\(p_task uuid, p_reason text\)/);
  assert.match(mig, /has_area\('staff', 'edit'\)/); assert.match(mig, /for update;/);
  assert.match(mig, /grant execute on function public\.cancel_task\(uuid, text\) to authenticated/);
  assert.doesNotMatch(mig, /\b(drop table|drop column|delete from|truncate)\b/i);
  assert.ok(/^[\x00-\x7f]*$/.test(mig), 'ASCII');
  const ap = read('supabase/APPLY-0312.sql');
  assert.ok(ap.includes(mig.replace(/\s*$/, '\n')), 'APPLY carries the migration verbatim');
  assert.match(ap, /^begin;$/m); assert.match(ap, /^commit;$/m); assert.match(ap, /-- VERIFY/);
  assert.match(read('scripts/db-test/run-all.sh'), /r96-cancel-task-0312/);
});
console.log(`r96-cancel-task: ${n} passed`);
