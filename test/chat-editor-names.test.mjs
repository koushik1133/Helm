// Chat photo editor Undo / Redo / Clear marks + display names (0034).
// Pins: the three editor buttons exist with accessible labels, start disabled and are
// re-synced from the history; the keyboard shortcuts are wired (and leave the caption
// box's own text undo alone); "Clear marks" keeps the cropped photo. Names: chat and
// the bell use one helper (display name → e-mail local part → role), the roster reads
// chat_directory with a fallback, and the client validator matches the DB rule.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const chat = readFileSync(new URL('../public/chat.html', import.meta.url), 'utf8');
const api = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
const ctl = readFileSync(new URL('../public/control.html', import.meta.url), 'utf8');
const aui = readFileSync(new URL('../public/auth-ui.js', import.meta.url), 'utf8');
const mig = readFileSync(new URL('../supabase/migrations/0034_display_names.sql', import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('editor toolbar has Undo, Redo and Clear marks buttons (labelled, disabled at start)', () => {
  for (const [id, label] of [['ieUndo', 'Undo'], ['ieRedo', 'Redo'], ['ieClear', 'Clear all drawn marks']]) {
    const m = chat.match(new RegExp(`<button class="ie-ic" id="${id}"[^>]*>`)); assert.ok(m, `${id} missing`);
    assert.match(m[0], new RegExp(`aria-label="${label}"`)); assert.match(m[0], /title="[^"]+"/); assert.match(m[0], /\sdisabled>/);
  }
  assert.match(chat, /\.ie-ic:disabled\{/);
});
t('buttons follow the history: disabled when nothing to undo / redo / clear', () => {
  assert.match(chat, /\$\("#ieUndo"\)\.disabled=!ieHist\.length; \$\("#ieRedo"\)\.disabled=!ieFut\.length; \$\("#ieClear"\)\.disabled=!\(ieState&&ieState\.strokes\.length\)/);
  for (const fn of ['ieUndo', 'ieRedo', 'ieClearMarks']) assert.match(chat, new RegExp(`addEventListener\\("click",${fn}\\)`));
});
t('keyboard: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Ctrl+Y redo, not inside the caption', () => {
  assert.match(chat, /if\(\$\("#imgEdit"\)\.hidden\|\|!\(e\.ctrlKey\|\|e\.metaKey\)/);
  assert.match(chat, /t\.tagName==="INPUT"\|\|t\.tagName==="TEXTAREA"/);
  assert.match(chat, /if\(k==="z"&&!e\.shiftKey\)\{ e\.preventDefault\(\); ieUndo\(\); \}/);
  assert.match(chat, /else if\(\(k==="z"&&e\.shiftKey\)\|\|\(k==="y"&&!e\.shiftKey\)\)\{ e\.preventDefault\(\); ieRedo\(\); \}/);
});
t('clear marks keeps the (cropped) photo; crop works on the clean photo', () => {
  assert.match(chat, /function ieClearMarks\(\)\{[^\n]*iePush\(\); ieState=\{base:ieState\.base, strokes:\[\]\}/);
  assert.match(chat, /drawImage\(ieState\.base,x,y,w,h,0,0,tmp\.width,tmp\.height\)/);
});
t('editor history logic: undo / redo / clear behave as a stack', () => {
  // run the pure history functions against a stub DOM
  const src = chat.match(/let ieMode=null[\s\S]*?function ieEndStroke\(\)\{[^\n]*\n[^\n]*\n[^\n]*\n/)[0];
  const btn = () => ({ disabled: false });
  const els = { '#ieUndo': btn(), '#ieRedo': btn(), '#ieClear': btn(), '#ieCropBox': {}, '#ieApply': {},
    '#ieCanvas': { width: 0, height: 0, getContext: () => ({ drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {} }) } };
  const ctx = { $: (s) => els[s] };
  vm.runInNewContext(src + `
    ieState={base:{width:10,height:10}, strokes:[]}; ieSync();
    const r=[]; const snap=()=>r.push([ieState.strokes.length, $("#ieUndo").disabled, $("#ieRedo").disabled, $("#ieClear").disabled]);
    snap();
    ieDrawing=true; ieCur={pts:[{x:1,y:1},{x:2,y:2}]}; ieEndStroke(); snap();
    ieDrawing=true; ieCur={pts:[{x:3,y:3}]}; ieEndStroke(); snap();
    ieClearMarks(); snap();
    ieUndo(); snap();
    ieUndo(); snap();
    ieRedo(); snap();
    ieDrawing=true; ieCur={pts:[{x:4,y:4}]}; ieEndStroke(); snap();
    globalThis.out=JSON.stringify(r);`, ctx);
  assert.deepEqual(JSON.parse(ctx.out), [
    [0, true, true, true],     // fresh photo: nothing to do
    [1, false, true, false],   // one stroke
    [2, false, true, false],   // two strokes
    [0, false, true, true],    // cleared: photo back, nothing left to clear
    [2, false, false, false],  // undo the clear
    [1, false, false, false],  // undo a stroke
    [2, false, false, false],  // redo it
    [3, false, true, false],   // a new stroke drops the redo branch
  ]);
});

t('names: one helper, display name → e-mail local part → role → "Member"', () => {
  const src = api.match(/function personDisplayName\(p\) \{[\s\S]*?\n  \}\n  \/\/ Same rule[\s\S]*?function displayNameProblem\(name\) \{[\s\S]*?\n  \}\n/)[0];
  const ctx = { roleLabel: (r) => ({ sales: 'Sales' }[r] || r) };
  vm.runInNewContext(src + 'globalThis.dn=personDisplayName; globalThis.bad=displayNameProblem;', ctx);
  assert.equal(ctx.dn({ full_name: ' Ananya Rao ', email: 'a@x.in', role: 'sales' }), 'Ananya Rao');
  assert.equal(ctx.dn({ full_name: '', email: 'ananya.rao@x.in', role: 'sales' }), 'ananya.rao');
  assert.equal(ctx.dn({ email_name: 'vik', role: 'sales' }), 'vik');
  assert.equal(ctx.dn({ role: 'sales' }), 'Sales');
  assert.equal(ctx.dn(null), 'Member');
  assert.equal(ctx.bad('  Ana   Rao '), null);
  assert.equal(ctx.bad('x'.repeat(80)), null);
  for (const b of ['', '   ', 'x'.repeat(81), '<b>', 'a>b', 'a\u0007b']) assert.ok(ctx.bad(b), `should refuse ${JSON.stringify(b)}`);
});
t('chat, bell and pickers use the helper; roster reads chat_directory with a fallback', () => {
  assert.match(api, /await supa\.rpc\("chat_directory"\);[\s\S]{0,200}if \(!rpcMissing\(error\)\) throw error;\s*chatDirectoryMissing = true;/);
  assert.match(api, /nameById\[p\.id\] = personDisplayName\(p\);/);
  assert.doesNotMatch(chat, /(esc|initials)\(p\.full_name\|\|p\.email\)/);
  assert.match(chat, /function personName\(id\)\{ const p=roster\[id\]; return p\?pname\(p\)/);
  assert.equal((chat.match(/esc\(pname\(p\)\)/g) || []).length, 3);
});
t('Control Center and the account panel can set a display name', () => {
  assert.match(ctl, /BPStore\.profile\.setName\(id, name\)/);
  assert.match(ctl, /validate:\(v\)=>BPStore\.profile\.problem\(v\)/);
  assert.match(api, /rpc\("admin_set_display_name", \{ p_user: userId, p_name: cleanDisplayName\(name\) \}\)/);
  assert.match(api, /rpc\("set_my_display_name", \{ p_name: cleanDisplayName\(name\) \}\)/);
  assert.match(aui, /st\.profile\.setMine\(inp\.value\)/);
});
t('0034: same-studio admin gate, validation, audit, no anon', () => {
  assert.match(mig, /not public\.is_admin\(\)/);
  assert.match(mig, /where p\.id = p_user and p\.org_id = v_org for update/);
  assert.match(mig, /char_length\(v\) > 80/); assert.match(mig, /v ~ '\[<>\]'/);
  assert.equal((mig.match(/'profile\.display_name', 'profiles'/g) || []).length, 2);
  assert.match(mig, /revoke all on function public\.admin_set_display_name\(uuid, text\) from anon/);
});
console.log(`\nchat-editor-names: ${n} passed`);
