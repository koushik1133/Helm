// R41: client reminders only at sensible hours (SQL 0290 send window). Static checks - the behaviour itself is proven by
// tests/db/r41-send-window-0290.sql (scripts/db-test/run-all.sh).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const r = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0, failed = 0;
function t(name, fn) { try { fn(); n++; console.log('  ok ' + name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n' + (e && e.stack || e)); } }

const MIG = r('supabase/migrations/0290_send_window.sql');
const APPLY = r('supabase/APPLY-0290.sql');
const fnBody = (name) => { const m = MIG.match(new RegExp('create or replace function public\\.' + name + '\\([\\s\\S]*?\\n\\$\\$;|create or replace function public\\.' + name + '\\([\\s\\S]*?end \\$\\$;')); assert.ok(m, name); return m[0]; };

t('migration: ASCII only, additive (no drop table / delete / truncate), needs 0287', () => {
  assert.ok(/^[\x00-\x7F]*$/.test(MIG), 'ASCII');
  assert.ok(!/\bdrop\s+table\b|\bdelete\s+from\b|\btruncate\b|\bdrop\s+column\b/i.test(MIG));
  assert.match(MIG, /STOP 0290: 0287 \(studio_timezone\) is not applied/);
  assert.match(MIG, /add column if not exists not_before timestamptz/);
});
t('migration: registered in MANIFEST in numeric order, right after 0287', () => {
  const lines = r('supabase/migrations/MANIFEST').split('\n').filter((l) => l.startsWith('forward')).map((l) => l.trim());
  const i = lines.indexOf('forward  supabase/migrations/0290_send_window.sql');
  assert.ok(i > 0, '0290 registered');
  assert.equal(lines[i - 1], 'forward  supabase/migrations/0287_studio_timezone_today.sql');
  if (i + 1 < lines.length) assert.ok(+lines[i + 1].match(/\/(\d{4})_/)[1] > 290, 'numeric order after 0290');
});
t('defaults: clients / guests 09:00-20:00, staff 08:00-21:00, per studio, at least one hour', () => {
  assert.match(MIG, /client_start time\s+not null default time '09:00'/);
  assert.match(MIG, /client_end\s+time\s+not null default time '20:00'/);
  assert.match(MIG, /staff_start\s+time\s+not null default time '08:00'/);
  assert.match(MIG, /staff_end\s+time\s+not null default time '21:00'/);
  assert.match(MIG, /org_id\s+uuid primary key references public\.organizations\(id\)/);
  assert.match(MIG, /client_end - client_start >= interval '1 hour'/);
});
t('the window is computed in the STUDIO time zone (0287), never the session / UTC day', () => {
  const b = fnBody('send_window_next');
  assert.match(b, /public\.studio_timezone\(p_org\)/);
  assert.ok(!/current_date|localtime|current_time/i.test(b));
});
t('one central place: the same trigger on every queue that carries date-based messages', () => {
  assert.match(MIG, /create trigger zz_sw290_send_window before insert on public\.%I/);
  for (const q of ['comms_outbox', 'helm_notice_outbox', 'trial_reminders', 'trial_retention_notices', 'vendor_request_sends', 'billing_reminders', 'referral_notice_queue'])
    assert.ok(MIG.includes("'" + q + "'"), q);
});
t('held = pending + lease (never skipped / failed / deleted by the hold)', () => {
  const b = fnBody('_sw290_tg');
  assert.match(b, /v_nb - interval '10 minutes'/);
  assert.ok(!/status\s*=\s*'(skipped|failed)'/.test(b));
  assert.match(b, /exception when others then\s*raise warning/);   // never blocks the queue row
});
t('never held: security, OTP, invites, clicked sends (no such kind in the classifier, manual flag respected)', () => {
  const b = fnBody('_sw290_audience');
  for (const k of ['team_safety', 'studio_security', 'hq_staff', 'studio_identity', 'otp', 'security_alert', 'invite', 'welcome', 'booklet_link', 'invite_site'])
    assert.ok(!b.includes("'" + k + "'"), k + ' must not be in a held list');
  assert.match(b, /payload' ->> 'manual'/);
  assert.match(b, /'instant_important'|mode', ''\) = 'daily'/);
  for (const q of ['security_alert_outbox', 'pkg_outbox', 'invite_email_outbox', 'welcome_email_outbox', 'assign_notify_outbox', 'runsheet_reminder_sends', 'delivery_reminder_sends'])
    assert.ok(!new RegExp("array\\['comms_outbox'[^\\]]*'" + q + "'").test(MIG), q + ' gets no trigger');
});
t('vendor reminders: stale rule counts from the end of the hold (in place, marker)', () => {
  assert.match(MIG, /coalesce\(not_before, created_at\) < now\(\) - interval ''12 hours'' \/\* r41-sendwin-0290 \*\//);
});
t('APPLY-0290: house style (begin / commit, VERIFY rows, STOP guard, the same body, no temp tables, ASCII)', () => {
  assert.ok(/^[\x00-\x7F]*$/.test(APPLY), 'ASCII');
  assert.ok(APPLY.includes('\nbegin;\n' + MIG + '\ncommit;\n'), 'the migration body between begin and commit');
  assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.equal((APPLY.match(/^  \('0\d /gm) || []).length, 9);
  assert.ok(!/create\s+temp/i.test(APPLY));
  assert.match(APPLY, /supabase functions deploy billing-reminder/);
});
t('billing-reminder edge function waits for not_before (and still works before the SQL is applied)', () => {
  const s = r('supabase/functions/billing-reminder/index.ts');
  assert.match(s, /not_before\.is\.null,not_before\.lte\./);
  assert.match(s, /=== "42703"/);
});
t('the senders of never-held mail do not look at the send window', () => {
  for (const f of ['send-otp', 'security-alert-mailer', 'invite-mailer', 'welcome-mailer', 'pkg-client-notify'])
    assert.ok(!r('supabase/functions/' + f + '/index.ts').includes('not_before'), f);
});
t('DB suite registered; the older suites run with the hold off', () => {
  const s = r('scripts/db-test/run-all.sh');
  assert.match(s, /run "r41-send-window-0290" "R41-SEND-WINDOW-0290: ALL PASS \\\(37\/37\\\)"/);
  assert.match(s, /-c helm\.send_window=off/);
  assert.match(r('tests/db/r41-send-window-0290.sql'), /set local helm\.send_window = 'on'/);
});

if (failed) { console.log(`R41 send window: ${failed} FAILED (${n} ok)`); process.exit(1); }
console.log(`R41 send window: ALL PASS (${n})`);
