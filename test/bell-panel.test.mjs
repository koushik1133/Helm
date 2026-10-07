// Notification bell panel (Oct 2026 redesign).
// Pins the pure view (bellPanelView): Today / Yesterday / Earlier grouping, the filter tabs
// (Payments only when the feed carries payment rows), unread counting, links, and that
// every server / chat string is escaped. Plus static checks on the mount: blurred scrim with
// a solid fallback, dialog semantics + own focus trap (BPUI skip), Esc / arrows, reduced
// motion, phone sheet, and the unchanged data flow (feed + chat merge + 0036 hidden types).
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const api = readFileSync(new URL('../public/store-api.js', import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const ctx = {}; vm.runInNewContext(['bellLabel', 'bellPanelView'].map((f) => fnSrc(api, f)).join('\n') + '\nglobalThis.view=bellPanelView; globalThis.label=bellLabel;', ctx);
const view = (items, filter, now) => JSON.parse(JSON.stringify(ctx.view(items, { filter, now, label: ctx.label })));   // plain objects (vm realm)

// a fixed local "now": 7 Oct 2026, 15:00 local time
const NOW = new Date(2026, 9, 7, 15, 0, 0).getTime();
const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).toISOString();
const FEED = [
  { id: 'n1', kind: 'task_assigned', detail: { count: 3, category: 'Decor' }, quote_id: 'q-1', event_code: 'C-101', event_title: 'Sharma wedding', created_at: at(7, 14, 30), unread: true },
  { id: 'n2', kind: 'payment_received', detail: {}, quote_id: 'q-2', event_code: 'C-102', created_at: at(6, 11), unread: false },
  { id: 'n3', kind: 'design_moodboard', detail: {}, quote_id: null, created_at: at(1, 9), unread: false },
  { __chat: true, conversation_id: 'g1', kind: 'group', title: 'Crew', who: 'Ravi', preview: 'on my way', created_at: at(7, 14, 58), count: 3 },
  { __chat: true, conversation_id: 'g2', kind: 'mention', mention: true, title: 'Asha mentioned you in Decor', who: '', preview: '@You call client', created_at: at(6, 20), count: 1 },
];

t('groups rows into Today / Yesterday / Earlier, newest first', () => {
  const v = view(FEED, 'all', NOW);
  const days = [...v.html.matchAll(/<div class="bpb-day"[^>]*>([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(days, ['Today', 'Yesterday', 'Earlier']);
  const keys = [...v.html.matchAll(/data-k="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys, ['c:g1', 'n:n1', 'c:g2', 'n:n2', 'n:n3']);
  assert.match(v.html, /<time datetime="[^"]+">2m<\/time>/);      // 14:58 → 2m
  assert.match(v.html, /<time datetime="[^"]+">30m<\/time>/);
  assert.match(v.html, /<time datetime="[^"]+">6d<\/time>/);      // 1 Oct
});

t('filter tabs: counts, Payments only when present, unknown filter falls back to All', () => {
  const v = view(FEED, 'all', NOW);
  assert.deepEqual(v.tabs.map((x) => [x.id, x.count]), [['all', 5], ['mentions', 1], ['tasks', 1], ['payments', 1], ['chat', 2]]);
  assert.match(v.tabsHtml, /role="tab"[^>]*id="bpBellTab-all"[^>]*aria-selected="true"[^>]*tabindex="0"/);
  const noPay = view(FEED.filter((x) => x.kind !== 'payment_received'), 'payments', NOW);
  assert.equal(noPay.tabs.some((x) => x.id === 'payments'), false);
  assert.equal(noPay.filter, 'all');
  assert.doesNotMatch(noPay.tabsHtml, /Payments/);
  assert.equal(view(FEED, 'bogus', NOW).filter, 'all');
});

t('each filter shows only its rows; Chat includes mentions', () => {
  const keys = (f) => [...view(FEED, f, NOW).html.matchAll(/data-k="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(keys('mentions'), ['c:g2']);
  assert.deepEqual(keys('tasks'), ['n:n1']);
  assert.deepEqual(keys('payments'), ['n:n2']);
  assert.deepEqual(keys('chat'), ['c:g1', 'c:g2']);
  const v = view(FEED, 'tasks', NOW);
  assert.match(v.tabsHtml, /id="bpBellTab-tasks"[^>]*aria-selected="true"/);
  assert.match(v.tabsHtml, /id="bpBellTab-all"[^>]*aria-selected="false"[^>]*tabindex="-1"/);
});

t('rows: type chip per group, bold title, preview, unread dot, links to the target', () => {
  const h = view(FEED, 'all', NOW).html;
  assert.match(h, /<a class="bpb-item g-task is-unread" href="event\.html\?id=q-1" data-k="n:n1"><span class="bpb-chip" aria-hidden="true">🛠️<\/span><span class="bpb-body"><span class="bpb-t">3 task\(s\) assigned · Decor<\/span><span class="bpb-p">C-101 · Sharma wedding<\/span>/);
  assert.match(h, /<a class="bpb-item g-payment" href="event\.html\?id=q-2"/);       // read → no is-unread
  assert.match(h, /<div class="bpb-item g-other" tabindex="0" data-k="n:n3">/);       // no quote → not a link, still focusable
  assert.match(h, /<a class="bpb-item g-chat is-unread" href="chat\.html\?c=g1"[^>]*><span class="bpb-chip" aria-hidden="true">💬<\/span><span class="bpb-body"><span class="bpb-t">Crew · Ravi <span class="bpb-c">\(3\)<\/span>/);
  assert.match(h, /<a class="bpb-item g-mention is-unread" href="chat\.html\?c=g2"[^>]*><span class="bpb-chip" aria-hidden="true">@<\/span>/);
  assert.equal((h.match(/class="bpb-u"/g) || []).length, 3);
  assert.match(h, /<span class="sr-only">Unread<\/span>/);
});

t('unread = unread server rows + chat message counts', () => {
  assert.equal(view(FEED, 'all', NOW).unread, 1 + 3 + 1);
  assert.equal(view([], 'all', NOW).unread, 0);
});

t('escaping: server + chat text never becomes markup; ids are URL-encoded', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const v = view([
    { id: '"><b>', kind: 'task_accept', detail: { worker: evil }, quote_id: 'q"/><script>', event_code: evil, event_title: '"quoted" & \'x\'', created_at: at(7, 10), unread: true },
    { __chat: true, conversation_id: 'c"><svg onload=1>', kind: 'dm', title: evil, who: '<i>Mallory</i>', preview: '</a><script>alert(1)</script>', created_at: at(7, 9), count: 1 },
    { __chat: true, conversation_id: 'g', kind: 'group', title: '<u>T</u>', who: '<s>W</s>', preview: 'p', created_at: at(7, 8), count: 1 },
    { kind: '<script>x</script>', detail: {}, created_at: 'not a date' },
  ], 'all', NOW);
  assert.doesNotMatch(v.html, /<img|<script|<svg|<i>|<u>|<s>|<b>/);
  assert.match(v.html, /Task accepted by &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(v.html, /&quot;quoted&quot; &amp; &#39;x&#39;/);
  assert.match(v.html, /href="event\.html\?id=q%22%2F%3E%3Cscript%3E"/);
  assert.match(v.html, /href="chat\.html\?c=c%22%3E%3Csvg%20onload%3D1%3E"/);
  assert.match(v.html, /data-k="n:&quot;&gt;&lt;b&gt;"/);
  assert.match(v.html, /<span class="bpb-t">&lt;i&gt;Mallory&lt;\/i&gt;<\/span>/);        // DM title = sender
  assert.match(v.html, /&lt;u&gt;T&lt;\/u&gt; · &lt;s&gt;W&lt;\/s&gt;/);
  assert.match(v.html, /&lt;\/a&gt;&lt;script&gt;/);
  // a row without a usable date still renders (Earlier, no time) instead of throwing
  assert.match(v.html, /aria-label="Earlier"/);
  assert.match(v.html, /&lt;script&gt;x&lt;\/script&gt;/);
});

t('empty states per filter', () => {
  assert.match(view([], 'all', NOW).html, /class="bpb-empty"[\s\S]*You’re all caught up/);
  assert.match(view(FEED.filter((x) => !x.mention), 'mentions', NOW).html, /No mentions/);
  assert.match(view([FEED[1]], 'chat', NOW).html, /No unread messages/);
});

t('mount: blurred scrim with a solid fallback, phone sheet, reduced motion, light + dark tokens', () => {
  assert.match(api, /\.bpb-scrim\{position:absolute;inset:0;background:var\(--bpb-scrim\)/);
  assert.match(api, /@supports \(\(-webkit-backdrop-filter:blur\(1px\)\) or \(backdrop-filter:blur\(1px\)\)\)\{\.bpb-scrim\{[^}]*backdrop-filter:blur\(8px\)/);
  assert.match(api, /@media \(max-width:640px\)\{/);
  assert.match(api, /@media \(prefers-reduced-motion:reduce\)\{\.bpb-root \.bpb-scrim,\.bpb-root \.bpb-panel/);
  assert.match(api, /html\[data-theme=dark\] \.bpb-root\{/);
  assert.match(api, /if \(reduced\(\)\) hide\(\); else closeTimer = setTimeout\(hide, 280\);/);
});

t('mount: dialog semantics, own focus trap (BPUI skip), Esc closes, arrows walk rows / tabs', () => {
  assert.match(api, /id="bpBellBtn" class="bpb-btn"[^`]*aria-haspopup="dialog" aria-expanded="false" aria-controls="bpBellPanel"/);
  assert.match(api, /id="bpBellPanel" class="bpb-panel" role="dialog" aria-modal="true" aria-labelledby="bpBellTitle" tabindex="-1" data-bpui-skip/);
  assert.match(api, /if \(e\.key === "Escape" \|\| e\.key === "Esc"\) \{ e\.preventDefault\(\); e\.stopPropagation\(\); close\(\); return; \}/);
  assert.match(api, /if \(e\.key === "Tab"\) \{\s*const f = focusables\(\);/);
  assert.match(api, /\["ArrowDown", "ArrowUp", "Home", "End"\]/);
  assert.match(api, /e\.key === "ArrowLeft" \|\| e\.key === "ArrowRight"/);
  assert.match(api, /document\.body\.appendChild\(root\);/);                // portalled: headers can't clip it
  assert.match(api, /const v = bellPanelView\(lastItems, \{ filter, now: Date\.now\(\), label: bellLabel \}\);/);
});

t('mount keeps the data flow: feed + chat merge, 0036 hidden chat, markSeen on open, live refresh', () => {
  assert.match(api, /const chatOff = hiddenTypes\.indexOf\("chat_message"\) !== -1;/);
  assert.match(api, /if \(chatOff\) chatItems = chatItems\.filter\(\(c\) => c && c\.mention\);/);
  assert.match(api, /lastItems = mergedFeed\(f && f\.items\); loaded = true; render\(\);\s*try \{ await this\.markSeen\(\); \} catch \{\} setDot\(0\);/);
  assert.match(api, /chat\.subscribe\(function \(\) \{ refresh\(\); \}, function \(\) \{\}, "chat-rt-bell"\)/);
  assert.match(api, /window\.__bpBellRefresh = refresh;/);
  assert.match(api, /label: bellLabel,/);
  assert.doesNotMatch(fnSrc(api, 'bellPanelView'), /innerHTML|document\./);   // pure: returns strings only
});

console.log(`\nbell-panel: ${n} passed`);
