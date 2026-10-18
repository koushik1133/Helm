// 0184: free-trial data retention (owner post-trial policy items 2, 3, 9).
//  * e-mail copy: the owner's deletion sentence word for word with DD/MM/YYYY, +7 reminder, 30 / 7 / 1 day warnings
//  * the 0120 day 5 / 7 / 8 copy is unchanged unless the owner has switched deletion on
//  * comms-dispatch claims + marks the new rows after the kill switch; warnings are transactional, +7 is a nudge
//  * SQL: ASCII, deletion switch defaults OFF, DELETE only inside the switched purge, trial check by subscription
//    status, sample master excluded, platform-only grants, guarded cron, APPLY = migration + VERIFY, MANIFEST
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const MIG = read('supabase/migrations/0184_trial_retention.sql'), APPLY = read('supabase/APPLY-0184.sql');
const FN = read('supabase/functions/comms-dispatch/index.ts'), MJS = read('supabase/functions/comms-dispatch/trial-reminders.mjs');
const m = await import('../supabase/functions/comms-dispatch/trial-reminders.mjs');
let fail = 0, n = 0;
const t = (name, f) => { try { f(); n++; console.log('  ok ' + name); } catch (e) { fail++; console.log('  FAIL ' + name); console.log(e.message); } };
const code = (sql) => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');
const fnBody = (sql, name) => {
  const at = sql.indexOf(`function public.${name}(`); assert.ok(at >= 0, name);
  return sql.slice(at, sql.indexOf('$$;', sql.indexOf('$$', at) + 2));
};
const SENTENCE = 'Your trial data is scheduled for permanent deletion on 09/12/2026. Upgrade now to retain access and continue using your studio.';

t('deletion warnings: owner sentence verbatim, DD/MM/YYYY, checkout link, read-only until then', () => {
  for (const k of ['del30', 'del7', 'del1']) {
    const e = m.trialRetentionEmail(k, 'Demo 7', { deleteOn: '2026-12-09' }, 'https://www.helm.events/');
    assert.ok(e.text.includes(SENTENCE), k);
    assert.match(e.text, /^Hi Demo 7,/);
    assert.match(e.text, /Upgrade now: https:\/\/www\.helm\.events\/checkout/);
    assert.match(e.text, /read-only mode/);
    assert.match(e.subject, /09\/12\/2026/);
  }
  assert.match(m.trialRetentionEmail('del1', 'x', { deleteOn: '2026-12-09' }, '').subject, /^Final notice: .*tomorrow/);
  assert.match(m.trialRetentionEmail('del7', 'x', { deleteOn: '2026-12-09' }, '').subject, /^Reminder: /);
});
t('a warning without a usable date is never sent; unknown kinds -> null', () => {
  assert.equal(m.trialRetentionEmail('del30', 'x', { deleteOn: '' }, ''), null);
  assert.equal(m.trialRetentionEmail('del7', 'x', { deleteOn: '2026-02-30' }, ''), null);
  assert.equal(m.trialRetentionEmail('d5', 'x', { deleteOn: '2026-12-09' }, ''), null);
  assert.equal(m.ddmmyyyy('2026-01-05'), '05/01/2026');
  assert.equal(m.ddmmyyyy('2026-12-09T00:00:00Z'), '09/12/2026');
  assert.equal(m.ddmmyyyy('09/12/2026'), '');
});
t('+7 reminder: read-only + preserved; names the deletion date only when one is set', () => {
  const a = m.trialRetentionEmail('x7', 'Demo 7', { deleteOn: '2026-12-09', expiredAt: '2026-10-09T04:30:00Z', timeZone: 'Asia/Kolkata', retentionDays: 60 }, '');
  assert.match(a.subject, /free trial has ended/);
  assert.match(a.text, /ended a week ago \(9 October 2026\)/);
  assert.match(a.text, /Your data is preserved and available in read-only mode/);
  assert.match(a.text, /kept for 60 days after the trial ends/);
  assert.ok(a.text.includes(SENTENCE));
  assert.match(a.text, /Upgrade now to continue creating and editing records: https:\/\/www\.helm\.events\/checkout/);
  const b = m.trialRetentionEmail('x7', 'Demo 7', { deleteOn: '', expiredAt: '2026-10-09T04:30:00Z' }, '');
  assert.ok(!/deletion/.test(b.text), 'no deletion talk while deletion is off');
});
t('day 5 / 7 / 8 copy: unchanged by default, says "kept for 60 days" only when deletion is on', () => {
  const END = '2026-10-09T04:30:00Z';
  for (const k of ['d5', 'd7', 'd8']) {
    assert.match(m.trialReminderEmail(k, 'Demo 7', END, 'Asia/Kolkata', '').text, /Nothing is deleted/);
    assert.match(m.trialReminderEmail(k, 'Demo 7', END, 'Asia/Kolkata', '', { delete_enabled: false, retention_days: 60 }).text, /Nothing is deleted/);
    const on = m.trialReminderEmail(k, 'Demo 7', END, 'Asia/Kolkata', '', { delete_enabled: true, retention_days: 60 }).text;
    assert.ok(!/Nothing is deleted/.test(on)); assert.match(on, /kept for 60 days after the trial ends/); assert.match(on, /permanently deleted/);
  }
  assert.equal(m.retentionDays({ delete_enabled: true, retention_days: 5 }), 0);
  assert.deepEqual(m.TRIAL_MILESTONES, ['d5', 'd7', 'd8']);
});
t('mjs: pure, ASCII', () => {
  assert.ok(/^[\x00-\x7F]*$/.test(MJS));
  assert.ok(!/\bfetch\(|Deno\.|process\./.test(MJS));
});

t('comms-dispatch: claims + marks retention rows after the kill switch; warnings transactional, +7 unsubscribable', () => {
  const at = FN.indexOf('admin.rpc("trial_retention_email_claim"');
  assert.ok(at > FN.indexOf('Deno.env.get("HELM_COMMS_ENABLED")'));
  assert.match(FN, /admin\.rpc\("trial_retention_email_mark", \{ p_id: id, p_status: res === "failed" \? "retry" : res \}\)/);
  assert.match(FN, /RETENTION_NOTICE_KINDS\.includes\(kind\)\) extra = \{ footer: txFooter\(RETENTION_TX_REASON/);
  assert.match(FN.slice(at), /extra = marketingExtra\(u, "Helm", "you started a free trial of Helm", origin\)/);
  assert.match(FN.slice(at), /const res: Res = msg && extra \? await sendEmail\(id, to, msg\.subject, msg\.text, "Helm", \{\}, extra\) : "skipped"/);
  assert.match(FN, /admin\.rpc\("trial_retention_mail_settings"\)/);
  assert.match(FN, /String\(r\?\.timezone \?\? ""\), origin, retention\)/);
  assert.ok(!/console\.(log|error)\([^)]*\bto\b[,)]/.test(FN), 'no address in logs');
});

t('SQL: ASCII, in MANIFEST, APPLY = migration verbatim inside begin/commit + VERIFY', () => {
  assert.ok(/^[\x00-\x7F]*$/.test(MIG) && /^[\x00-\x7F]*$/.test(APPLY));
  assert.ok(APPLY.includes('begin;\n' + MIG + 'commit;'));
  assert.match(APPLY, /-- VERIFY/);
  assert.ok(!/create temp|pg_temp/i.test(APPLY), 'paste-safe: no temp objects');
  assert.match(read('supabase/migrations/MANIFEST'), /forward  supabase\/migrations\/0184_trial_retention\.sql/);
  assert.match(read('scripts/db-test/run-all.sh'), /tests\/db\/trial-retention-0184\.sql/);
});
t('SQL: the deletion switch exists and defaults OFF; the purge refuses while it is off', () => {
  assert.match(MIG, /delete_enabled\s+boolean not null default false/);
  assert.match(MIG, /retention_days\s+integer not null default 60/);
  const p = fnBody(MIG, '_trial_retention_purge_org');
  assert.ok(p.indexOf('if not cfg.delete_enabled then') < p.indexOf('delete from'), 'switch checked before any delete');
  const d = fnBody(MIG, 'trial_retention_purge_due');
  assert.match(d, /if not cfg\.delete_enabled then return jsonb_build_object\('delete_enabled', false, 'deleted', 0\); end if;/);
  assert.match(p, /_tr184_wait_reason\(p_org\)/); assert.match(p, /_tr184_cross_links\(p_org\)/);
  assert.match(p, /for update/);
});
t('SQL: DELETE only inside the purge; never organizations / profiles / subscriptions / payments', () => {
  const c = code(MIG);
  const purge = code(fnBody(MIG, '_trial_retention_purge_org'));
  const outside = c.replace(purge, '');
  assert.ok(!/\bdelete\s+from\b/i.test(outside), 'no DELETE outside the purge');
  assert.ok(!/\b(truncate|drop\s+table|drop\s+column|drop\s+function)\b/i.test(c), 'no truncate / drop table / column / function');
  const list = fnBody(MIG, '_tr184_purge_tables');
  for (const keep of ['organizations', 'profiles', 'studio_subscriptions', 'subscription_payments', 'studio_consent_log', 'audit_log', 'whatsapp_opt_outs'])
    assert.ok(!new RegExp(`'${keep}'`).test(list), keep + ' never purged');
  assert.match(purge, /delete from public\.audit_log al where al\.org_id = p_org and al\.entity = any\(v_tabs\)/);
  assert.match(purge, /execute format\('delete from public\.%I where org_id = \$1', t\) using p_org/);
});
t('SQL: trial-ness from the subscription status; paid + sample master excluded', () => {
  const b = fnBody(MIG, '_trial_retention_block');
  assert.match(b, /s\.status not in \('trial', 'past_due'\)/);
  assert.match(b, /from public\.subscription_payments p where p\.org_id = p_org/);
  assert.match(b, /current_period_start is not null or s\.current_period_end is not null/);
  assert.match(b, /provider_subscription_id is not null/);
  assert.match(b, /is_sample_master/); assert.match(b, /helm_sample_template/);
  assert.match(b, /_trial_locked\(p_org\)/);
});
t('SQL: dates - last day + 60, >= 30 days notice, only ever later; 30 / 7 / 1 day bands; +7 reminder', () => {
  const k = fnBody(MIG, 'trial_retention_tick');
  assert.match(k, /v_target := greatest\(v_last \+ cfg\.retention_days, v_today \+ 30\)/);
  assert.match(k, /delete_on = greatest\(sch\.delete_on, v_last \+ cfg\.retention_days\)/);
  assert.match(k, /when v_left <= 1 then 'del1' when v_left <= 7 then 'del7' when v_left <= 30 then 'del30'/);
  assert.match(k, /if v_today - v_last = 7 then/);
  assert.match(k, /if not cfg\.delete_enabled then continue; end if;/);
  assert.match(k, /set delete_on = v_today \+ 1/);
  assert.match(fnBody(MIG, '_tr184_label'), /to_char\(p_delete_on, 'DD\/MM\/YYYY'\)/);
});
t('SQL: platform-only privileges, guarded cron, guards keep refusing', () => {
  assert.ok(!/grant execute on function [^;]* to (authenticated|anon)/.test(MIG));
  assert.ok(!/grant [^;]* on table [^;]* to (authenticated|anon)/.test(MIG));
  assert.match(MIG, /revoke all on function %s from service_role/);
  assert.ok(!/grant execute on function public\._trial_retention_purge_org/.test(MIG));
  assert.match(MIG, /if exists \(select 1 from pg_extension where extname = 'pg_cron'\)/);
  assert.match(MIG, /cron\.schedule\('helm_trial_retention', '27 \* \* \* \*', 'select public\.trial_retention_tick\(\)'\)/);
  assert.match(MIG, /cron\.schedule\('helm_trial_retention_purge', '13 22 \* \* \*', 'select public\.trial_retention_purge_due\(\)'\)/);
  for (const g of ['_a85_tg_venue_no_delete', '_a96_tg_no_delete']) {
    const b = fnBody(MIG, g);
    assert.match(b, /if public\._trial_purge_allows\(old\.org_id\) then return old; end if;/);
    assert.match(b, /raise exception '[^']+never deleted/);
  }
  const allow = fnBody(MIG, '_trial_purge_allows');
  assert.match(allow, /current_setting\('helm\.trial_purge_org', true\)/);
  assert.match(allow, /not in \('anon', 'authenticated'\)/);
  assert.match(allow, /t\.status = 'purging'/);
});
t('SQL: dry run is read-only (STABLE, no writes)', () => {
  const d = fnBody(MIG, 'trial_retention_dry_run');
  assert.match(d, /language plpgsql stable security definer/);
  assert.ok(!/\b(insert|update|delete)\s+(into|public\.|from)/i.test(code(d)));
});

if (fail) { console.log('trial-retention-0184: ' + fail + ' FAILED'); process.exit(1); }
console.log('trial-retention-0184: ok (' + n + ')');
