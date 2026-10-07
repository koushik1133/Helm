// Crew evidence on the work link (0038). Pins: work.html opens an evidence sheet on
// Reject (reason ≤ 1000 + voice note ≤ 2 min via MediaRecorder) and on Mark done
// (≤ 10 photos, camera capture input, ≤ 8 MB originals resized to a 1600 px JPEG);
// store-api uploads through the server grant into the private task-proof bucket
// (type from the bytes, upsert off) and calls the 0038 RPCs with the migration's
// argument names; ops.html shows reason / voice / photos with 300 s signed URLs and
// escapes everything the crew typed. Behaviour runs the real code against stubs.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const work = readFileSync(new URL('../public/work.html', import.meta.url), 'utf8');
const ops = readFileSync(new URL('../public/ops.html', import.meta.url), 'utf8');
const api = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
const mig = readFileSync(new URL('../supabase/migrations/0038_worker_evidence.sql', import.meta.url), 'utf8');
const manifest = readFileSync(new URL('../supabase/migrations/MANIFEST', import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

await t('work.html: reject / done open the evidence sheet (no bare confirm)', () => {
  assert.match(work, /if\(action==='reject' \|\| action==='complete'\)\{ evOpen\(id,action,btn\); return; \}/);
  assert.doesNotMatch(work, /Reject this task\? The office will be told/, 'old confirm-only reject flow still present');
  for (const id of ['evSheet', 'evTitle', 'evReason', 'evCount', 'recBtn', 'recTime', 'recPlay', 'recDel', 'evCam', 'evPick', 'evCamIn', 'evPickIn', 'evThumbs', 'evErr', 'evCancel', 'evGo'])
    assert.match(work, new RegExp(`id="${id}"`), id + ' missing');
  assert.match(work, /<div class="sheet" role="dialog" aria-modal="true" aria-labelledby="evTitle">/);
  assert.match(work, /<textarea id="evReason" maxlength="1000"/);
  assert.match(work, /<input type="file" id="evCamIn" accept="image\/\*" capture="environment" multiple hidden>/);
  assert.match(work, /<input type="file" id="evPickIn" accept="image\/jpeg,image\/png,image\/webp" multiple hidden>/);
  assert.match(work, /id="evCancel" data-close/);
});

await t('work.html: limits — 10 photos, 8 MB, png/jpeg/webp, 1600 px JPEG, 2-minute voice, 1000-char reason', () => {
  assert.match(work, /const EV_MAX_PHOTOS=10, EV_MAX_BYTES=8\*1024\*1024, EV_MAX_REC=120, EV_REASON_MAX=1000, EV_PHOTO_PX=1600;/);
  assert.match(work, /const EV_PHOTO_TYPES=\/\^image\\\/\(jpeg\|png\|webp\)\$\/;/);
  assert.match(work, /if\(!EV_PHOTO_TYPES\.test\(f\.type\|\|""\) \|\| f\.size>EV_MAX_BYTES\)\{ skipped\+\+; continue; \}/);
  assert.match(work, /c\.toBlob\(b=>\{ if\(b&&b\.size<=EV_MAX_BYTES\) res\(new File\(\[b\],"photo\.jpg",\{type:"image\/jpeg"\}\)\);[^\n]*,"image\/jpeg",0\.85\)/);
  assert.match(work, /getUserMedia\(\{audio:true\}\)/);
  assert.match(work, /if\(s>=EV_MAX_REC\) stopRec\(true\);/);
  assert.match(work, /\["audio\/webm;codecs=opus","audio\/webm","audio\/mp4","audio\/ogg;codecs=opus","audio\/ogg"\]/);
  assert.match(work, /if\(reason\.length>EV_REASON_MAX\)/);
  // recorder tracks are always released (stop → getTracks().forEach(stop)); closing discards
  assert.match(work, /r\.stream\.getTracks\(\)\.forEach\(t=>t\.stop\(\)\)/);
  assert.match(work, /if\(ev\.rec\) await stopRec\(false\);/);
});

await t('work.html: submit uploads via grants then saves status + evidence in one call; plain path when empty', () => {
  const sub = work.slice(work.indexOf('async function evSubmit(){'), work.indexOf('$("#evReason").addEventListener'));
  assert.ok(sub.length > 500, 'evSubmit not found');
  assert.match(sub, /if\(!reason && !cur\.voice\) await W\.respond\(token,cur\.id,'reject'\);/);
  assert.match(sub, /cur\.voice\.path=await W\.uploadEvidence\(token,cur\.id,'reject_voice',cur\.voice\.file\)/);
  assert.match(sub, /await W\.respondEvidence\(token,cur\.id,'reject',\{reason:reason\|\|null,voicePath:/);
  assert.match(sub, /if\(!cur\.photos\.length\) await W\.respond\(token,cur\.id,'complete'\);/);
  assert.match(sub, /p\.path=await W\.uploadEvidence\(token,cur\.id,'proof_photo',p\.file\)/);
  assert.match(sub, /await W\.respondEvidence\(token,cur\.id,'complete',\{photoPaths:cur\.photos\.map\(p=>p\.path\)\}\)/);
  // a retry re-uploads files whose grant ran out
  assert.match(sub, /if\(\/upload not found\|expired\/i\.test/);
  // thumbnails: escaped, local blob URLs only
  assert.match(work, /<img src="\$\{esc\(p\.url\)\}" alt="Photo \$\{i\+1\}">/);
});

await t('store-api → 0038 RPCs with the migration\'s argument names; task-proof bucket; 300 s signed URLs', () => {
  const sig = mig.match(/create or replace function public\.worker_respond_evidence\(([\s\S]*?)\)\s*returns/)[1];
  const names = [...sig.matchAll(/(p_[a-z_]+)\s/g)].map((m) => m[1]);
  assert.deepEqual(names, ['p_token', 'p_task_id', 'p_action', 'p_reason', 'p_voice_path', 'p_voice_seconds', 'p_photo_paths']);
  const call = api.match(/rpc\("worker_respond_evidence", \{([\s\S]*?)\}\); \}/);
  assert.ok(call, 'respondEvidence missing');
  for (const p of names) assert.match(call[1], new RegExp(p + ':'), p + ' not passed');
  const gsig = mig.match(/create or replace function public\.worker_evidence_upload\(([^)]*)\)/)[1];
  assert.deepEqual([...gsig.matchAll(/(p_[a-z_]+)\s/g)].map((m) => m[1]), ['p_token', 'p_task_id', 'p_kind', 'p_mime']);
  assert.match(api, /rpc\("worker_evidence_upload", \{ p_token: token, p_task_id: taskId, p_kind: kind, p_mime: sniff\.mime \}\)/);
  assert.match(api, /supa\.storage\.from\("task-proof"\)\.upload\(g\.path, file, \{ upsert: false, contentType: g\.mime \}\)/);
  assert.match(api, /supa\.storage\.from\("task-proof"\)\.createSignedUrls\(ok, seconds \|\| 300\)/);
  assert.match(api, /supa\.from\("task_evidence"\)/);
  assert.match(mig, /'task-proof', 'task-proof', false, 8388608/);
  assert.match(manifest, /^forward\s+supabase\/migrations\/0038_worker_evidence\.sql$/m);
});

// ---- behaviour: the real store-api upload / respond code against a stub client ------
const wStart = api.indexOf('async uploadEvidence(token, taskId, kind, file) {');
const wEnd = api.indexOf('    },\n  };\n  const TASK_PROOF_MAX');
const sStart = api.indexOf('const CHAT_SNIFF = [');
const sEnd = api.indexOf('// ---- local-mode state');
const consts = api.match(/const TASK_PROOF_MAX = [^\n]*\n\s*const TASK_PROOF_KEY = [^\n]*\n/);
assert.ok(wStart > 0 && wEnd > wStart && sStart > 0 && sEnd > sStart && consts, 'store-api evidence code not found');
function harness(grant) {
  const calls = { rpc: [], upload: [] };
  const ctx = {
    Error, Math, Uint8Array,
    rpc: async (fn, args) => { calls.rpc.push([fn, args]); return fn === 'worker_evidence_upload' ? grant : { ok: true, status: 'completed' }; },
    supa: { storage: { from: (b) => ({ upload: async (path, file, opts) => { calls.upload.push([b, path, opts]); return { error: null }; } }) } },
  };
  vm.createContext(ctx);
  const W = vm.runInContext(`${consts[0]}\n${api.slice(sStart, sEnd)}\n({ ${api.slice(wStart, wEnd)} })`, ctx);
  return { W, calls };
}
const KEY = 'a0000000-0000-4000-8000-000000000001/a0000000-0000-4000-8000-00000000da01/e0000000-0000-4000-8000-0000000000a2/5d0e3f7e-8d0c-4f43-9f6a-0d1f6c6a8a11';
const jpeg = new File([new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])], 'x.jpg', { type: 'image/jpeg' });
const webm = new File([new Uint8Array([0x1A, 0x45, 0xDF, 0xA3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])], 'v.webm', { type: 'audio/webm' });
const html = new File([new TextEncoder().encode('<html><script>alert(1)</script>')], 'evil.jpg', { type: 'image/jpeg' });

await t('upload: grant first, then write exactly the granted key (no upsert, server MIME)', async () => {
  const { W, calls } = harness({ bucket: 'task-proof', path: KEY + '.jpg', mime: 'image/jpeg' });
  const p = await W.uploadEvidence('tok', 'task', 'proof_photo', jpeg);
  assert.equal(p, KEY + '.jpg');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.rpc)), [['worker_evidence_upload', { p_token: 'tok', p_task_id: 'task', p_kind: 'proof_photo', p_mime: 'image/jpeg' }]]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.upload)), [['task-proof', KEY + '.jpg', { upsert: false, contentType: 'image/jpeg' }]]);
});

await t('upload: wrong bytes / wrong kind / too big / odd server key are refused before anything is written', async () => {
  const { W, calls } = harness({ bucket: 'task-proof', path: KEY + '.jpg', mime: 'image/jpeg' });
  await assert.rejects(W.uploadEvidence('tok', 'task', 'proof_photo', html), /JPEG, PNG or WebP/);
  await assert.rejects(W.uploadEvidence('tok', 'task', 'proof_photo', webm), /JPEG, PNG or WebP/);
  await assert.rejects(W.uploadEvidence('tok', 'task', 'reject_voice', jpeg), /voice note format/);
  const big = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'big.jpg', { type: 'image/jpeg' });
  await assert.rejects(W.uploadEvidence('tok', 'task', 'proof_photo', big), /max 8 MB/);
  assert.equal(calls.rpc.length, 0); assert.equal(calls.upload.length, 0);
  const odd = harness({ bucket: 'task-proof', path: '../other-bucket/x.html', mime: 'text/html' });
  await assert.rejects(odd.W.uploadEvidence('tok', 'task', 'proof_photo', jpeg), /upload not available/);
  assert.equal(odd.calls.upload.length, 0);
  const voice = harness({ bucket: 'task-proof', path: KEY + '.webm', mime: 'audio/webm' });
  assert.equal(await voice.W.uploadEvidence('tok', 'task', 'reject_voice', webm), KEY + '.webm');
});

await t('respondEvidence maps the sheet onto the RPC (nulls when empty, whole seconds)', async () => {
  const { W, calls } = harness(null);
  await W.respondEvidence('tok', 'task', 'reject', { reason: 'Van broke', voicePath: KEY + '.webm', voiceSeconds: 41.6 });
  await W.respondEvidence('tok', 'task', 'complete', { photoPaths: [KEY + '.jpg'] });
  await W.respondEvidence('tok', 'task', 'complete', { photoPaths: [] });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.rpc)), [
    ['worker_respond_evidence', { p_token: 'tok', p_task_id: 'task', p_action: 'reject', p_reason: 'Van broke', p_voice_path: KEY + '.webm', p_voice_seconds: 42, p_photo_paths: null }],
    ['worker_respond_evidence', { p_token: 'tok', p_task_id: 'task', p_action: 'complete', p_reason: null, p_voice_path: null, p_voice_seconds: null, p_photo_paths: [KEY + '.jpg'] }],
    ['worker_respond_evidence', { p_token: 'tok', p_task_id: 'task', p_action: 'complete', p_reason: null, p_voice_path: null, p_voice_seconds: null, p_photo_paths: null }],
  ]);
});

// ---- behaviour: ops.html evidence view against a stub DOM ------------------------------
await t('ops.html: evidence button + modal render reason / voice / photos, all escaped, 300 s links', async () => {
  const src = ops.slice(ops.indexOf('/* ---- crew evidence (0038)'), ops.indexOf('$("#ev_close").addEventListener'));
  assert.ok(src.length > 500, 'ops evidence block not found');
  const escSrc = ops.match(/const esc=\(s\)=>[^\n]*\n/)[0];
  const els = {}; const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', hidden: true });
  const signed = [];
  const ctx = {
    String, Math, Promise,
    $: (s) => el(s.replace('#', '')),
    fmtTime: (x) => 'T' + x,
    BPUI: { friendlyError: () => 'err' },
    BPStore: { ops: { evidenceUrls: async (paths, secs) => { signed.push([paths, secs]);
      return Object.fromEntries(paths.map((p) => [p, 'https://x.supabase.co/sign/' + p + '?token="><img src=x onerror=alert(2)>'])); } } },
  };
  vm.createContext(ctx);
  vm.runInContext(escSrc + src + `
    var tasks=[{id:'t1',title:'Stage <b>',assignee_name:'Ravi'},{id:'t2',title:'Lights'}];
    var evidence=[
      {task_id:'t1',kind:'reject_reason',body:'<img src=x onerror=alert(1)> sick',worker_name:'Ravi "R"',created_at:'c1'},
      {task_id:'t1',kind:'reject_voice',storage_path:'${KEY}.webm',mime:'audio/webm',duration_s:75,worker_name:'Ravi',created_at:'c2'},
      {task_id:'t2',kind:'proof_photo',storage_path:'${KEY}.jpg',mime:'image/jpeg',worker_name:'Ana',created_at:'c3'}];
    globalThis.__btn1=evidenceBtn(tasks[0]); globalThis.__btn2=evidenceBtn(tasks[1]); globalThis.__btn3=evidenceBtn({id:'none',title:'x'});
    globalThis.__open=openEvidence;`, ctx);
  assert.match(ctx.__btn1, /class="btn sm evid"/); assert.match(ctx.__btn1, /💬 reason · 🎙 voice/);
  assert.match(ctx.__btn1, /aria-label="View crew notes and photos for Stage &lt;b&gt;"/);
  assert.match(ctx.__btn2, /📷 1/); assert.equal(ctx.__btn3, '');
  await ctx.__open('t1');
  const body = els.ev_body.innerHTML;
  assert.equal(els.evModal.hidden, false);
  assert.match(body, /&lt;img src=x onerror=alert\(1\)&gt; sick/);
  assert.doesNotMatch(body, /<img src=x/);
  assert.match(body, /Ravi &quot;R&quot;/);
  assert.match(body, /🎙 Voice note \(1:15\)/);
  assert.match(body, /<audio controls preload="none" src="https:\/\/x\.supabase\.co\/sign\/[^"]*&quot;&gt;&lt;img src=x onerror=alert\(2\)&gt;"><\/audio>/);
  assert.equal(els.ev_task.textContent, 'Stage <b> — Ravi');   // textContent, not HTML
  await ctx.__open('t2');
  assert.match(els.ev_body.innerHTML, /<a href="[^"]+" target="_blank" rel="noopener noreferrer" aria-label="Open proof photo 1"><img src="[^"]+" alt="Proof photo 1" loading="lazy"><\/a>/);
  assert.deepEqual(signed.map((s) => s[1]), [300, 300]);
  // the Live status row carries the button and the dashboard poll refreshes evidence
  assert.match(ops, /\$\{verifyChip\(t\)\}\s*\n\s*\$\{evidenceBtn\(t\)\}/);
  assert.match(ops, /BPStore\.ops\.listEvidence\(quoteId\)\.catch\(\(\)=>evidence\)/);
  assert.match(ops, /<div class="lmodal" id="evModal" hidden role="dialog" aria-modal="true" aria-labelledby="ev_title">/);
});

console.log(`worker-evidence-ui: ${n} checks passed.`);
