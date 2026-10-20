// r23 payment schedules (migration 0264): templates applied on approval, reminders on by default, pause per event,
// overdue bell, payments cover milestones, client page. Behaviour of the SQL: tests/db/r23-payment-schedules-0264.sql.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

const SQL = read('supabase/migrations/0264_payment_schedules.sql');
const APPLY = read('supabase/APPLY-0264.sql');
const MAN = read('supabase/migrations/MANIFEST');
const API = read('public/store-api.js'), JS = read('public/payment-schedule.js'), SET = read('public/payment-schedule-settings.js');
const CC = read('public/control.html'), LOG = read('public/logistics.html'), FLOW = read('public/flow.html');
const EV = read('public/event.html'), BUD = read('public/budget.html'), PORTAL = read('public/portal.html');
require('../public/payment-schedule.js');
const P = globalThis.HelmPaySchedule;

await t('compute: 30/50/20 of 2,36,000 adds up, whole rupees, due dates from approval / event', () => {
  const l = P.BUILTINS[0].lines;
  const r = P.compute(l, 236000, '2026-10-20', '2026-12-19');
  assert.deepEqual(r.map((x) => x.amount), [70800, 118000, 47200]);
  assert.deepEqual(r.map((x) => x.due_date), ['2026-10-20', '2026-12-04', '2026-12-19']);
  const p = P.compute(l, 99999.5, '2026-10-20', '2026-12-19');
  assert.equal(p.reduce((a, x) => a + x.amount, 0), 99999.5, 'remainder goes to the last payment');
  assert.equal(P.compute(l, 100000, '2026-10-20', '2026-10-25')[1].due_date, '2026-10-20', 'never before approval');
  assert.equal(P.compute(l, 100000, '2026-10-20', null)[1].due_date, null);
  const c = P.cleanLines([{ label: 'Booking', kind: 'fixed', value: 150000 }, { label: 'Rest', kind: 'balance' }]);
  assert.ok(c.ok); assert.deepEqual(P.compute(c.lines, 100000, '2026-10-20', null).map((x) => x.amount), [100000]);
});

await t('cleanLines: same rules as the SQL', () => {
  assert.match(P.cleanLines([{ label: 'A', value: 30 }, { label: 'B', value: 30 }]).error, /add up to 100%/);
  assert.match(P.cleanLines([{ label: 'A', kind: 'balance' }, { label: 'B', kind: 'balance' }]).error, /at most one/);
  assert.match(P.cleanLines([{ label: 'A', value: 100, anchor: 'approval', offset_days: -1 }]).error, /before the approval/);
  assert.match(P.cleanLines([{ label: '<b>', value: 100 }]).error, /name/);
  assert.ok(P.cleanLines([{ label: 'A', value: 40 }, { label: 'B', kind: 'balance', anchor: 'event', offset_days: -10 }]).ok);
  assert.match(SQL, /add up to 100%%/); assert.match(SQL, /at most one "Balance"/);
});

await t('labels: overdue / due soon / reminder cadence line', () => {
  assert.equal(P.stateLabel('overdue', -3), 'Overdue 3 days');
  assert.equal(P.stateLabel('due', 0), 'Due today');
  assert.equal(P.stateLabel('due', 2), 'Due in 2 days');
  assert.equal(P.stateLabel('part_paid', 5), 'Part paid');
  assert.equal(P.reminderLine({ enabled: true, before_days: 3, on_due: true, every_days: 3, max_overdue: 1 }, false),
    'Automatic client reminders: 3 days before, on the due day, 3 days after.');
  assert.match(P.reminderLine({ enabled: true }, true), /paused for this event/);
  assert.match(P.reminderLine({ enabled: false }), /off/);
});

await t('SQL: additive, never overwrites a schedule, reminders on by default, wrappers renamed once', () => {
  assert.ok(!/\bdrop table\b|\bdelete from\b|\btruncate\b/i.test(SQL), 'nothing dropped or deleted');
  assert.match(SQL, /if exists \(select 1 from public\.payment_milestones m where m\.quote_id = new\.id\) then return null/);
  assert.match(SQL, /'pay_enabled', coalesce\(s\.pay_enabled, true\)/);
  assert.match(SQL, /alter column pay_enabled set default true/);
  for (const f of ['record_payment', 'record_settlement_payment', 'comms_tick', 'comms_outbox_claim', '_comms_queue_pay', 'notification_catalog', 'notification_type_of'])
    assert.ok(SQL.includes(f + '__pre0264'), f + ' wrapped');
  assert.match(SQL, /exception when others then raise warning 'pay-schedule-0264: automatic schedule skipped/, 'approval never blocked');
  assert.ok(MAN.includes('forward  supabase/migrations/0264_payment_schedules.sql'));
  assert.ok(APPLY.includes(SQL.trim().slice(0, 2000)) && /^begin;/m.test(APPLY) && /^commit;/m.test(APPLY) && /ok = true/.test(APPLY));
  assert.ok(!/[^\x00-\x7F]/.test(SQL) && !/[^\x00-\x7F]/.test(APPLY), 'ASCII only');
});

await t('UI: store-api, Control Center card + section, pages mount the card, client page, bell label', () => {
  for (const r of ['payment_schedule_settings_get', 'payment_schedule_settings_set', 'payment_schedule_template_save', 'payment_schedule_template_archive',
    'payment_schedule_for_quote', 'payment_schedule_apply', 'payment_schedule_pause', 'public_payment_schedule']) {
    assert.ok(API.includes('rpc("' + r + '"'), r); assert.ok(SQL.includes('function public.' + r + '('), r + ' in SQL');
  }
  assert.match(API, /comms, paySchedule, deliveries/);
  assert.match(API, /payment_overdue: \[/);
  assert.match(CC, /id="pstCard"/); assert.match(CC, /payment-schedule-settings\.js/);
  assert.match(read('public/control-split.js'), /id==="pstCard"\) return "payments"/);
  assert.match(read('public/search-catalog.js'), /#payment-schedules/);
  for (const [name, h] of [['flow', FLOW], ['event', EV], ['budget', BUD], ['logistics', LOG]]) {
    assert.match(h, /payment-schedule\.js\?v=\d+/, name); assert.match(h, /payment-schedule\.css\?v=\d+/, name);
    assert.match(h, /HelmPaySchedule\.mount/, name);
  }
  assert.match(LOG, /st overdue/); assert.match(LOG, /#payments\$/);
  assert.match(PORTAL, /Payment schedule/); assert.match(PORTAL, /paySchedule\.publicGet/); assert.match(PORTAL, /How to pay/);
  assert.match(read('public/booklet.js'), /overdueOf\(/);
});

await t('widget + settings: DOM API only, amounts tagged for "Hide amounts"', () => {
  for (const src of [JS, SET]) assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\.style\./.test(src));
  assert.match(JS, /data-money/);
  assert.match(SET, /archiveTemplate/); assert.match(SET, /Archive the schedule/);
});

console.log(`r23 payment schedules: ${n} passed`);
