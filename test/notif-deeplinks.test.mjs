// Notification deep links: every catalog type (0036 + 0054 + 0058) → the exact app page,
// with the ids the destination honours (?task= on ops, ?msg= on chat, #payments on settlement).
// Also: links are always relative to the app's own pages, ids are encoded, the bell/toast use
// the resolver, clicks mark read, and the destinations carry the anchors the focus helper needs.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import vm from 'node:vm';
const rd = (f) => readFileSync(new URL('../public/' + f, import.meta.url), 'utf8');
const api = rd('store-api.js');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const fnSrc = (src, name) => {
  const at = src.indexOf(`function ${name}(`); assert.ok(at >= 0, name + ' missing');
  let i = src.indexOf('{', src.indexOf(')', at)), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1); }
  throw new Error(name + ' unterminated');
};
const ctx = { URLSearchParams }; vm.runInNewContext(["notifLink", "bellTypeOf", "deeplinkTarget"].map((f) => fnSrc(api, f)).join('\n')
  + '\nglobalThis.link=notifLink; globalThis.typeOf=bellTypeOf; globalThis.target=deeplinkTarget;', ctx);
const Q = 'q-1', T = 't-9', base = { id: 'n1', quote_id: Q, event_code: 'C-101', detail: { task_id: T } };
const row = (kind, extra) => Object.assign({}, base, { kind }, extra || {});

// [catalog type, sample raw kind(s), expected URL]
const CASES = [
  ['approval_link', ['approval_link'], 'quotes.html?focus=C-101'],
  ['otp', ['otp'], 'quotes.html?focus=C-101'],
  ['task_assigned', ['task_assigned'], `ops.html?quote=${Q}&task=${T}`],
  ['task_update', ['task_accept', 'task_reject', 'task_start', 'task_complete'], `ops.html?quote=${Q}&task=${T}`],
  ['task_reminder', ['task_reminder'], `ops.html?quote=${Q}&task=${T}`],
  ['task_due', ['task_due'], `ops.html?quote=${Q}&task=${T}`],
  ['payment_link', ['payment_link'], `settlement.html?quote=${Q}#payments`],
  ['payment_reminder', ['payment_reminder'], `settlement.html?quote=${Q}#payments`],
  ['payment_receipt', ['payment_receipt', 'payment', 'payment_received'], `settlement.html?quote=${Q}#payments`],
  ['advance_paid', ['advance_paid'], `settlement.html?quote=${Q}#payments`],
  ['payment_reconcile', ['payment_reconcile'], `settlement.html?quote=${Q}#payments`],
  ['design_update', ['design_review', 'design_approved'], `design.html?quote=${Q}`],
  ['nurture_greeting', ['nurture_birthday'], 'nurture.html'],
  ['security_alert', ['security_alert'], 'control.html#users'],
  ['billing_trial', ['trial_reminder'], 'checkout.html'],
  ['chat_message', ['chat_message'], 'chat.html'],
  ['pkg_selected', ['pkg_selected'], `event.html?id=${Q}#pkg-selections`],
  ['pkg_accepted', ['pkg_accepted'], `event.html?id=${Q}#pkg-selections`],
  ['pkg_declined', ['pkg_declined'], `event.html?id=${Q}#pkg-selections`],
  ['pkg_payment', ['pkg_payment'], `settlement.html?quote=${Q}#payments`],
];
t('every server catalog type → expected URL (table)', () => {
  for (const [type, kinds, url] of CASES) for (const k of kinds) {
    assert.equal(ctx.typeOf(row(k)), type, k + ' type');
    assert.equal(ctx.link(row(k)), url, k);
  }
});
t('catalog coverage: every type in the SQL catalogs + bell labels has a case', () => {
  const sql = ['0036_notification_prefs.sql', '0054_security_alerts.sql', '0058_trial_reminders.sql']
    .map((f) => readFileSync(new URL('../supabase/migrations/' + f, import.meta.url), 'utf8')).join('\n');
  const types = new Set([...sql.matchAll(/"type":"([a-z_]+)"/g)].map((m) => m[1]));
  const labels = api.slice(api.indexOf('const BELL_TYPE_LABELS'), api.indexOf('};', api.indexOf('const BELL_TYPE_LABELS')));
  [...labels.matchAll(/([a-z_]+): "/g)].forEach((m) => types.add(m[1]));
  const covered = new Set(CASES.map((c) => c[0]).concat(['whatsapp_message', 'other']));
  assert.ok(types.size >= 15, 'catalog parsed: ' + [...types]);
  for (const ty of types) assert.ok(covered.has(ty), 'no deep-link case for catalog type ' + ty);
});
t('0069 pkg_*: detail.path (internal only) wins; foreign paths ignored', () => {
  const U = '0b8c2f1e-1111-4222-8333-944445555666';
  assert.equal(ctx.link({ kind: 'pkg_selected', detail: { path: 'event.html?id=' + U + '#quote', quote_id: U } }), 'event.html?id=' + U + '#pkg-selections');
  assert.equal(ctx.link({ kind: 'pkg_payment', detail: { path: 'settlement.html?quote=' + U + '#payments' } }), 'settlement.html?quote=' + U + '#payments');
  assert.equal(ctx.link({ kind: 'pkg_selected', detail: { path: 'https://evil.test/x', quote_id: U } }), 'event.html?id=' + U + '#pkg-selections');
  assert.equal(ctx.link({ kind: 'pkg_declined', detail: { path: 'javascript:alert(1)' } }), '');
  assert.equal(ctx.target('?id=' + U, '#pkg-selections'), '#pkg-selections');
});
t('whatsapp / other / reapproval fall back to the event (or quote) page', () => {
  assert.equal(ctx.link(row('whatsapp_in', { channel: 'whatsapp' })), `event.html?id=${Q}`);
  assert.equal(ctx.link(row('something_new')), `event.html?id=${Q}`);
  assert.equal(ctx.link(row('reapproval_required')), 'quotes.html?focus=C-101');
  assert.equal(ctx.link(row('approval_link', { event_code: null })), `quotes.html?focus=${Q}`);
});
t('chat + mentions open the conversation at the message', () => {
  assert.equal(ctx.link({ __chat: true, conversation_id: 'g1', msg_id: 'm7', kind: 'group' }), 'chat.html?c=g1&msg=m7');
  assert.equal(ctx.link({ __chat: true, conversation_id: 'd1', msg_id: 'm8', kind: 'mention', mention: true }), 'chat.html?c=d1&msg=m8');
  assert.equal(ctx.link({ __chat: true, conversation_id: 'g1', kind: 'dm' }), 'chat.html?c=g1');
  assert.equal(ctx.link({ __chat: true }), 'chat.html');
});
t('missing ids degrade gracefully', () => {
  assert.equal(ctx.link(row('task_due', { detail: {} })), `ops.html?quote=${Q}`);
  assert.equal(ctx.link(row('task_due', { detail: null })), `ops.html?quote=${Q}`);
  assert.equal(ctx.link(row('payment_link', { quote_id: null })), '');
  assert.equal(ctx.link(null), ''); assert.equal(ctx.link('x'), '');
});
t('links are always relative own pages; ids encoded (no injection, no external hosts)', () => {
  const evil = ['javascript:alert(1)', '//evil.com', 'https://evil.com/x', '"><svg onload=1>', '../../etc', 'a&task=b#x'];
  
  for (const e of evil) {
    const all = CASES.flatMap(([, ks]) => ks).map((k) => ctx.link(row(k, { quote_id: e, event_code: e, detail: { task_id: e } })))
      .concat([ctx.link({ __chat: true, conversation_id: e, msg_id: e })]);
    for (const u of all) {
      assert.match(u, /^[a-z0-9-]+\.html(\?[A-Za-z0-9_.~%=&()!*'-]*)?(#[a-z-]+)?$/, u);
      assert.ok(!/[<>" ]|javascript:|\/\//.test(u), u);
      const f = u.split(/[?#]/)[0]; assert.ok(rd(f).length > 0, 'page exists: ' + f);
    }
  }

});
t('destination target: allow-listed ids only', () => {
  assert.equal(ctx.target('?quote=q&task=t-9', ''), '.trow[data-id="t-9"]');
  assert.equal(ctx.target('?c=g1&msg=m_7', ''), '.m[data-mid="m_7"]');
  assert.equal(ctx.target('?quote=q', '#payments'), '#payments');
  assert.equal(ctx.target('?task=a"]x', ''), null);
  assert.equal(ctx.target('?msg=' + 'a'.repeat(65), ''), null);
  assert.equal(ctx.target('?quote=q', '#other'), null);
});
t('bell + toast use the resolver and mark read on click', () => {
  assert.equal((fnSrc(api, 'bellPanelView').match(/notif(?:Link|Href)\(n\)/g) || []).length, 2);
  assert.equal((fnSrc(api, 'bellToastPick').match(/notif(?:Link|Href)\(n\)/g) || []).length, 2);
  assert.doesNotMatch(fnSrc(api, 'bellPanelView') + fnSrc(api, 'bellToastPick'), /"event\.html\?id="|"chat\.html\?c="/);
  assert.match(api, /onOpen: \(\) => \{ if \(x\.rk && readKeys\.indexOf\(x\.rk\) === -1\) \{ readKeys\.push\(x\.rk\); saveRead\(\);/);
  assert.match(api, /closest\("a\.bpb-item"\);\s*if \(it\) \{ const k = it\.getAttribute\("data-k"\); if \(k && readKeys\.indexOf\(k\) === -1\) \{ readKeys\.push\(k\); saveRead\(\); \} close\(false\); \}/);
  assert.match(api, /conversation_id: m\.conversation_id, msg_id: m\.id,/);
  assert.match(api, /if \(m\.id\) item\.msg_id = m\.id;/);
});
t('destinations carry the anchors', () => {
  assert.match(rd('ops.html'), /<div class="trow" data-id="\$\{esc\(t\.id\)\}">/);
  assert.match(rd('chat.html'), /data-mid="\$\{esc\(m\.id\)\}"/);
  assert.match(rd('chat.html'), /get\("c"\)/);
  assert.match(rd('settlement.html'), /<div class="card" id="payments">/);
  assert.match(rd('control.html'), /location\.hash==="#users"/);
  assert.match(rd('quotes.html'), /get\("focus"\)/);
  assert.match(fnSrc(api, 'deeplinkFocus'), /__helmAdoptCss\(document,/);
  assert.doesNotMatch(fnSrc(api, 'deeplinkFocus'), /innerHTML|\.style\./);
});
t('0066 migration: additive task_id hint, never removes keys', () => {
  const m = readFileSync(new URL('../supabase/migrations/0066_notification_task_ref.sql', import.meta.url), 'utf8');
  const a = readFileSync(new URL('../supabase/APPLY-0066.sql', import.meta.url), 'utf8');
  assert.match(m, /coalesce\(new\.detail, '\{\}'::jsonb\) \|\| jsonb_build_object\('task_id', v_id\)/);
  assert.doesNotMatch(m, /\bdelete from|drop table|truncate|detail - /i);
  assert.ok(/^[\x00-\x7F]*$/.test(a), 'APPLY-0066 is pure ASCII');
  assert.match(a, /select item, ok from/);
});
console.log(`notif-deeplinks: ${n} passed`);
