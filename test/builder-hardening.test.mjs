#!/usr/bin/env node
/* builder-hardening.test.mjs — source-level + small vm checks for the Oct-2026 builder audit (B1-B12, L4). */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const js = readFileSync(join(ROOT, 'public/builder.js'), 'utf8');
const js3d = readFileSync(join(ROOT, 'public/builder-3d.js'), 'utf8');
const flow = readFileSync(join(ROOT, 'public/flow.html'), 'utf8');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

ok(/if\(!currentQuoteId\) \$\('#projName'\)\.value=\(file\.name/.test(js), 'B1 import only renames when no quote is open');
ok(/MAX_ITEMS=3000, MAX_BLOCK_SEATS=5000, MAX_IMPORT_BYTES=5\*1024\*1024, MAX_CAPACITY=100000/.test(js), 'B2 caps defined');
ok(/file\.size>MAX_IMPORT_BYTES/.test(js) && /data\.items\.slice\(0,MAX_ITEMS\)/.test(js), 'B2 file + item caps enforced');
ok(/MAX_CHAIRS_3D/.test(js3d) && /chairs\.push=function/.test(js3d), 'B2 3D stops pushing chairs at cap');
{
  const m = js.match(/function sanitizeItem\(it\)\{[\s\S]*?\n\}/); ok(m, 'sanitizeItem found');
  const f = new Function('clamp', 'CATS', 'catColor', 'nid', 'MAX_BLOCK_SEATS', m[0] + '; return sanitizeItem;')(
    (v, a, b) => Math.max(a, Math.min(b, v)), { structure: 1 }, () => '#000', () => 'x', 5000);
  const it = f({ type: 'seatblock', properties: { rows: 1000, cols: 1000 } });
  ok(it.properties.rows * it.properties.cols <= 5000, 'B2 1000x1000 block capped');
  const t = f({ type: 'seatblock', properties: { rows: 10, cols: 14 } }); ok(t.properties.cols === 14, 'normal block untouched');
}
ok(/try\{ if\(!built\) initScene\(\);[\s\S]*?catch\(e\)[\s\S]*?deactivate\(\);/.test(js3d), 'B3 initScene guarded, falls back to 2D');
ok(/raf=requestAnimationFrame\(loop\);[^\n]*\n\s*try\{ controls\.update/.test(js3d), 'B4 loop reschedules first');
ok(/webglcontextlost/.test(js3d) && /webglcontextrestored/.test(js3d), 'B4 context handlers');
ok(/if\(mod\|\|e\.altKey\) return;[^\n]*\n\s*const step=/.test(js), 'B5 modifier guard before r/d');
ok(/addEventListener\("pageshow"/.test(flow) && /leaving=false/.test(flow), 'B6 pageshow resets leaving');
ok(/versionNo===1 && \+q\.currentVersion===1/.test(js), 'B7 preset only for v1');
ok(/applyLayout\(ver\.data\);\s+\/\/ also restores/.test(js), 'B7 empty version still applies hall/capacity');
ok(/version data unreadable/.test(js) && /has unreadable data/.test(js), 'B8 malformed version locks / errors');
ok(/WORLD\.w = DEFAULT_WORLD\.w; WORLD\.h = DEFAULT_WORLD\.h; store\.venue = \{ capacity:null \}/.test(js), 'B9 defaults reset in applyLayout');
ok(/bps\.clip\.'\+userKey\(\)/.test(js) && /slice\(0,500\)/.test(js), 'B10 per-user capped clipboard');
ok(/Math\.min\(v,MAX_CAPACITY\)/.test(js), 'B11 capacity capped');
ok(/bps\.draft\./.test(js) && /Restore unsaved draft\?/.test(js) && /noteSavedVersion\(v, label\);\n\s*clearDraft\(\);/.test(js), 'B12 local draft + restore prompt + cleared on save');
ok(!/BPStore[^\n]*draft|draft[^\n]*BPStore\.(quotes|create|update)/i.test(js), 'B12 draft never touches the server');
ok(!/applyReadonly\('locked/.test(js) && /Editing is locked/.test(js), 'L4 own wording');
console.log('builder-hardening: ' + n + ' checks passed');
