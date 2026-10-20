// r25 automations opt-in (owner 2026-10-20, safety: "production e-mail is on - every automation that sends anything must
// be OFF unless the studio admin turns it on in Control Center -> Automations; the daily digest off now"):
//   * 0274: OFF defaults (readers + column defaults), gates on the ledgers the jobs write first, the switch-off step runs
//     once with a backup, queued rows of automations that are off marked skipped (never deleted), one RPC pair.
//   * Control Center: the Automations list is the ONE place with on / off switches; the feature cards only link to it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = (p) => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('  ok', name); };

const SQL = read('supabase/migrations/0274_automations_optin.sql'), APPLY = read('supabase/APPLY-0274.sql');
const CC = read('public/control.html'), AU = read('public/automations.js');

t('0274 is additive: no DROP TABLE / COLUMN, no TRUNCATE, no DELETE; ASCII only; in the MANIFEST after 0273', () => {
  assert.ok(!/\bdrop\s+(table|column)\b/i.test(SQL) && !/\btruncate\b/i.test(SQL) && !/\bdelete\s+from\b/i.test(SQL), 'no destructive statement');
  assert.ok(/^[\x00-\x7f]*$/.test(SQL), 'ASCII only');
  const man = read('supabase/migrations/MANIFEST');
  assert.ok(man.indexOf('forward  supabase/migrations/0274_automations_optin.sql') > man.indexOf('forward  supabase/migrations/0273_billing_currency.sql'));
});

t('APPLY-0274.sql = header + begin + the migration verbatim + commit + VERIFY rows; pasteable', () => {
  assert.ok(APPLY.includes('begin;\n' + SQL + 'commit;\n'), 'migration verbatim inside one transaction');
  assert.match(APPLY, /-- VERIFY \(every row must say ok = true\)/);
  assert.equal((APPLY.match(/^  \('0\d /gm) || []).length, 9, '9 VERIFY rows');
  assert.ok(/^[\x00-\x7f]*$/.test(APPLY), 'ASCII only');
  assert.ok(!/^\\/m.test(APPLY) && !/temp(orary)? table/i.test(APPLY), 'no psql meta-command, no temp table');
  assert.match(APPLY, /run this BEFORE scheduling the Helm jobs/);
});

t('OFF defaults: column defaults + every settings reader say off; the daily digest default is "No e-mails"', () => {
  for (const c of ['comms_settings alter column pay_enabled set default false', 'comms_settings alter column low_stock_enabled set default false',
    'client_view_settings alter column followup_enabled set default false', 'payment_schedule_settings alter column overdue_bell set default false',
    'automation_settings alter column runsheet_enabled set default false', 'inbox_settings alter column email_enabled set default false',
    "inbox_settings alter column digest_default set default 'off'"]) assert.ok(SQL.includes(c), c);
  for (const c of ["'pay_enabled', coalesce(s.pay_enabled, false)", "'low_stock_enabled', coalesce(s.low_stock_enabled, false)",
    "'followup_enabled', coalesce(s.followup_enabled, false)", "(v ->> 'client_reminders')::boolean end, false)",
    "(v ->> 'studio_reminders')::boolean end, false)", "jsonb_build_object('runsheet_enabled', false", "'email_enabled', coalesce(s.email_enabled, false)",
    "'digest_default', coalesce(s.digest_default, 'off')", "'notifyShifts', false"]) assert.ok(SQL.includes(c), c);
  for (const c of ['event_reminders_enabled boolean not null default false', 'vendor_reminders_enabled boolean not null default false',
    'assign_whatsapp_enabled boolean not null default false']) assert.ok(SQL.includes(c), c);
});

t('gates + wrapper: the ledger row is not written while off; a hand-sent vendor request always passes', () => {
  assert.match(SQL, /\('event_reminders', 'event_reminders'\), \('runsheet_reminder_sends', 'runsheet'\),\s+\('payment_overdue_alerts', 'overdue_bell'\), \('vendor_request_sends', 'vendor_reminders'\)/);
  assert.match(SQL, /if coalesce\(to_jsonb\(new\) ->> 'kind', ''\) <> 'reminder' then return new; end if;   -- a request sent by hand/);
  assert.match(SQL, /rename to _assign132_enqueue__pre0274/);
  assert.match(SQL, /if not public\._auto274_on\(p_org, 'assign_whatsapp'\) then return false; end if;/);
});

t('switch-off step runs ONCE (marker), backs up every value it changes, keeps choices whose default was off', () => {
  assert.match(SQL, /b\.setting = 'data_step_done'\) then\s+raise notice '0274: data step already done/);
  assert.match(SQL, /values \(null, '0274', 'data_step_done'/);
  assert.match(SQL, /create table if not exists public\.automation_optin_backup_0274/);
  assert.ok(!/fu_enabled = false|wa_forward_enabled = false|enquiry_enabled = false|set enabled = false/.test(SQL.split('-- ---- 4)')[0]), 'default-off choices kept');
  assert.match(SQL, /studio_id   uuid,/, "Helm's own record: no org_id column (never purged with a trial)");
});

t('queued rows: only status -> skipped, only for automations that are off, never hand-sent ones', () => {
  const tail = SQL.split('-- ---- 9)')[1];
  assert.ok(tail && !/delete/i.test(tail.replace(/nothing deleted/gi, '')), 'no delete');
  assert.match(tail, /not coalesce\(\(c\.payload ->> 'manual'\)::boolean, false\) and not public\._auto274_on\(c\.org_id, 'pay_reminders'\)/);
  assert.match(tail, /coalesce\(c\.payload ->> 'r23', ''\) <> 'nudge'/);
  assert.match(tail, /h\.kind = 'inbox_digest' and h\.status = 'pending'/);
  assert.match(tail, /v\.kind = 'reminder' and v\.status = 'pending'/);
});

t('one RPC pair: automation_overview (Control Center view) + automation_switch (edit, read-only refused, audit)', () => {
  assert.match(SQL, /create or replace function public\.automation_switch\(p_key text, p_on boolean\)/);
  assert.match(SQL, /not public\.has_area\('controls', 'edit'\) then\s+raise exception 'Only a studio admin/);
  assert.match(SQL, /if coalesce\(public\._trial_locked\(v_org\), false\) then raise exception 'This studio is read-only' using errcode = '25006'/);
  assert.match(SQL, /'automation\.switch', 'automation', p_key, jsonb_build_object\('key', p_key, 'from', v_old, 'to', p_on\)/);
  assert.match(SQL, /'Add your studio WhatsApp number first/);
});

t('Control Center: no second on / off switch on the feature cards - each links to Automations', () => {
  for (const id of ['cm_pay_on', 'cm_fu_on', 'cm_low_on', 'cm_wa_on', 'qv_cli', 'qv_stu', 'pst_auto', 'pst_bell']) assert.ok(!CC.includes('id="' + id + '"'), id + ' removed');
  assert.ok((CC.match(/class="mnote au-onoff"/g) || []).length >= 6, 'on / off notes link to Automations');
  for (const f of ['link-views.js', 'inbox-settings.js', 'crew-shifts.js', 'delivery-settings.js']) assert.match(read('public/' + f), /href: "#automations"/, f);
  assert.ok(!/pay_enabled: \$\("cm_pay_on"\)|low_stock_enabled:|wa_forward_enabled:/.test(read('public/comms-settings.js')), 'comms card never sends a switch');
  assert.ok(!/enabled: on\.input\.checked/.test(read('public/delivery-settings.js')), 'delivery card never sends the switch');
  assert.ok(!/client_reminders:|studio_reminders:/.test(read('public/quote-validity.js')), 'quote validity card never sends the reminder switches');
});

t('Automations page: grouped by who it sends to, "Sends to" tags, asks before switching ON, never on silently', () => {
  const win = {};
  vm.runInNewContext(AU, { window: win, document: {}, location: { origin: 'https://helm.events' } });
  const reg = win.HelmAutomations.registry();
  assert.ok(reg.length >= 17);
  for (const it of reg.filter((x) => x.sends[0] !== 'nothing')) assert.match(it.ask, /^This will (e-mail|message|tell|warn|remind|send|open|WhatsApp)/, it.key);
  assert.match(AU, /"Sends to:"/);
  assert.match(AU, /Each one is off until you switch it on here/);
  assert.match(AU, /title: "Switch on " \+ it\.name \+ "\?", okLabel: "Switch on"/);
});

console.log('r25-automations: ' + n + ' passed');
