// 0120 — 8-day free-trial reminders on day 5 / 7 / 8 (3 days left / ends tomorrow / ends today).
//  * milestone math relative to trial_ends_at, in the studio's time zone (JS mirror of the SQL)
//  * idempotency: one ledger row per studio per milestone per trial end (UNIQUE dedupe_key)
//  * copy strings (in-app card, bell label, e-mail) say 8 days / no card / view-only / nothing deleted
//  * SQL is additive (no drop / delete / truncate), e-mail stays dormant (service-role claim only)
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const MIG = read('supabase/migrations/0120_trial_reminders.sql');
const APPLY = read('supabase/APPLY-0120.sql'), VERIFY = read('supabase/VERIFY-0120.sql');
const TJS = read('public/trial.js'), API = read('public/store-api.js');
const FN = read('supabase/functions/comms-dispatch/index.ts');
const trial = require('../public/trial.js');
const email = await import('../supabase/functions/comms-dispatch/trial-reminders.mjs');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok -', name); };
const code = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const fnBody = (sql, name) => { const at = sql.indexOf(`function public.${name}(`); assert.ok(at >= 0, name); return sql.slice(at, sql.indexOf('$$;', sql.indexOf('$$', at) + 2)); };
const H = 3600e3, D = 24 * H;

// an 8-day trial that started 10:00 IST on 1 Oct ends 10:00 IST on 9 Oct (04:30 UTC)
const END = '2026-10-09T04:30:00Z';
const ist = (s) => Date.parse(s + '+05:30');

t('milestone d5 = 3 calendar days before the end (studio zone)', () => {
  assert.equal(trial.reminderMilestone(END, ist('2026-10-06T00:00:00'), 'Asia/Kolkata'), 'd5');
  assert.equal(trial.reminderMilestone(END, ist('2026-10-06T23:59:00'), 'Asia/Kolkata'), 'd5');
  assert.equal(trial.reminderMilestone(END, ist('2026-10-05T23:59:00'), 'Asia/Kolkata'), null);
});
t('milestone d7 = the day before the end, d8 = the last day', () => {
  assert.equal(trial.reminderMilestone(END, ist('2026-10-07T12:00:00'), 'Asia/Kolkata'), null);
  assert.equal(trial.reminderMilestone(END, ist('2026-10-08T08:00:00'), 'Asia/Kolkata'), 'd7');
  assert.equal(trial.reminderMilestone(END, ist('2026-10-09T00:01:00'), 'Asia/Kolkata'), 'd8');
  assert.equal(trial.reminderMilestone(END, ist('2026-10-09T09:59:00'), 'Asia/Kolkata'), 'd8');
});
t('no milestone once the trial has ended / bad input', () => {
  assert.equal(trial.reminderMilestone(END, ist('2026-10-09T10:00:00'), 'Asia/Kolkata'), null);
  assert.equal(trial.reminderMilestone(END, ist('2026-10-10T10:00:00'), 'Asia/Kolkata'), null);
  assert.equal(trial.reminderMilestone('nope', Date.now(), 'Asia/Kolkata'), null);
  assert.equal(trial.reminderMilestone(null, Date.now(), 'Asia/Kolkata'), null);
});
t('the studio zone decides the day (same instant, different studios)', () => {
  const end = '2026-10-09T04:00:00Z', now = Date.parse('2026-10-08T17:00:00Z');
  assert.equal(trial.reminderMilestone(end, now, 'America/Chicago'), 'd8');   // 8 Oct 12:00 vs end 8 Oct 23:00 Chicago
  assert.equal(trial.reminderMilestone(end, now, 'Asia/Kolkata'), 'd7');      // 8 Oct 22:30 IST vs end 9 Oct 09:30 IST
});
t('a trial ending exactly at local midnight: its last day is the day before', () => {
  const end = '2026-10-08T18:30:00Z';   // 9 Oct 00:00 IST
  assert.equal(trial.reminderMilestone(end, ist('2026-10-08T12:00:00'), 'Asia/Kolkata'), 'd8');
  assert.equal(trial.reminderMilestone(end, ist('2026-10-07T12:00:00'), 'Asia/Kolkata'), 'd7');
});
t('unknown zone falls back instead of throwing', () => {
  assert.equal(trial.reminderMilestone(END, ist('2026-10-08T08:00:00'), 'Not/AZone'), 'd7');
});
t('8 days exactly: day 5 / 7 / 8 of a trial started at 00:00 local', () => {
  const start = ist('2026-10-01T00:00:00'), end = new Date(start + 8 * D).toISOString();
  const dayOf = (k) => trial.reminderMilestone(end, start + (k - 1) * D + 12 * H, 'Asia/Kolkata');
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map(dayOf), [null, null, null, null, 'd5', null, 'd7', 'd8']);
});

t('reminder card: admins of an active trial only; once-a-day key', () => {
  const base = { is_trial_org: true, is_admin: true, ends_at: END, timezone: 'Asia/Kolkata', ended: false, locked: false };
  const s = trial.reminderSpec(base, ist('2026-10-09T08:00:00'));
  assert.equal(s.milestone, 'd8');
  assert.equal(s.title, 'Your trial ends today');
  assert.equal(s.key, 'helm_trial_reminder:d8:2026-10-09');
  assert.equal(trial.reminderSpec({ ...base, is_admin: false }, ist('2026-10-09T08:00:00')), null);
  assert.equal(trial.reminderSpec({ ...base, locked: true }, ist('2026-10-09T08:00:00')), null);
  assert.equal(trial.reminderSpec({ is_trial_org: false, is_admin: true }, Date.now()), null);
  assert.equal(trial.reminderSpec(base, ist('2026-10-07T08:00:00')), null);
});
t('reminder card copy: 8 days, no card, view-only, nothing deleted, CTAs', () => {
  const s = trial.reminderSpec({ is_trial_org: true, is_admin: true, ends_at: END, timezone: 'Asia/Kolkata' }, ist('2026-10-06T08:00:00'));
  assert.equal(s.title, '3 days left in your free trial');
  assert.match(s.body, /8-day free trial \(no card required\)/);
  assert.match(s.after, /view-only/); assert.match(s.after, /Your data is kept for 60 days after the trial ends, and we remind you before anything is deleted\./);   // r21: the one retention promise
  assert.equal(s.cta, 'Choose a plan'); assert.equal(s.later, 'Remind me later');
  assert.deepEqual(trial.REMINDER_TITLES, { d5: '3 days left in your free trial', d7: 'Your free trial ends tomorrow', d8: 'Your trial ends today' });
  assert.ok(!/14[- ]day/.test(TJS), 'no 14-day wording');
});
t('trial.js: CSP-safe DOM, localStorage guarded, checkout link, version bumped', () => {
  assert.ok(!/innerHTML|insertAdjacentHTML|\.style\.|setAttribute\("style"/.test(TJS));
  assert.match(TJS, /function seen\(key\) \{ try \{/); assert.match(TJS, /function markSeen\(key\) \{ try \{/);
  assert.match(TJS, /checkout\.html\?next=/);
  assert.match(TJS, /renderReminder\(reminderSpec\(t, Date\.now\(\)\)\)/);
  assert.match(API, /const TRIAL_BANNER_VERSION = "11";/);
});

t('SQL milestone mirror + labels match the card', () => {
  const m = fnBody(MIG, '_trial_reminder_milestone');
  assert.match(m, /p_ends <= p_now then return null/);
  assert.match(m, /interval '1 microsecond'\) at time zone v_tz\)::date - \(p_now at time zone v_tz\)::date/);
  assert.match(m, /when 3 then 'd5' when 1 then 'd7' when 0 then 'd8'/);
  const l = fnBody(MIG, '_trial_reminder_label');
  for (const v of Object.values(trial.REMINDER_TITLES)) assert.ok(l.includes(`'${v}'`), v);
});
t('idempotency: unique dedupe key per studio + milestone + trial end; insert on conflict do nothing', () => {
  assert.match(MIG, /create unique index if not exists trial_reminders_dedupe_key120 on public\.trial_reminders\(dedupe_key\)/);
  assert.match(fnBody(MIG, '_trial_reminder_key'), /'trial120:' \|\| p_org::text \|\| ':' \|\| p_milestone \|\| ':' \|\| to_char\(p_ends at time zone 'UTC'/);
  const tick = fnBody(MIG, 'trial_reminders_tick');
  assert.match(tick, /on conflict \(dedupe_key\) do nothing\s+returning id into v_id/);
  assert.match(tick, /if v_id is not null then[\s\S]*insert into public\.notifications/);   // bell only for a NEW row
  assert.match(tick, /'in_app', 'trial_reminder'/);
  assert.match(tick, /security definer/);
  assert.match(tick, /coalesce\(s\.status, 'trial'\) = 'trial'/);
  assert.match(tick, /_trial_paid\(o\.id\)/);
});
t('privileges: tick / claim / mark are service-role only; cron guarded + hourly', () => {
  assert.match(MIG, /grant execute on function public\.trial_reminders_tick\(\) to service_role/);
  assert.ok(!/grant execute on function public\.trial_reminders_tick\(\) to authenticated/.test(MIG));
  assert.ok(!/grant execute on function public\.trial_reminder_email_claim\(integer\) to authenticated/.test(MIG));
  assert.match(MIG, /if exists \(select 1 from pg_extension where extname = 'pg_cron'\)/);
  assert.match(MIG, /cron\.schedule\('helm_trial_reminders', '7 \* \* \* \*', 'select public\.trial_reminders_tick\(\)'\)/);
  assert.match(MIG, /revoke all on table public\.trial_reminders from authenticated/);
});
t('SQL is additive: no drop / delete / truncate / destructive alter; idempotent DDL', () => {
  const c = code(MIG).toLowerCase();
  assert.ok(!/\bdrop\b/.test(c), 'no DROP');
  assert.ok(!/\bdelete\s+from\b/.test(c), 'no DELETE');
  assert.ok(!/\btruncate\b/.test(c), 'no TRUNCATE');
  assert.ok(!/alter\s+table[^;]*\b(drop|rename|alter\s+column|type)\b/.test(c), 'no destructive ALTER');
  assert.ok(!/alter\s+function[^;]*rename/.test(c), 'no renames');
  assert.ok(!/\bupdate\s+public\.(organizations|studio_subscriptions|notifications)\b/.test(fnBody(MIG, 'trial_reminders_tick').toLowerCase()));
  assert.match(c, /create table if not exists public\.trial_reminders/);
  assert.ok(!/create table (?!if not exists)/.test(c));
});
t('0058 job keeps its body but skips 8-day studios; my_trial_org adds timezone', () => {
  const r = fnBody(MIG, '_trial_refresh');
  assert.match(r, /not exists \(select 1 from public\.organizations o where o\.id = s\.org_id and o\.trial_ends_at is not null\)/);
  assert.match(r, /set status = 'past_due'/);
  const o = fnBody(MIG, 'my_trial_org');
  assert.match(o, /'timezone', coalesce\(nullif\(btrim\(o\.timezone\), ''\), 'Asia\/Kolkata'\)/);
  assert.match(o, /'trial_mode', o\.trial_mode/);
  assert.match(MIG, /grant execute on function public\.my_trial_org\(\) to authenticated/);
});
t('e-mail is dormant: claim re-checks, skips stale rows, dispatcher gated by HELM_COMMS_ENABLED', () => {
  const cl = fnBody(MIG, 'trial_reminder_email_claim');
  assert.match(cl, /created_at < now\(\) - interval '2 days'/);
  assert.match(cl, /r\.cur_end = r\.trial_ends_at and r\.cur_end > now\(\)/);
  assert.match(cl, /for update of tr skip locked/);
  assert.match(FN, /if \(!commsOn\(Deno\.env\.get\("HELM_COMMS_ENABLED"\)\)\) return json\(\{ status: "dormant" \}\)/);
  assert.ok(FN.indexOf('admin.rpc("trial_reminder_email_claim"') > FN.indexOf('Deno.env.get("HELM_COMMS_ENABLED")'));
  assert.match(FN, /trial_reminder_email_mark/);
});
t('e-mail copy for each reminder', () => {
  const a = email.trialReminderEmail('d5', 'Demo 7', END, 'Asia/Kolkata', 'https://www.helm.events/');
  const b = email.trialReminderEmail('d7', 'Demo 7', END, 'Asia/Kolkata', 'https://www.helm.events');
  const c = email.trialReminderEmail('d8', 'Demo 7', END, 'Asia/Kolkata', 'https://www.helm.events');
  assert.equal(a.subject, '3 days left in your Helm free trial');
  assert.equal(b.subject, 'Your Helm free trial ends tomorrow');
  assert.equal(c.subject, 'Your Helm free trial ends today');
  for (const m of [a, b, c]) {
    assert.match(m.text, /^Hi Demo 7,/);
    assert.match(m.text, /8-day/); assert.match(m.text, /no card/); assert.match(m.text, /view-only/); assert.match(m.text, /Your data is kept for 60 days after the trial ends, and we remind you before anything is deleted\./);   // r21: the one retention promise
    assert.match(m.text, /Choose a plan: https:\/\/www\.helm\.events\/checkout/);
    assert.ok(!/14[- ]day/.test(m.text));
  }
  assert.match(c.text, /Your trial ends today/);
  assert.match(a.text, /9 October/);
  assert.equal(email.trialReminderEmail('d6', 'x', END, 'Asia/Kolkata', ''), null);
});
t('APPLY = migration + VERIFY; MANIFEST line', () => {
  assert.ok(APPLY.startsWith(MIG.trimEnd().slice(0, 200)));
  assert.ok(APPLY.includes(VERIFY.trim()));
  assert.ok(!/\bcron\.job\b/.test(code(VERIFY)), 'VERIFY runs without pg_cron');
  assert.match(read('supabase/migrations/MANIFEST'), /forward\s+supabase\/migrations\/0120_trial_reminders\.sql/);
});
console.log(`\n${n} passed`);
t('0123: demo-mode admins get "Start my own studio"; Choose a plan offers start-fresh first', () => {
  assert.equal(trial.bannerSpec({ is_trial_org: true, days_left: 5, is_admin: true, trial_mode: 'demo' }).fresh, 'Start my own studio');
  assert.equal(trial.bannerSpec({ is_trial_org: true, days_left: 5, is_admin: false, trial_mode: 'demo' }).fresh, null);
  assert.equal(trial.bannerSpec({ is_trial_org: true, days_left: 5, is_admin: true, trial_mode: 'own' }).fresh, null);
  assert.equal(trial.planHref({ is_admin: true, trial_mode: 'demo' }, 'leads'), 'dashboard.html?demo=fresh&then=checkout');
  assert.equal(trial.planHref({ is_admin: true, trial_mode: 'demo', ended: true }, 'leads'), 'checkout.html?next=leads.html');
  assert.equal(trial.planHref({ is_admin: true, trial_mode: 'own' }, 'leads'), 'checkout.html?next=leads.html');
});
