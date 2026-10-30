// r52-notif-clear.test.mjs - r52 bug report "notifications are not clearing" (frontend side).
// Root causes found with a stubbed-Supabase browser run (fake project host, every other request blocked):
//  1  bell "Mark all read" only cleared the server rows - every unread team CHAT stayed in the dot and "N new", so with
//     any unread chat the badge never reached 0 (5 + 3 chat -> "3" after Mark all read, still "3" after a poll)
//  2  a refused mark (two-step / rate limit / time-out) was swallowed: Mark all read did nothing visible, and opening
//     the bell zeroed the dot even when bell_mark_seen failed - the old number came back on the next poll
//  3  the dashboard "N unread" badge had its own source (my_pending, notification_seen only): reading rows one by one
//     never lowered it and it did not follow the bell on the same page
//  4  a bell row with nowhere to go (no event / page) could not be cleared by clicking it
//  5  opening a notification from its toast marked it read in this browser only (the inbox never learnt it); "Mark
//     unread" lost to this browser's earlier local read mark
//  6  a poll that started before Mark all read and answered after it could show the old count again (now not drawn)
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const api = rd('public/store-api.js'), dash = rd('public/dashboard.html'), shell = rd('public/shell-b.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const events = [];
const ctx = { global: null, console: { warn: () => {} }, CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o && o.detail; } } };
ctx.global = { dispatchEvent: (e) => events.push(e), HelmTelemetry: { report: (k, e) => events.push({ type: 'tele', k, e }) } };
vm.runInNewContext(['bellChatKey', 'bellAllReadPatch', 'bellPublish', 'bellWarn'].map((f) => fnSrc(api, f)).join('\n')
  + '\nglobalThis.patch=bellAllReadPatch; globalThis.pub=bellPublish; globalThis.warn=bellWarn; globalThis.key=bellChatKey;', ctx);
const plain = (v) => JSON.parse(JSON.stringify(v));
const C1 = '44444444-4444-4444-8444-444444444444', C2 = '55555555-5555-4555-8555-555555555555';

t('bellAllReadPatch: server rows read, chat rows keyed + their conversations listed once (bell list + fresher chat items)', () => {
  const items = [
    { id: 'n1', kind: 'task_assigned', unread: true, returned: true, created_at: 'a' },
    { id: 'n2', kind: 'payment_received', unread: false, created_at: 'b' },
    { __chat: true, conversation_id: C1, created_at: 'c', count: 3 },
  ];
  const chats = [{ conversation_id: C1, created_at: 'c', count: 3 }, { conversation_id: C2, created_at: 'd', count: 1, mention: true }, { conversation_id: 'bad id', created_at: 'e' }];
  const p = plain(ctx.patch(items, chats));
  assert.deepEqual(p.items.map((x) => !!x.unread), [false, false, false]);
  assert.equal(p.items[0].returned, false, 'a row back from snooze is no longer flagged');
  assert.equal(items[0].unread, true, 'the input is not changed');
  assert.deepEqual(p.chatKeys, ['c:' + C1 + '@c', 'c:' + C2 + '@d', 'c:bad id@e']);
  assert.deepEqual(p.convs, [C1, C2], 'only real conversation ids go to chat_mark_read');
  assert.deepEqual(plain(ctx.patch(null, undefined)), { items: [], chatKeys: [], convs: [] });
});

t('bellPublish: one count on window + a helm:bell-count event; bellWarn logs + reports (never throws)', () => {
  events.length = 0;
  ctx.pub({ server: 2, chat: 1, total: 3 });
  assert.equal(ctx.global.__bpBellCount.total, 3);
  assert.equal(events[0].type, 'helm:bell-count'); assert.equal(events[0].detail.server, 2);
  ctx.warn('mark all read', { code: '54000', message: 'Too many changes' });
  assert.equal(events[1].k, 'bell_mark_all_read');
  ctx.global.HelmTelemetry = { report: () => { throw new Error('x'); } }; ctx.warn('x', null);   // no throw
});

const mount = api.slice(api.indexOf('    async mount(el) {'), api.indexOf('/* ---------------- client portal (Phase 53)'));
t('Mark all read: optimistic clear, chats marked read on the server, errors shown, refresh after', () => {
  const h = mount.slice(mount.indexOf('root.querySelector("#bpBellClear")'), mount.indexOf('// keyboard: Esc closes'));
  assert.match(h, /const patch = bellAllReadPatch\(lastItems, chatItems\); mutGen\+\+;/);
  assert.match(h, /lastItems = patch\.items; patch\.chatKeys\.forEach/);
  assert.match(h, /setDot\(0\);/);
  assert.match(h, /try \{ if \(inboxOn\) await inbox\.readAll\(\); else await this\.markSeen\(\); \} catch \(x\) \{ err = x; bellWarn\("mark all read", x\); \}/);
  assert.match(h, /chat\.markRead\(id, \{ strict: true \}\)/);
  assert.match(h, /if \(err\) say\(/);
  assert.match(h, /mutGen\+\+; await refresh\(\); b\.disabled = false;/);
  assert.doesNotMatch(h, /catch \{\}/, 'no silent catch left');
});
t('chat.markRead(id, { strict }) throws only when asked (the chat page keeps the quiet form)', () => {
  assert.match(api, /async markRead\(convId, opts\) \{/);
  assert.match(api, /catch \(e\) \{ if \(opts && opts\.strict\) throw e; \}/);
});
t('refresh: an answer that started before a local change is not drawn (no flicker back to the old count)', () => {
  assert.match(mount, /const refreshNow = async \(\) => \{ lastRf = Date\.now\(\); const g = mutGen; const f = await safeFeed\(\);/);
  assert.match(mount, /if \(g !== mutGen\) return f;\n\s+setDot\(serverUnread\(f\)\);/);
});
t('opening the bell: the dot only goes to 0 when bell_mark_seen worked', () => {
  assert.match(mount, /try \{ await this\.markSeen\(\); mutGen\+\+; setDot\(0\); \}/);
  assert.match(mount, /catch \(x\) \{ bellWarn\("mark seen", x\); setDot\(serverUnread\(f\)\); \} \}/);
});
t('rows: link-less rows clear on click / Enter; toast open tells the inbox; Mark unread beats the local read mark', () => {
  assert.match(mount, /const dv = !it && e\.target\.closest && e\.target\.closest\("div\.bpb-item\[data-k\]"\);\n\s+if \(dv\) rowRead\(dv\.getAttribute\("data-k"\)\);/);
  assert.match(mount, /\(e\.key === "Enter" \|\| e\.key === " "\) && ae && ae\.matches && ae\.matches\("div\.bpb-item\[data-k\]"\)/);
  assert.match(mount, /const sid = serverIdOf\(x\.rk\); if \(sid\) inbox\.act\(\[sid\], "read"\)/);
  assert.match(mount, /if \(action === "unread" \|\| action === "undone" \|\| action === "unsnooze"\) \{ readKeys = readKeys\.filter\(\(x\) => x !== "n:" \+ id\); saveRead\(\); \}/);
});
t('one count for the page: setDot publishes; dashboard badge + chat badges follow it', () => {
  assert.match(mount, /bellPublish\(\{ server: Math\.max\(0, serverUnread \|\| 0\), chat: chatN, total: Math\.max\(0, total\) \}\);/);
  assert.match(dash, /window\.addEventListener\("helm:bell-count", \(e\) => \{ const ub = \$\("#unreadBadge"\)/);
  assert.match(dash, /unread = bc \? \(Number\(bc\.server\) \|\| 0\) : \(\(res && res\.unread\) \|\| 0\)/);
  assert.match(shell, /window\.addEventListener\("helm:bell-count", function \(e\) \{ var c = e && e\.detail \? e\.detail\.chat : null; if \(c === lastBellChat\) return;/);
});

// the dashboard badge listener, run for real
t('dashboard: the badge shows the bell count, hides at 0', () => {
  const at = dash.indexOf('  try { window.addEventListener("helm:bell-count"'), src = dash.slice(at, dash.indexOf('\n', dash.indexOf('\n', at) + 1));
  let cb = null; const ub = { hidden: false, textContent: '5 unread' };
  vm.runInNewContext(src, { window: { addEventListener: (ty, f) => { if (ty === 'helm:bell-count') cb = f; } }, $: () => ub, Number });
  cb({ detail: { server: 2 } }); assert.equal(ub.textContent, '2 unread'); assert.equal(ub.hidden, false);
  cb({ detail: { server: 0 } }); assert.equal(ub.hidden, true);
});
console.log(`r52-notif-clear: ${n} ok`);
