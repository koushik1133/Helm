import { readFileSync } from 'node:fs';
const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const pub = (p) => r('public/' + p);
let n = 0; const ok = (c, m) => { if (!c) { console.error('FAIL: ' + m); process.exit(1); } n++; };
const api = pub('store-api.js');
// 1 perf: shared in-flight reads, dropped on writes; bell refresh coalesced; ops/nurture boot not serial
ok(/function shareInflight\(key, fn\)/.test(api), 'shareInflight helper');
ok(/list: \(\) => (?:memoRead\("quotes\.list", MEMO_LIST_MS, \(\) => )?shareInflight\("quotes\.list"/.test(api), 'quotes.list shares in-flight read');
ok(/shareInflight\("leads\.list"/.test(api), 'leads.list shares in-flight read');
ok(/dropInflightOnWrite\(leads, "leads\.list"\)/.test(api) && /dropInflightOnWrite\(quotes, "quotes\.list"\)/.test(api), 'writes drop the shared read');
ok(/chat\.subscribe\(function \(\) \{ liveRefresh\(\); \}/.test(api) && /kicked = true; liveRefresh\(\);/.test(api), 'bell refresh coalesced');
ok(/performance\.mark\("helm:boot-done"\)/.test(api), 'boot-done mark');
const ops = pub('ops.html');
ok(/const pQuote=BPStore\.quotes\.get\(quoteId\), pCats=BPStore\.ops\.categories\(\)\.catch\(\(\)=>null\), pOps=fetchOps\(\);/.test(ops), 'ops reads start together');
ok(/await refresh\(pOps\)/.test(ops), 'ops uses the prefetched crew/tasks');
const nur = pub('nurture.html');
ok(/const extras=Promise\.all\(/.test(nur) && !/await loadClientOptions\(\); await renderAuto\(\);/.test(nur), 'nurture extras off the overlay');
// 2 toasts away from toolbars, max 2
ok(/\.bpui-toasts\{position:fixed;bottom:20px;right:16px;/.test(api) && /while \(cards\.length > 2\)/.test(api), 'toasts bottom-right, max 2');
// 3 + 4 control center: no layout-shifting banner, optimistic notify toggle
const cc = pub('control.html');
ok(!/setUMsg\("ok",`\$\{role\} · \$\{area\}/.test(cc), 'matrix save no longer uses the banner');
ok(/function npOptimistic\(btn, isCell\)/.test(cc) && /\.ncell\.saving/.test(cc), 'notify toggle optimistic + saving state');
// 6 archived leads loading / error state
const leads = pub('leads.html');
ok(/Loading archived leads…/.test(leads) && /BPUI\.loadError\(ul, err, loadArchived/.test(leads), 'archived loading + error states');
// 7 nurture one date format
ok(/d\.next_date\?esc\(BPStore\.fmtDateIN\(d\.next_date\)\)/.test(nur), 'nurture next date uses fmtDateIN');
// 8 calendar tentative + lead markers
const cal = pub('calendar.html');
ok(/stb tentative/.test(cal) && /cal-legend/.test(cal) && /BPStore\.auth\.canView\("leads"\)/.test(cal), 'calendar tentative + gated lead dates');
// 9 worker links in the default view
ok(/host\.insertAdjacentHTML\("beforeend", workerLinksBlock\(\)\)/.test(ops), 'worker links in section view');
// 10 no past task start
ok(/a task can't be scheduled to start in the past/.test(ops), 'task schedule blocks past dates');
// 11 + 5 SQL: ASCII-only, additive, verify
for (const f of ['supabase/migrations/0148_close_gate_text.sql', 'supabase/APPLY-0148.sql']) {
  const s = r(f);
  ok(!/[^\x00-\x7f]/.test(s), f + ' is ASCII-only');
  ok(!/\b(drop|truncate|delete\s+from)\b/i.test(s.replace(/--.*$/gm, '')), f + ' has no drop/truncate/delete');
  ok(/close-gate-0148/.test(s) && /audit-1017-0148/.test(s), f + ' markers');
}
ok(/select 'close gate message is ASCII-only' as item,/.test(r('supabase/APPLY-0148.sql')), 'APPLY-0148 verify select');
ok(/forward  supabase\/migrations\/0148_close_gate_text\.sql/.test(r('supabase/migrations/MANIFEST')), 'MANIFEST lists 0148');
console.log('small-1017: ' + n + ' checks passed');
