// Phone input (HelmPhone) must look exactly like its sibling inputs: same font-size / line-height /
// height / padding, placeholder included. Static checks always; a headless-Chromium computed-style
// check runs when Playwright is installed (it is skipped, not failed, when it isn't).
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
const root = new URL('../public/', import.meta.url);
const read = (p) => readFileSync(new URL(p, root), 'utf8');
const css = read('theme.css'), js = read('phone-input.js');
const t = (n, f) => { f(); console.log('  ✓ ' + n); };

t('no hard-coded phone font sizes; wrapper + number + picker read the page metrics', () => {
  const blk = css.slice(css.indexOf('International phone input'), css.indexOf('Inline validation'));
  assert.doesNotMatch(blk.replace(/@media[^\n]*/g, '').replace(/\.hp-pop[\s\S]*?\.hp-empty\{[^}]*\}/, ''), /\.hp-num[^}]*font-size:1[56]px/);
  assert.match(blk, /\.hp\{[^}]*font-size:var\(--hp-fs,inherit\)/); assert.match(blk, /min-height:var\(--hp-h,38px\)/);
  assert.match(blk, /\.hp \.hp-cc\{[^}]*font-size:var\(--hp-fs,inherit\)/);
  assert.match(blk, /input\.hp-num\{[^}]*font-size:var\(--hp-fs,inherit\)!important/);
  assert.match(blk, /input\.hp-num::placeholder\{font-size:inherit\}/);
  assert.match(blk, /\.hp-flag\{font-size:1\.2em/);
});
t('phone-input.js measures the input before restyling it', () => {
  assert.match(js, /function matchSiblingMetrics\(wrap, input\)/);
  assert.ok(js.indexOf('matchSiblingMetrics(wrap, input);') < js.indexOf('input.classList.add("hp-num")'));
  for (const k of ['--hp-fs', '--hp-lh', '--hp-h', '--hp-py', '--hp-px', '--hp-r']) assert.ok(js.includes(`"${k}"`), k);
});
t('every page loads the new phone + theme versions', () => {
  for (const f of readdirSync(root).filter((x) => x.endsWith('.html'))) {
    const h = read(f);
    for (const m of h.matchAll(/phone-input\.js\?v=(\d+)/g)) assert.equal(m[1], '7', f);
    for (const m of h.matchAll(/theme\.css\?v=(\d+)/g)) assert.equal(m[1], '83', f);
  }
  assert.match(read('store-api.js'), /var PHONE_LIB_V = "7"/); assert.match(read('auth-ui.js'), /PHONE_LIB_V = "7"/);
});

let pw = null; try { pw = await import('playwright'); } catch (e) {}
if (!pw) { console.log('  - headless computed-style check skipped (playwright not installed)'); console.log('phone-font: ok'); process.exit(0); }
const dir = path.resolve(new URL('.', root).pathname);
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(new URL(q.url, 'http://x').pathname); const f = path.join(dir, u);
  if (!f.startsWith(dir)) { r.writeHead(403); return r.end(); }
  if (/\/config\.js$/.test(u)) { r.writeHead(200, { 'content-type': types['.js'] }); return r.end('window.SUPABASE_CONFIG={url:"",anonKey:""};'); }
  try { const b = readFileSync(f); r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(b); } catch (e) { r.writeHead(404); r.end(); }
}).listen(0);
const BASE = 'http://127.0.0.1:' + srv.address().port;
const pages = [['staff', 's_phone'], ['flow', 'c_phone'], ['quotes', 'c_phone'], ['leads', 'f_phone'], ['vendors', 'v_phone'], ['control', 'o_phone'], ['approve', 'c_phone'], ['nurture', 'n_phone']];
const br = await pw.chromium.launch(); let bad = [];
for (const [p, id] of pages) {
  const pg = await br.newPage({ viewport: { width: 1280, height: 900 } });
  await pg.route('**/*', (rt) => rt.request().url().startsWith(BASE) ? rt.continue() : rt.abort());
  await pg.goto(`${BASE}/${p}.html`, { waitUntil: 'domcontentloaded' }); await pg.waitForTimeout(600);
  const r = await pg.evaluate(async (id) => {
    const inp = document.getElementById(id); if (!inp) return { err: 'no input' };
    let n = inp; while (n) { if (n.hidden) n.hidden = false; if (getComputedStyle(n).display === 'none') n.style.display = 'block'; n = n.parentElement; }
    if (!window.HelmPhone) await new Promise((ok) => { const s = document.createElement('script'); s.src = '/phone-input.js?v=7'; s.onload = ok; s.onerror = ok; document.head.appendChild(s); });
    if (!inp.helmPhone && window.HelmPhone) window.HelmPhone.attach(inp);
    const wrap = inp.closest('.hp'); if (!wrap) return { err: 'not attached' };
    const form = wrap.parentElement.closest('form,.fgrid,.grid,.sheet,.card,section,main') || document.body;
    const sib = [...form.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not(.hp-num):not(.hp-search)')].find((x) => x.offsetParent && !x.closest('.hp'));
    if (!sib) return { err: 'no sibling' };
    const a = getComputedStyle(inp), b = getComputedStyle(sib), cc = getComputedStyle(wrap.querySelector('.hp-cc'));
    return { fs: a.fontSize, cc: cc.fontSize, sib: b.fontSize, ph: getComputedStyle(inp, '::placeholder').fontSize, wh: wrap.getBoundingClientRect().height, sh: sib.getBoundingClientRect().height };
  }, id);
  if (r.err || r.fs !== r.sib || r.cc !== r.sib || r.ph !== r.sib || Math.abs(r.wh - r.sh) > 1) bad.push(p + ' ' + JSON.stringify(r));
  await pg.close();
}
await br.close(); srv.close();
assert.deepEqual(bad, [], 'phone field differs from its sibling input');
console.log(`  ✓ headless Chromium: phone font-size / placeholder / height equal a sibling input on ${pages.length} pages`);
console.log('phone-font: ok');
