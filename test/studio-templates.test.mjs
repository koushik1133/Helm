// 0096 studio layout templates: pure logic (validate, payload limits, fit-to-hall, picker order) + wiring + SQL shape.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const cx = { window: {} }; cx.globalThis = cx; vm.createContext(cx);
vm.runInContext(read('public/studio-templates-core.js'), cx);
const C = cx.window.HelmStudioTemplatesCore;
let n = 0; const t = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL ' + name); throw e; } };

t('validate: name required + limits, event type shape', () => {
  assert.ok(C.validate({ name: 'Wedding rounds', event_type: 'wedding' }).ok);
  assert.ok(!C.validate({ name: '  ' }).ok);
  assert.ok(!C.validate({ name: 'x'.repeat(121) }).ok);
  assert.ok(!C.validate({ name: 'x', event_type: 'Bad Type!' }).ok);
  assert.ok(!C.validate({ name: 'x', description: 'd'.repeat(1001) }).ok);
  assert.equal(C.validate({ name: ' A ', event_type: '' }).value.event_type, null);
});
t('payload: items + room, bad thumbnail dropped, too many objects refused', () => {
  const p = C.payload({ name: 'T' }, [{ type: 'table', x: 1, y: 1, width: 5, height: 5 }, null], { w: 180.4, h: 120 }, 'javascript:alert(1)');
  assert.equal(p.data.items.length, 1); assert.deepEqual({ ...p.data.room }, { w: 180, h: 120 }); assert.equal(p.thumbnail, null);
  assert.equal(C.payload({ name: 'T' }, [], { w: 10, h: 10 }, 'data:image/jpeg;base64,AAAA').thumbnail, 'data:image/jpeg;base64,AAAA');
  assert.throws(() => C.payload({ name: 'T' }, new Array(5001).fill({ type: 'chair' }), { w: 100, h: 100 }), /5000/);
  assert.throws(() => C.payload({ name: '' }, [], {}), /name/);
});
t('thumbOk: only png/jpeg/webp data URLs within the size limit', () => {
  assert.ok(C.thumbOk('data:image/png;base64,iVBO'));
  assert.ok(!C.thumbOk('data:image/svg+xml;base64,PHN2Zz4='));
  assert.ok(!C.thumbOk('data:image/png;base64,' + 'A'.repeat(410000)));
});
t('fitToHall: scales positions into a smaller hall, never grows objects, clamps inside', () => {
  const data = { room: { w: 200, h: 140 }, items: [{ type: 'stage', x: 180, y: 120, width: 20, height: 20 }, { type: 'chair', x: 0, y: 0, width: 2, height: 2 }] };
  const r = C.fitToHall(data, { w: 100, h: 70 }, 1000);
  assert.ok(r.scaled); assert.equal(r.hall.w, 100);
  r.items.forEach((it) => { assert.ok(it.x >= 0 && it.x + it.width <= 100.001, JSON.stringify(it)); assert.ok(it.y >= 0 && it.y + it.height <= 70.001); });
  assert.equal(r.items[1].width, 1);   // shrinks with the smaller hall
  const big = C.fitToHall(data, { w: 400, h: 280 }, 1000);
  assert.equal(big.items[0].width, 20, 'objects keep their size in a bigger hall');
  assert.equal(big.items[0].x, 380 - 10);   // centre scaled 190 -> 380
  const capped = C.fitToHall(data, { w: 5000, h: 5000 }, 1000);
  assert.equal(capped.hall.w, 1000, 'hall clamped to the cap');
  assert.deepEqual({ ...C.fitToHall({ items: [{ x: 10, y: 10, width: 10, height: 10 }] }, { w: 20, h: 20 }).from }, { w: 20, h: 20 });
  assert.notEqual(C.fitToHall(data, { w: 200, h: 140 }).items[0], data.items[0], 'deep copies');
});
t('order: archived hidden, default for the event type first, then same type, then rest', () => {
  const rows = [{ id: 1, name: 'B', event_type: 'corporate' }, { id: 2, name: 'A', event_type: 'wedding' }, { id: 3, name: 'Z', event_type: 'wedding', is_default: true },
    { id: 4, name: 'C', archived: true }];
  assert.deepEqual([...C.order(rows, 'wedding').map((r) => r.id)], [3, 2, 1]);
  assert.deepEqual([...C.order(rows, '').map((r) => r.id)], [3, 2, 1]);
  assert.ok(!C.order(rows, 'wedding').some((r) => r.archived));
});
t('builder: studio templates listed first, loadTemplate delegates st: keys, exactSeats re-applied', () => {
  const ui = read('public/studio-templates.js'), b = read('public/builder.js');
  assert.match(b, /indexOf\('st:'\)===0\)\{ if\(window\.HelmStudioTemplates\) window\.HelmStudioTemplates\.apply/);
  assert.match(ui, /sel\.insertBefore\(og, first \|\| null\)/);
  assert.match(ui, /label: "My studio templates"/);
  assert.match(ui, /C\.fitToHall\(row\.data/); assert.match(ui, /ex\(items, N\)/);
  assert.match(ui, /tplEdit/); assert.match(ui, /Save template/);
  assert.doesNotMatch(ui, /innerHTML|insertAdjacentHTML|outerHTML/);
  for (const op of ['duplicate', 'setArchived', 'setDefault', 'save']) assert.match(ui, new RegExp('layoutTemplates\\.' + op + '\\('));
});
t('wizard: Start from my template', () => {
  const w = read('public/layout-wizard.js');
  assert.match(w, /'Start from my template'/); assert.match(w, /HelmStudioTemplates\.openPicker\(\)/);
});
t('pages: scripts + versions', () => {
  const bh = read('public/builder.html'), ch = read('public/control.html');
  assert.match(bh, /builder\.js\?v=66/); assert.match(bh, /layout-wizard\.js\?v=12/);
  for (const h of [bh, ch]) { assert.match(h, /studio-templates-core\.js\?v=1"><\/script>\s*<script src="studio-templates\.js\?v=2"/); assert.match(h, /studio-templates\.css\?v=1/); }
  assert.match(ch, /id="tab-ltemplates"[^>]*hidden/); assert.match(ch, /id="pane-ltemplates" hidden/);
  assert.match(read('public/capture.html'), /studio-templates\.js\?v=2/);
});
t('store-api: layoutTemplates via RLS read + RPC writes', () => {
  const s = read('public/store-api.js');
  assert.match(s, /from\("studio_layout_templates"\)/);
  for (const f of ['studio_template_save', 'studio_template_set_archived', 'studio_template_set_default', 'studio_template_duplicate']) assert.match(s, new RegExp('rpc\\("' + f + '"'));
  assert.match(s, /venues, layoutTemplates, portal/);
});
t('onboarding + getting started: Customize your own templates', () => {
  const ow = read('public/onboarding-wizard.js'), ob = read('public/onboarding.js'), gs = read('public/getting-started.js');
  assert.match(ow, /Customize your own templates/); assert.match(ow, /builder\.html\?new=1&tplEdit=new/);
  assert.match(ob, /HelmOnbWizard\.TEMPLATE_ITEMS/);
  assert.match(gs, /my_templates/);
  const g = { window: {} }; g.globalThis = g; vm.createContext(g); vm.runInContext(gs, g);
  const GS = g.window.HelmGettingStarted || g.HelmGettingStarted;
  const data = { steps: [{ key: 'floor_plan', done: true }, { key: 'quote', done: false }] };
  return GS.addTemplatesStep(data, { layoutTemplates: { list: async () => [] } }).then(() => {
    assert.equal(data.steps[1].key, 'my_templates'); assert.equal(data.steps[1].optional, true);
  });
});
t('SQL 0096: additive, RLS tenant-scoped, DEFINER + empty search_path, no delete, size limits, MANIFEST', () => {
  const q = read('supabase/migrations/0096_studio_layout_templates.sql');
  assert.match(q, /create table if not exists public\.studio_layout_templates/);
  assert.match(q, /enable row level security/);
  assert.match(q, /org_id = \(select public\.current_org_id\(\)\)/);
  assert.match(q, /has_area\('layouts', 'edit'\) or public\.has_area\('controls', 'edit'\)/);
  const defs = q.match(/security definer set search_path = ''/g) || []; assert.ok(defs.length >= 6, defs.length);
  assert.match(q, /Templates are never deleted/); assert.match(q, /pg_column_size\(data\) <= 614400/);
  assert.match(q, /slt_one_default_uidx/);
  assert.doesNotMatch(q, /\bdrop table\b|\btruncate\b|\bdelete from\b/i);
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0096_studio_layout_templates\.sql/);
  assert.match(read('scripts/db-test/run-all.sh'), /tests\/db\/studio-templates-0096\.sql/);
});
setTimeout(() => console.log('studio-templates: ok (' + n + ')'), 50);
