#!/usr/bin/env node
/* builder-versions.test.mjs — the builder's layout version switcher.
 *   - dirty tracking compares a content signature with the saved baseline (undo back to saved = clean)
 *   - switching versions: clean → load; dirty → modal (save then switch / discard and switch / cancel)
 *   - viewing a version never writes; saving from an older version appends a NEW version
 * Pure Node, no deps: functions are lifted out of public/builder.js and driven with stubs.
 * Run directly, or via test/builder-ux.test.mjs (which imports this file). */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'public/builder.html'), 'utf8');
const js = readFileSync(join(ROOT, 'public/builder.js'), 'utf8');
const css = readFileSync(join(ROOT, 'public/builder.css'), 'utf8');
const api = readFileSync(join(ROOT, 'public/store-api.js'), 'utf8');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
// lift `function name(...){...}` out of builder.js by brace matching (bodies here have balanced braces)
const fn = (name) => {
  const start = js.indexOf('function ' + name + '('); assert.ok(start >= 0, name + ' exists in builder.js');
  let i = js.indexOf('{', js.indexOf(')', start)), depth = 0;
  for (; i < js.length; i++) { if (js[i] === '{') depth++; else if (js[i] === '}' && --depth === 0) break; }
  return js.slice(start, i + 1);
};

/* ---- 1. content signature ---- */
const layoutSig = new Function(fn('layoutSig') + '; return layoutSig;')();
{
  const a = [{ id: 'a', x: 1, y: 2, color: '#111111' }], W = { w: 200, h: 140 };
  ok(layoutSig(a, {}, {}, W, 'X') === layoutSig(JSON.parse(JSON.stringify(a)), {}, {}, W, 'X'), 'same document → same signature');
  ok(layoutSig(a, {}, {}, W, 'X') === layoutSig([{ id: 'a', x: 1, y: 2, color: '#222222' }], {}, {}, W, 'X'), 'theme-derived colour is ignored');
  ok(layoutSig([{ id: 'a', colorCustom: true, color: '#111111' }], {}, {}, W, '') !== layoutSig([{ id: 'a', colorCustom: true, color: '#222222' }], {}, {}, W, ''), 'a custom colour counts');
  ok(layoutSig(a, {}, {}, W, ' X ') === layoutSig(a, {}, {}, W, 'X'), 'name compared trimmed');
  ok(layoutSig(a, {}, {}, W, 'X') !== layoutSig(a, {}, {}, { w: 201, h: 140 }, 'X'), 'hall size counts');
  ok(layoutSig(a, { left: 1 }, {}, W, 'X') !== layoutSig(a, { left: 2 }, {}, W, 'X'), 'margins count');
  ok(layoutSig(a, {}, { capacity: 10 }, W, 'X') !== layoutSig(a, {}, { capacity: 11 }, W, 'X'), 'venue capacity counts');
}

/* ---- 2. dirty tracking: undo back to the saved state is clean again ---- */
{
  const store = { items: [{ id: 'a', x: 1 }], margins: {}, venue: {} }, WORLD = { w: 200, h: 140 };
  const name = { value: 'Party' }; const $ = () => name;
  let flag = false; const dirty = { mark: () => { flag = true; }, clean: () => { flag = false; }, isDirty: () => flag };
  const src = 'let savedSig=null;' + fn('layoutSig') + fn('docSig') + fn('markDirty') + fn('setSavedBaseline') +
    'return { markDirty, setSavedBaseline, reset:()=>{ savedSig=null; } };';
  const h = new Function('store', 'WORLD', '$', 'dirty', src)(store, WORLD, $, dirty);
  h.markDirty(); ok(flag, 'with no saved baseline yet, any edit is dirty');
  h.setSavedBaseline(); ok(!flag, 'opening / saving sets a clean baseline');
  const saved = JSON.stringify(store.items);
  store.items[0].x = 5; h.markDirty(); ok(flag, 'a 2D/3D edit (commit → markDirty) is dirty');
  store.items = JSON.parse(saved); h.markDirty(); ok(!flag, 'undo back to the saved state is clean');
  store.items.push({ id: 'b' }); h.markDirty(); store.items.pop(); h.markDirty(); ok(!flag, 'add then undo → clean');
  name.value = 'Party 2'; h.markDirty(); ok(flag, 'renaming is dirty');
  name.value = 'Party'; h.markDirty(); ok(!flag, 'renaming back is clean');
  // a save that started before an edit: baseline = what was saved, so the later edit stays dirty
  const sigAtSaveStart = (() => { const t = new Function('store', 'WORLD', '$', fn('layoutSig') + fn('docSig') + 'return docSig();'); return t(store, WORLD, $); })();
  store.items[0].x = 9; h.markDirty();
  h.setSavedBaseline(sigAtSaveStart); ok(flag, 'an edit made while the save was in flight keeps the page dirty');
  store.items[0].x = 1; h.markDirty(); ok(!flag, '…and undoing it returns to clean');
  h.reset(); h.markDirty(); ok(flag, 'an import (baseline cleared) is dirty even if identical');
}

/* ---- 3. the switch flow ---- */
const createVersionController = new Function(fn('createVersionController') + '; return createVersionController;')();
function harness(o = {}) {
  const log = []; let cur = o.cur ?? 3; let dirty = !!o.dirty; let syncs = [];
  const versions = { 1: { items: [{ id: 'v1' }] }, 2: { items: [{ id: 'v2' }] }, 3: { items: [{ id: 'v3' }] } };
  const d = {
    currentNo: () => cur,
    isDirty: () => dirty,
    isDragging: () => !!o.dragging,
    currentData: () => ({ items: [{ id: 'unsaved' }] }),
    fetchVersion: async (no) => { log.push('fetch:' + no); if (!versions[no]) throw new Error('no version'); return { versionNo: no, data: versions[no] }; },
    ask: async (info) => { log.push('ask:' + info.fromNo + '>' + info.toNo); d.lastAsk = info; return o.choice instanceof Function ? o.choice(info) : o.choice; },
    save: async () => { log.push('save'); if (o.saveFails) return false; cur = 4; dirty = false; return true; },
    load: (no, data) => { log.push('load:' + no); cur = no; dirty = false; d.loaded = data; },
    notify: (m) => log.push('notify'),
    sync: (b) => syncs.push(b),
  };
  return { ctl: createVersionController(d), d, log, syncs, get cur() { return cur; } };
}
{
  let t = harness();
  ok(await t.ctl.switchTo('2') === 'switched' && t.log.join() === 'fetch:2,load:2', 'clean canvas: loads the version directly, no modal, no save');
  ok(t.d.loaded.items[0].id === 'v2', 'the target version data is what gets loaded');
  ok(t.syncs.at(-1) === false, 'dropdown re-synced (unlocked) after the switch');

  t = harness({ dirty: true, choice: 'cancel' });
  ok(await t.ctl.switchTo(1) === 'cancel' && !t.log.includes('save') && !t.log.some(x => x.startsWith('load')), 'dirty + Cancel: nothing saved, nothing loaded');
  ok(t.cur === 3 && t.syncs.at(-1) === false, 'Cancel leaves the current version selected');

  t = harness({ dirty: true, choice: undefined });
  ok(await t.ctl.switchTo(1) === 'cancel' && !t.log.some(x => x.startsWith('load')), 'Esc / dismissed dialog counts as Cancel');

  t = harness({ dirty: true, choice: 'discard' });
  ok(await t.ctl.switchTo(1) === 'switched' && t.log.join() === 'fetch:1,ask:3>1,load:1', 'dirty + Discard: no save, then switch');

  t = harness({ dirty: true, choice: 'save' });
  ok(await t.ctl.switchTo(2) === 'switched' && t.log.join() === 'fetch:2,ask:3>2,save,load:2', 'dirty + Save: saves a new version FIRST, then switches');

  t = harness({ dirty: true, choice: 'save', saveFails: true });
  ok(await t.ctl.switchTo(2) === 'save-failed' && !t.log.some(x => x.startsWith('load')) && t.cur === 3, 'a failed save never switches (unsaved work stays on screen)');

  t = harness({ dirty: true, choice: 'discard' });
  await t.ctl.switchTo(2);
  ok(t.d.lastAsk.current.items[0].id === 'unsaved' && t.d.lastAsk.target.items[0].id === 'v2', 'modal gets both the unsaved canvas and the target version for previews');

  t = harness();
  ok(await t.ctl.switchTo(3) === 'noop' && t.log.length === 0, 'picking the version already open does nothing');
  ok(await t.ctl.switchTo('abc') === 'noop' && await t.ctl.switchTo(0) === 'noop' && t.log.length === 0, 'junk version numbers are ignored');

  t = harness({ dragging: true });
  ok(await t.ctl.switchTo(1) === 'noop' && t.log.length === 0, 'no switch mid-drag (2D or 3D gizmo)');

  t = harness();
  ok(await t.ctl.switchTo(9) === 'error' && t.log.join() === 'fetch:9,notify' && t.cur === 3, 'missing version: error toast, canvas untouched');

  let release; t = harness({ dirty: true, choice: () => new Promise(r => { release = r; }) });
  const p1 = t.ctl.switchTo(1);
  await new Promise(r => setTimeout(r, 0));
  ok(t.ctl.isBusy() && t.syncs.includes(true), 'dropdown locked while the dialog is open');
  ok(await t.ctl.switchTo(2) === 'noop', 'a second switch while one is pending is ignored');
  release('discard'); ok(await p1 === 'switched' && t.cur === 1 && !t.ctl.isBusy(), 'first switch completes');
}

/* ---- 4. option labels ---- */
{
  const versionOptionLabel = new Function(fn('versionOptionLabel') + '; return versionOptionLabel;')();
  const lbl = versionOptionLabel({ versionNo: 3, createdAt: '2026-10-07T09:30:00Z', createdBy: 'u1', label: 'Added VIP riser' }, 3, { u1: 'Priya' }, 'me');
  ok(/^V3 \(latest\) · .+ · Priya · “Added VIP riser”$/.test(lbl), 'option shows version, latest flag, date, who, note: ' + lbl);
  ok(/ · you$/.test(versionOptionLabel({ versionNo: 2, createdBy: 'me' }, 3, {}, 'me')), 'own saves read "you"');
  ok(versionOptionLabel({ versionNo: 1 }, 3, null, null) === 'V1', 'missing metadata is simply left out');
  ok(/…”$/.test(versionOptionLabel({ versionNo: 1, label: 'x'.repeat(80) }, 3)), 'long notes are truncated');
}

/* ---- 5. wiring / no-write guarantees (source level) ---- */
ok(/<select id="verSel"[^>]*aria-label="Layout version"/.test(html), 'version dropdown exists and is labelled');
const modal = html.match(/<div class="modal" id="verModal"[\s\S]*?\n<\/div>/);
ok(modal && /role="dialog"/.test(modal[0]) && /aria-modal="true"/.test(modal[0]), 'switch modal is an aria dialog');
ok(modal && /data-close/.test(modal[0]), 'modal has a [data-close] control (BPUI maps Esc to it → Cancel)');
for (const c of ['save', 'discard', 'cancel']) ok(modal && new RegExp('data-choice="' + c + '"').test(modal[0]), 'modal offers ' + c);
ok(/Save as new version, then switch/.test(html) && /Discard changes and switch/.test(html), 'modal action labels');
ok(/id="verThumbCur"/.test(html) && /id="verThumbTgt"/.test(html), 'modal shows current vs target previews');
ok(/id="verBanner"[\s\S]*id="verRestoreBtn"[^>]*>Restore as new version<[\s\S]*id="verLatestBtn">Back to latest</.test(html), 'older-version banner with Restore / Back to latest');
ok(/\.verbanner\{/.test(css) && /\.verthumb\{/.test(css), 'styles present');
const load = fn('loadVersionIntoEditor');
ok(!/BPStore|addVersion|updateMeta|saveLayout/.test(load), 'viewing a version performs no writes');
ok(/BPStore\.quotes\.addVersion\(currentQuoteId, label, data,/.test(js), 'saving passes the version note (append-only addVersion)');
ok(/fromOlder \? 'Based on V'\+fromNo/.test(js), 'saving while viewing an older version is labelled and creates a new version');
ok(/saveLayout\(false,\{ label:'Restored from V'\+from \}\)/.test(js), 'Restore as new version = a normal append-only save');
ok(/setSavedBaseline\(sig\);\s*return true;/.test(js), 'a successful save resets the clean baseline to what was saved');
ok(/const dirty = BPUI\.trackDirty\(\);/.test(js), 'dirty tracker is registered with BPUI (shared beforeunload warning)');
ok(/askVersionSwitch[\s\S]*?e\.key==='Escape'/.test(js), 'Esc cancels the switch dialog');
ok(!/innerHTML/.test(fn('drawLayoutThumb')) && !/innerHTML/.test(fn('renderVersionUI')), 'version UI is built without innerHTML');
// store-api: read-only versions() in both tiers + facade
const sbv = api.match(/async versions\(quoteId\) \{[\s\S]*?\n    \},/);
ok(sbv && /from\("quote_versions"\)\.select\(/.test(sbv[0]) && !/insert|update\(|delete\(|upsert|rpc\(/.test(sbv[0]), 'supabase versions() is a read-only select');
ok(sbv && /created_by/.test(sbv[0]) && (sbv[0].match(/select\(cols\)/) || []).length === 1, 'versions() reads who-saved, with a fallback without that column');
ok(/async versions\(id\) \{ const q = this\.read\(\)/.test(api), 'local tier versions()');
ok(/versions: \(id\) => qt\(\)\.versions\(id\),/.test(api), 'BPStore.quotes.versions facade');
ok(!/\son[a-z]+="/i.test(html), 'no inline event handlers');

console.log(`builder-versions: ${n} checks passed`);
