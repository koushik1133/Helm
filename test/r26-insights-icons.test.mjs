// r26: Insights/Reports period chips (Last 30/60/90 days removed; "Last day" = yesterday and "Today" added,
// remembered old choices fall back to This month) + one line-icon set for buttons, the rail and workspace cards.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const API = read('public/store-api.js'), RB = read('public/range-bar.js'), SBS = read('public/shell-b-style.js'),
  SBC = read('public/shell-b-style.css'), SB = read('public/shell-b.js'), Q = read('public/quotes.html');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const constSrc = (src, name) => { const at = src.indexOf(`const ${name} =`); assert.ok(at >= 0, name); return src.slice(at, src.indexOf(';\n', at) + 1); };
const ctx = {};
vm.runInNewContext([constSrc(API, 'RANGE_PRESETS'), fnSrc(API, 'rangeFor'), 'globalThis.X={RANGE_PRESETS,rangeFor};'].join('\n'), ctx);
const X = ctx.X, J = (v) => JSON.parse(JSON.stringify(v));

t('presets: Today · Last day · This month · Last month · This year · Custom range (no 30/60/90 days)', () => {
  assert.deepEqual(J(X.RANGE_PRESETS.map((p) => p[1])), ['Today', 'Last day', 'This month', 'Last month', 'This year', 'Custom range']);
  assert.ok(!X.RANGE_PRESETS.some((p) => /^last_(30|60|90)$/.test(p[0])));
});
t('Last day = yesterday (one full day), Today = today; month/year edges', () => {
  const d = new Date(2026, 9, 21);
  assert.deepEqual(J(X.rangeFor('yesterday', d)), { from: '2026-10-20', to: '2026-10-20' });
  assert.deepEqual(J(X.rangeFor('today', d)), { from: '2026-10-21', to: '2026-10-21' });
  assert.deepEqual(J(X.rangeFor('yesterday', new Date(2026, 10, 1))), { from: '2026-10-31', to: '2026-10-31' });
  assert.deepEqual(J(X.rangeFor('yesterday', new Date(2027, 0, 1))), { from: '2026-12-31', to: '2026-12-31' });
  assert.deepEqual(J(X.rangeFor('yesterday', new Date(2028, 2, 1))), { from: '2028-02-29', to: '2028-02-29' });
});
t('range bar: studio-day "today", unknown remembered key → This month, tooltip "Yesterday, dd/mm/yyyy"', () => {
  assert.match(RB, /function studioNow\(\)/);
  assert.match(fnSrc(RB, 'studioNow'), /BPStore\.todayLocal\(\)/);
  assert.doesNotMatch(RB, /rangeFor\([^)]*new Date\(\)\)/);
  assert.match(RB, /known\(saved\.key\) \? saved\.key : def/);
  assert.match(RB, /"Yesterday, "/);
  assert.match(RB, /r\.from === r\.to \? ""/);   // a one-day range shows one date
});
t('icons: Ops uses the clipboard-check icon, no gear emoji in the quotes list', () => {
  assert.match(Q, /data-act="ops"[^>]*data-ico="ops">Ops<\/button>/);
  assert.doesNotMatch(Q, /⚙ Ops/);
  assert.match(SBS, /ops: "M9 3h6/);
  assert.match(SB, /ops: "M9 3h6/);
  assert.match(SBS, /getAttribute\("data-ico"\)/);
});
t('icons: one set — the swap cog matches the rail cog; remaining button emoji are mapped', () => {
  const railCog = /controls: "([^"]+)"/.exec(SB)[1];
  assert.equal(/gear: "([^"]+)"/.exec(SBS)[1], railCog);
  for (const e of ['↺', '↧', '⬇', '✕', '✗', '💲', '🏛', '🎫', '🛟', '🎨', '🎙', '⏱', '🎛', '🧩', '🚦']) assert.ok(SBS.includes(`"${e}": "`), e + ' not mapped');
  const P = SBS.slice(SBS.indexOf('var P = {'), SBS.indexOf('var MAP'));
  const names = new Set([...P.matchAll(/^\s+(\w+): "/gm)].map((m) => m[1]));
  for (const m of SBS.slice(SBS.indexOf('var MAP'), SBS.indexOf('var RE')).matchAll(/": "(\w+)"/g)) assert.ok(names.has(m[1]), 'missing path ' + m[1]);
  assert.match(SBS, /\.mod \.h > \.ic"/);
  assert.match(SBC, /button\.ic:has\(> \.sb-ico\) \{ display: inline-flex; align-items: center/);
});
console.log(`\n${n} r26 insights/icons checks passed`);
