/* r23-inbox.test.mjs - 0266 notification inbox: the pure page logic (sections, snooze menu in IST, keyboard map),
   the store-api surface, the bell's inbox wiring, the page / Settings card / digest e-mail and the migration's
   safety shape. */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const require = createRequire(import.meta.url);
const C = require(join(ROOT, 'public/inbox-core.js'));
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

// 2026-10-19 10:00 IST (a Monday) = 04:30 UTC
const NOW = Date.parse('2026-10-19T04:30:00Z');
t('sections by event: newest event first, studio-wide rows apart, unread counted', () => {
  const s = C.sections([
    { id: '1', quote_id: 'q1', event_code: 'A-1', event_title: 'Wedding', created_at: '2026-10-19T03:00:00Z', unread: true },
    { id: '2', quote_id: null, created_at: '2026-10-19T04:00:00Z' },
    { id: '3', quote_id: 'q1', event_code: 'A-1', event_title: 'Wedding', created_at: '2026-10-18T03:00:00Z', unread: true },
    { id: '4', quote_id: 'q2', created_at: '2026-10-17T03:00:00Z', sort_at: '2026-10-19T04:20:00Z' },
  ], { by: 'event', now: NOW });
  assert.deepEqual(s.map((x) => x.key), ['qq2', 'studio', 'qq1']);   // q2 came back from a snooze (sort_at) -> on top
  assert.equal(s[2].title, 'A-1 · Wedding'); assert.equal(s[2].unread, 2); assert.equal(s[1].title, 'Studio-wide');
});
t('sections by date use IST days (Today / Yesterday / dd/mm/yyyy)', () => {
  const s = C.sections([{ id: 'a', created_at: '2026-10-18T19:00:00Z' }, { id: 'b', created_at: '2026-10-18T10:00:00Z' }, { id: 'c', created_at: '2026-10-16T10:00:00Z' }], { by: 'day', now: NOW });
  assert.deepEqual(s.map((x) => x.title), ['Today', 'Yesterday', '16/10/2026']);   // 19:00 UTC = 00:30 IST the 19th
});
t('snooze menu: later today / tomorrow 9 am / next Monday 9 am / custom', () => {
  const c = C.snoozeChoices(NOW, 'Asia/Kolkata');
  assert.deepEqual(c.map((x) => x.preset), ['later_today', 'tomorrow', 'next_week', 'custom']);
  assert.equal(c[0].hint, '1:00 pm'); assert.equal(c[1].hint, 'Tue 20/10, 9:00 am'); assert.equal(c[2].hint, 'Mon 26/10, 9:00 am');
  const late = C.snoozeChoices(Date.parse('2026-10-19T18:00:00Z'), 'Asia/Kolkata');   // 11:30 pm IST -> "In 3 hours"
  assert.equal(late[0].label, 'In 3 hours');
});
t('keyboard map: j / k / e / s / u / x / Enter / Esc, never with modifiers', () => {
  const k = (key, x) => C.keyAction(Object.assign({ key }, x || {}));
  assert.deepEqual(['j', 'k', 'e', 's', 'u', 'x', 'Enter', 'Escape', 'q'].map((x) => k(x)), ['next', 'prev', 'done', 'snooze', 'toggle_read', 'select', 'open', 'clear', null]);
  assert.equal(k('e', { metaKey: true }), null); assert.equal(k('s', { ctrlKey: true }), null);
});
t('when(): relative today, Yesterday, then dd/mm/yyyy', () => {
  assert.equal(C.when('2026-10-19T04:29:30Z', NOW), 'now'); assert.equal(C.when('2026-10-19T04:00:00Z', NOW), '30m');
  assert.equal(C.when('2026-10-18T10:00:00Z', NOW), 'Yesterday'); assert.equal(C.when('2026-10-10T10:00:00Z', NOW), '10/10/2026');
});

const api = read('public/store-api.js');
t('store-api: BPStore.inbox (feed / act / readAll / settings / setDigest / admin) and exported', () => {
  for (const r of ['inbox_feed', 'inbox_act', 'inbox_read_all', 'inbox_my_settings', 'inbox_set_my_digest', 'admin_get_inbox_settings', 'admin_set_inbox_settings'])
    assert.match(api, new RegExp('rpc\\("' + r + '"'));
  assert.match(api, /moneyLedger, bell, inbox, audit,/);
  assert.match(api, /\.slice\(0, 500\)/);   // bulk cap mirrors the database
});
t('bell: Done / Snooze / read-unread through the inbox, opening the bell keeps unread (setting), "Open inbox" link', () => {
  assert.match(api, /add\("Done", \(\) => serverAct\(sid, "done"/);
  assert.match(api, /add\("Snooze until tomorrow 9:00 am", \(\) => serverAct\(sid, "snooze", \{ preset: "tomorrow" \}/);
  assert.match(api, /if \(!inboxOn \|\| openMarksRead\) \{ try \{ await this\.markSeen\(\); mutGen\+\+; setDot\(0\); \}/);
  assert.match(api, /<a id="bpBellInbox" class="bpb-link" href="inbox\.html">Open inbox<\/a>/);
  assert.match(api, /if \(it\) inboxOpenRow\(it, e\);/);
});
const page = read('public/inbox.html'), js = read('public/inbox.js');
t('page: tabs, bulk bar, e-mail dialog, custom snooze, no inline scripts / handlers', () => {
  for (const id of ['ibxTab-unread', 'ibxTab-all', 'ibxTab-snoozed', 'ibxTab-done', 'ibxBulk', 'ibxMailDlg', 'ibxSnoozeDlg', 'ibxChips', 'ibxGroupBy']) assert.match(page, new RegExp('id="' + id + '"'));
  assert.doesNotMatch(page, /<script>(?!<\/script>)/); assert.doesNotMatch(page, /\son[a-z]+=/);
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write/);
});
t('shell + routes: inbox is an app page (sidebar layout, G I, noindex / no-store)', () => {
  assert.match(read('public/shell-proto.js'), /inbox: 1,/);
  assert.match(read('public/shell-b.js'), /i: \["inbox\.html", "Inbox \(notifications\)"\]/);
  assert.match(read('vercel.json'), /\|hq\|hq-referrals\|inbox\|insights\|/);
  assert.match(read('public/_headers'), /\n\/inbox\n  X-Robots-Tag: noindex/);
});
t('Settings card: studio defaults, edit gate, hidden before 0266', () => {
  const cc = read('public/inbox-settings.js'), ctl = read('public/control.html');
  assert.match(ctl, /<div class="card" id="inboxCard" hidden><\/div>/); assert.match(ctl, /inbox-settings\.js\?v=/);
  assert.match(cc, /S\.inbox\.admin\.set\(patch\)/); assert.match(cc, /if \(!cfg\.can_manage\)/); assert.match(cc, /if \(!cfg\) \{ card\.hidden = true; return; \}/);
});
const m = await import(join(ROOT, 'supabase/functions/comms-dispatch/helm-notices.mjs'));
t('digest e-mail renders and fails closed', () => {
  assert.ok(m.NOTICE_KINDS.includes('inbox_digest') && m.NOTICE_TX_REASON.inbox_digest);
  const e = m.helmNoticeEmail('inbox_digest', { studio: 'S', mode: 'daily', items: [{ title: 'Payment received', code: 'A-1', at: '19/10/2026 09:00 am' }], more: 3 }, 'https://x.test');
  assert.match(e.subject, /1 unread notification in S/); assert.match(e.text, /- Payment received \(A-1\) - 19\/10\/2026 09:00 am/);
  assert.match(e.text, /And 3 more unread/); assert.match(e.text, /https:\/\/x\.test\/inbox#settings/);
  assert.equal(m.helmNoticeEmail('inbox_digest', { items: [] }, 'https://x.test'), null);
});
const sql = read('supabase/migrations/0266_notification_inbox.sql');
t('migration: additive (no drop table / truncate / delete of existing data), wraps bell_feed once, fail-open bell', () => {
  assert.doesNotMatch(sql, /drop table|truncate|delete from public\.(?!notification_inbox_state)/i);
  assert.match(sql, /rename to bell_feed__pre0266/); assert.match(sql, /exception when others then\s+raise warning 'r23-inbox-0266: bell inbox state skipped/);
  assert.match(sql, /cron\.schedule\('helm_inbox_tick', '\*\/5 \* \* \* \*'/);
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0266_notification_inbox\.sql/);
});
console.log(`\nr23-inbox: ${n} passed`);
