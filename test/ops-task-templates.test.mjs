// Ops task templates (QA Oct 2026): the app had no way to create task_templates, and a task
// re-completed after a QC reject stayed "QC rework" forever. Pins the add-template UI/API,
// the QC re-queue migration 0115 and the Pass/Reject fallback for already-stuck rows.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const api = read('public/store-api.js'), ops = read('public/ops.html');
const mig = read('supabase/migrations/0115_task_requeue_after_rework.sql'), apply = read('supabase/APPLY-0115.sql');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
t('store: addTemplate inserts only (no upsert/delete), trims, appends seq', () => {
  const m = api.match(/async addTemplate\(category, title\)[\s\S]*?return data; \},/); assert.ok(m);
  assert.match(m[0], /\.from\("task_templates"\)\.insert\(\{ category, title, seq \}\)/);
  assert.doesNotMatch(m[0], /upsert|delete|update\(/);
  assert.match(m[0], /Math\.max\(m, Number\(x\.seq\) \|\| 0\), 0\) \+ 1/);
});
t('ops: add-to-template row exists, gated by edit right, duplicate message', () => {
  assert.match(ops, /id="tpl_cat"/); assert.match(ops, /id="tpl_title"/); assert.match(ops, /id="tpl_add"/);
  assert.match(ops, /\["cr_add","assignBtn","tpl_add"\]/);
  assert.match(ops, /BPStore\.ops\.addTemplate\(cat,title\)/);
  assert.match(ops, /That task is already in this section\./);
});
t('ops: QC buttons only for a completed task waiting for QC (r92 / 0311: verify_task needs completed + pending)', () => {
  assert.match(ops, /canVerify && t\.status==='completed' && t\.verify_status==='pending'/);
});
t('0115: re-queues rejected on re-completion; additive, no DDL drops', () => {
  for (const s of [mig, apply]) {
    assert.match(s, /new\.verify_status in \('unverified', 'rejected'\)/);
    assert.match(s, /task-requeue-0115/);
    assert.doesNotMatch(s.replace(/--.*$/gm, ''), /\bdrop\b|\bdelete\b|\btruncate\b|\bupdate\s+public\./i);
  }
  assert.match(apply, /VERIFY/); assert.match(read('supabase/migrations/MANIFEST'), /0115_task_requeue_after_rework\.sql/);
});
console.log(`\n${n} passed`);
