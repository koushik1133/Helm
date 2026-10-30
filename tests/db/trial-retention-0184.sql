-- trial-retention-0184.sql -- 0184: free-trial data retention. Switch OFF: only the 7-days-after reminder,
-- nothing scheduled, nothing deleted. Switch ON: deletion date (last day + 60, >= 30 days notice), 30 / 7 / 1
-- day warnings (bell + owner e-mail claim), missed final notice moves the date, purge only when due + noticed +
-- e-mailed + no cross-studio link; studio row, logins, subscription, billing and consent kept; other studios,
-- paid studios and the sample master untouched; hold / release; guards; privileges.
-- Rolled back. Local disposable PG only.
\set ON_ERROR_STOP 0
set client_min_messages = warning;
begin;
create temp table _uf(name text, result text); grant all on _uf to anon, authenticated, service_role;
create temp table _ukv(k text primary key, v text); grant all on _ukv to anon, authenticated, service_role;

create or replace function pg_temp.su() returns void language plpgsql as $$
begin execute 'reset role'; perform auth.logout(); execute 'reset role'; end $$;
create or replace function pg_temp.login(p_email text) returns void language plpgsql as $$
declare u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated', 'email', p_email, 'aal', 'aal1')::text, false);
  perform set_config('role', 'authenticated', false);
end $$;
create or replace function pg_temp.res(p_name text, p_ok boolean, p_detail text default '') returns void language plpgsql as $$
begin insert into _uf values (p_name, case when coalesce(p_ok, false) then 'PASS' else 'FAIL: '||coalesce(p_detail,'') end); end $$;
grant execute on function pg_temp.res(text, boolean, text) to anon, authenticated, service_role;
create or replace function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return ''; exception when others then return sqlstate || ' ' || sqlerrm; end $$;
grant execute on function pg_temp.try(text) to anon, authenticated, service_role;
create or replace function pg_temp.put(p_k text, p_v text) returns void language plpgsql as $$
begin insert into _ukv values (p_k, p_v) on conflict (k) do update set v = excluded.v; end $$;
create or replace function pg_temp.get(p_k text) returns text language sql as $$ select v from _ukv where k = p_k $$;
create or replace function pg_temp.org(p_k text) returns uuid language sql as $$ select v::uuid from _ukv where k = p_k $$;
create or replace function pg_temp.trial(p_email text) returns uuid language plpgsql as $$
declare r jsonb; u uuid; begin
  perform pg_temp.su(); select id into u from auth.users where email = p_email;
  if u is null then u := auth.seed_user(p_email); end if;
  insert into public.profiles(id, email, role, org_id, must_change_password, created_at) values (u, p_email, 'admin', null, false, now())
    on conflict (id) do update set org_id = null, role = 'admin';
  perform pg_temp.login(p_email);
  r := public.start_self_serve_trial('T ' || p_email, 'Asia/Kolkata', 'INR', 'demo');
  perform pg_temp.su(); return (r ->> 'org_id')::uuid;
end $$;
-- the trial ended p_days ago; the daily billing job has moved the subscription to past_due
create or replace function pg_temp.expire(p_org uuid, p_days integer) returns void language plpgsql as $$
begin
  update public.organizations set trial_ends_at = now() - make_interval(days => p_days) where id = p_org;
  update public.studio_subscriptions set status = 'past_due',
         trial_ends_at = ((now() - make_interval(days => p_days)) at time zone 'UTC')::date where org_id = p_org;
end $$;
-- row counts of every org table for one studio
create or replace function pg_temp.snap(p_org uuid) returns jsonb language plpgsql as $$
declare t text; n bigint; v jsonb := '{}'::jsonb; begin
  foreach t in array public._tr184_org_tables() loop
    execute format('select count(*) from public.%I where org_id = $1', t) into n using p_org;
    if n > 0 then v := v || jsonb_build_object(t, n); end if;
  end loop;
  return v;
end $$;
create or replace function pg_temp.left_rows(p_org uuid) returns bigint language plpgsql as $$
declare t text; n bigint; s bigint := 0; begin
  foreach t in array public._tr184_purge_tables() loop
    continue when to_regclass('public.' || t) is null;
    execute format('select count(*) from public.%I where org_id = $1', t) into n using p_org; s := s + n;
  end loop;
  return s;
end $$;
create or replace function pg_temp.today() returns date language sql as $$ select (now() at time zone 'Asia/Kolkata')::date $$;
create or replace function pg_temp.nnot(p_org uuid, p_kind text) returns int language sql as $$
  select count(*)::int from public.trial_retention_notices where org_id = p_org and kind = p_kind $$;

-- earlier suites in run-all re-apply older migrations (0085 / 0096 guards): re-run 0184 (also proves a re-run is safe)
\ir ../../supabase/migrations/0184_trial_retention.sql
-- 0198 adds its two event tables (event_cancellations, calendar_conflict_acks) to the purge list on top of 0184
\ir ../../supabase/migrations/0198_event_stages_closure.sql
-- 0201 (release integration) adds 0194's chat_group_contacts to the purge list on top of 0184
\ir ../../supabase/migrations/0201_release_integration.sql
-- 0206 adds quote_flow_progress (where each person left off in the quote flow) to the purge list
\ir ../../supabase/migrations/0206_flow_progress.sql
-- 0207 (trial terms) adds its consent record trial_terms_acceptances to the keep list on top of 0184
\ir ../../supabase/migrations/0207_trial_terms_acceptance.sql
-- 0212 (trial client e-mail) adds its cap ledger trial_email_sends to the keep list on top of 0184
\ir ../../supabase/migrations/0212_trial_client_email.sql
-- 0241 (delivery reminders) adds its four assignment tables to the purge list and delivery_settings to the keep list
\ir ../../supabase/migrations/0241_delivery_reminders.sql
-- 0244 (r21 trial -> paid) adds sales_requests + helm_notice_outbox to the keep list on top of 0184
\ir ../../supabase/migrations/0244_trial_to_paid_activation.sql
-- 0250 (r21 security notices) adds hq_security_notices (Helm HQ's own record) to the keep list on top of 0184
\ir ../../supabase/migrations/0250_security_notices_hq_only.sql
-- 0254 (r22 closure) adds event_close_requests (close requests / approvals) to the purge list on top of 0184
\ir ../../supabase/migrations/0254_closure_checklist_override.sql
-- 0256 (r23 vendor requests) adds its six request / invoice tables to the purge list on top of 0184
\ir ../../supabase/migrations/0256_vendor_requests_invoices.sql
-- 0260 (r23 cancel links + restore) adds event_restorations (the restore log) to the purge list on top of 0184
\ir ../../supabase/migrations/0260_cancel_expires_links.sql
-- 0261 (r23 link views) adds client_link_views + client_view_followups to the purge list, client_view_settings to keep
\ir ../../supabase/migrations/0261_client_link_views.sql
-- 0262 adds quote_validity / quote_validity_log to the purge list (re-applied after the 0184 body above)
\ir ../../supabase/migrations/0262_quote_validity.sql
-- 0263 (r23 state machine) adds its four stage / domain-event tables to the purge list on top of 0184
\ir ../../supabase/migrations/0263_quote_stage_machine.sql
-- 0264 (r23 payment schedules) adds its templates / per-event prefs / overdue bookkeeping to the purge list and its
-- studio settings to the keep list on top of 0184
\ir ../../supabase/migrations/0264_payment_schedules.sql
-- 0265 (r23 crew) adds its five tables (availability, open shifts + claims, check-ins, check-in sites) to the purge list
\ir ../../supabase/migrations/0265_crew_availability_shifts_checkin.sql
-- 0266 (r23 inbox) adds notification_inbox_state to the purge list and inbox_settings + inbox_person_prefs to the keep list
\ir ../../supabase/migrations/0266_notification_inbox.sql
\ir ../../supabase/migrations/0270_inbox_visible_speed.sql
-- 0269 (r24 automation) adds runsheet_reminder_sends + lead_enquiries to the purge list and automation_settings to the keep list
\ir ../../supabase/migrations/0269_r24_automation.sql
-- 0283 (r33 team safety) adds its five team-safety records (owner log, deactivations, admin changes, hand-overs, events) to the keep list
\ir ../../supabase/migrations/0283_r33_team_safety.sql
-- 0285 (r35 payment-details safety) adds pay_detail_changes + studio_security_events + studio_account_flags to the keep list
\ir ../../supabase/migrations/0285_r35_payment_details_safety.sql
-- 0284 (r34 invitation RSVP + link history) adds event_site_rsvps + event_site_slug_history to the purge list
\ir ../../supabase/migrations/0284_invite_rsvp_privacy.sql
-- 0290 (r41 send window) adds its per-studio settings table studio_send_windows to the keep list on top of 0184
\ir ../../supabase/migrations/0290_send_window.sql
-- 0280 (r42 HQ v2) adds hq_studio_credits (HQ billing record) to the keep list
\ir ../../supabase/migrations/0280_hq_v2_round2.sql
-- 0310 (r89 template versions) adds studio_layout_template_versions to the purge list (purged with the templates)
\ir ../../supabase/migrations/0310_r89_template_versions.sql

-- ---- fixtures -----------------------------------------------------------------------------------------
do $$ declare m uuid; begin
  perform pg_temp.su();
  update public.helm_sample_template set active = true where id;
  update public.helm_trial_retention set delete_enabled = false, retention_days = 60, require_email_notice = true where id;
  perform pg_temp.put('A', pg_temp.trial('tr184_a@t.test')::text);   -- purged
  perform pg_temp.put('X', pg_temp.trial('tr184_x@t.test')::text);   -- ended 7 days ago, later pays
  perform pg_temp.put('P', pg_temp.trial('tr184_p@t.test')::text);   -- ended, paid
  perform pg_temp.put('C', pg_temp.trial('tr184_c@t.test')::text);   -- active trial
  perform pg_temp.put('H', pg_temp.trial('tr184_h@t.test')::text);   -- ended, on hold
  perform pg_temp.put('N', pg_temp.trial('tr184_n@t.test')::text);   -- ended, no warning e-mail went out
  perform pg_temp.put('G', pg_temp.trial('tr184_g@t.test')::text);   -- ended, another studio links to its rows
  perform pg_temp.expire(pg_temp.org('A'), 70); perform pg_temp.expire(pg_temp.org('X'), 7);
  perform pg_temp.expire(pg_temp.org('P'), 70); perform pg_temp.expire(pg_temp.org('H'), 70);
  perform pg_temp.expire(pg_temp.org('N'), 70); perform pg_temp.expire(pg_temp.org('G'), 70);
  perform public._sub_record_payment(pg_temp.org('P'), 1180::numeric, 'INR'::text, current_date, current_date, current_date + 30,
    'card'::text, 'pay_tr184P'::text, null::uuid, null::text, null::text, null::text, null::numeric);
  select org_id into m from public.helm_sample_template where id; perform pg_temp.put('M', m::text);
  perform pg_temp.put('A_quotes', (select count(*) from public.quotes where org_id = pg_temp.org('A'))::text);
end $$;

-- ---- 1) the switch is OFF ------------------------------------------------------------------------------
do $$ declare j jsonb; e text; begin
  perform pg_temp.su();
  perform pg_temp.res('01 owner switch: one row, deletion OFF, 60 days, e-mail notice required',
    (select count(*) from public.helm_trial_retention) = 1
    and (select not delete_enabled and retention_days = 60 and require_email_notice from public.helm_trial_retention where id));
  perform pg_temp.res('02 eligibility: ended never-paid trial yes; active / paid / sample master / fixture studio no',
    public._trial_retention_block(pg_temp.org('A')) is null and public._trial_retention_block(pg_temp.org('X')) is null
    and public._trial_retention_block(pg_temp.org('C')) = 'not_expired'
    and public._trial_retention_block(pg_temp.org('P')) = 'has_payment'
    and public._trial_retention_block(pg_temp.org('M')) = 'sample_master'
    and public._trial_retention_block('a0000000-0000-4000-8000-000000000001') is not null
    and public._trial_retention_block('b0000000-0000-4000-8000-000000000001') is not null,
    coalesce(public._trial_retention_block(pg_temp.org('M')), 'null') || ' / ' || coalesce(public._trial_retention_block('a0000000-0000-4000-8000-000000000001'), 'null'));
  j := public.trial_retention_tick();
  perform pg_temp.res('03 switch off: only the +7 reminder (X), nothing scheduled',
    (j ->> 'x7_new')::int = 1 and (j ->> 'armed')::int = 0 and pg_temp.nnot(pg_temp.org('X'), 'x7') = 1
    and pg_temp.nnot(pg_temp.org('A'), 'x7') = 0 and not exists (select 1 from public.trial_retention_schedule)
    and not exists (select 1 from public.trial_retention_notices where kind <> 'x7'), j::text);
  perform pg_temp.res('04 +7 reminder: admin-only bell row with label', exists (select 1 from public.notifications n
    where n.org_id = pg_temp.org('X') and n.kind = 'trial_reminder' and n.detail ->> 'source' = '0184'
      and n.detail ->> 'milestone' = 'x7' and n.detail ->> 'label' like '%ended 7 days ago%'));
  j := public.trial_retention_tick();
  perform pg_temp.res('05 tick again: no duplicates', (j ->> 'x7_new')::int = 0 and pg_temp.nnot(pg_temp.org('X'), 'x7') = 1
    and (select count(*) from public.notifications where org_id = pg_temp.org('X') and detail ->> 'source' = '0184') = 1, j::text);
  j := public.trial_retention_purge_due();
  perform pg_temp.res('06 switch off: the deletion job does nothing',
    j ->> 'delete_enabled' = 'false' and (j ->> 'deleted')::int = 0
    and (select count(*) from public.quotes where org_id = pg_temp.org('A'))::text = pg_temp.get('A_quotes'), j::text);
  e := pg_temp.try(format('select public._trial_retention_purge_org(%L)', pg_temp.org('A')));
  perform pg_temp.res('07 switch off: a direct purge call is refused', e like '42501%switched off%', e);
  j := public.trial_retention_dry_run(pg_temp.org('A'), true) -> 'studios' -> 0;
  perform pg_temp.res('08 dry run: eligible, projected date = today + 30 (>= 30 days notice), not deleted, counts',
    (j ->> 'eligible')::boolean and (j ->> 'projected_delete_on')::date = pg_temp.today() + 30
    and j ->> 'wait_reason' = 'not_scheduled' and not (j ->> 'would_delete_now')::boolean
    and (j -> 'would_delete_rows' ->> 'quotes')::int > 0 and (j -> 'would_delete_rows' ->> 'venues')::int > 0
    and (j -> 'kept_rows' ->> 'profiles')::int >= 1 and j -> 'unclassified_rows_kept' = '{}'::jsonb
    and j -> 'cross_studio_links' = '{}'::jsonb, j::text);
  perform pg_temp.res('09 dry run: every org table is classified purge / keep',
    public.trial_retention_dry_run() -> 'unclassified_tables' = '[]'::jsonb
    and (public.trial_retention_dry_run() -> 'settings' ->> 'delete_enabled') = 'false');
end $$;

-- ---- 2) switch ON: schedule + warnings -------------------------------------------------------------------
do $$ declare j jsonb; begin
  perform pg_temp.su();
  j := public.trial_retention_set_hold(pg_temp.org('H'), true, 'owner asked to keep');
  perform pg_temp.res('10 hold: H kept out before arming', (j ->> 'status') = 'held', j::text);
  update public.helm_trial_retention set delete_enabled = true where id;
  perform pg_temp.res('11 flipping the switch leaves an audit row', exists (select 1 from public.audit_log a
    where a.action = 'trial.retention_settings' and a.changed -> 'delete_enabled' = '[false, true]'::jsonb));
  j := public.trial_retention_tick();
  perform pg_temp.res('12 armed: A / N / G today + 30, X last day + 60; P / C / H / master not',
    (select delete_on from public.trial_retention_schedule where org_id = pg_temp.org('A')) = pg_temp.today() + 30
    and (select delete_on from public.trial_retention_schedule where org_id = pg_temp.org('N')) = pg_temp.today() + 30
    and (select delete_on from public.trial_retention_schedule where org_id = pg_temp.org('X')) = pg_temp.today() - 7 + 60
    and not exists (select 1 from public.trial_retention_schedule where org_id in (pg_temp.org('P'), pg_temp.org('C'), pg_temp.org('M')))
    and (select status from public.trial_retention_schedule where org_id = pg_temp.org('H')) = 'held', j::text);
  perform pg_temp.res('13 30-day warning once for A (bell + notice); none yet for X',
    pg_temp.nnot(pg_temp.org('A'), 'del30') = 1 and pg_temp.nnot(pg_temp.org('X'), 'del30') = 0
    and exists (select 1 from public.notifications n where n.org_id = pg_temp.org('A') and n.detail ->> 'milestone' = 'del30'
                  and n.detail ->> 'label' = 'Trial data will be permanently deleted on ' || to_char(pg_temp.today() + 30, 'DD/MM/YYYY')));
  j := public.trial_retention_tick();
  perform pg_temp.res('14 tick again: nothing new', (j ->> 'armed')::int = 0 and (j ->> 'warnings_new')::int = 0
    and pg_temp.nnot(pg_temp.org('A'), 'del30') = 1, j::text);
end $$;

-- ---- 3) e-mail claim ---------------------------------------------------------------------------------------
do $$ declare j jsonb; a jsonb; x jsonb; r jsonb; begin
  perform pg_temp.su();
  j := public.trial_retention_email_claim(50);
  select e into a from jsonb_array_elements(j) e where (e ->> 'kind') = 'del30' and e ->> 'to' = 'tr184_a@t.test';
  select e into x from jsonb_array_elements(j) e where (e ->> 'kind') = 'x7' and e ->> 'to' = 'tr184_x@t.test';
  perform pg_temp.res('15 claim: A 30-day warning to the owner with the date, X +7 reminder with its date',
    a is not null and (a ->> 'delete_on')::date = pg_temp.today() + 30 and a ->> 'timezone' = 'Asia/Kolkata'
    and (a ->> 'retention_days')::int = 60
    and x is not null and (x ->> 'delete_on')::date = pg_temp.today() - 7 + 60, j::text);
  perform pg_temp.res('16 claim never hands out a client address or another kind of row',
    not exists (select 1 from jsonb_array_elements(j) e where e ->> 'to' like '%example.com' or e ->> 'kind' not in ('x7', 'del30', 'del7', 'del1')));
  for r in select e from jsonb_array_elements(j) e loop
    perform public.trial_retention_email_mark((r ->> 'id')::uuid, case when r ->> 'to' = 'tr184_n@t.test' then 'skipped' else 'sent' end);
  end loop;
  perform pg_temp.res('17 claim again: nothing left to send', jsonb_array_length(public.trial_retention_email_claim(50)) = 0);
  perform pg_temp.res('18 0120 claim unchanged: never returns retention rows',
    not exists (select 1 from jsonb_array_elements(public.trial_reminder_email_claim(50)) e where e ? 'kind'));
end $$;

-- ---- 4) 7 / 1 day warnings, missed final notice ---------------------------------------------------------------
do $$ declare j jsonb; begin
  perform pg_temp.su();
  update public.trial_retention_schedule set delete_on = pg_temp.today() + 7 where org_id = pg_temp.org('A');
  perform public.trial_retention_tick();
  perform pg_temp.res('19 7-day warning', pg_temp.nnot(pg_temp.org('A'), 'del7') = 1
    and (select delete_on from public.trial_retention_notices where org_id = pg_temp.org('A') and kind = 'del7') = pg_temp.today() + 7);
  update public.trial_retention_schedule set delete_on = pg_temp.today() + 1 where org_id = pg_temp.org('A');
  perform public.trial_retention_tick();
  perform pg_temp.res('20 final (1-day) warning', pg_temp.nnot(pg_temp.org('A'), 'del1') = 1
    and exists (select 1 from public.notifications n where n.org_id = pg_temp.org('A') and n.detail ->> 'milestone' = 'del1'
                  and n.detail ->> 'label' like 'Final notice:%'));
  j := public.trial_retention_purge_due();
  perform pg_temp.res('21 not due yet: nothing deleted', (j ->> 'deleted')::int = 0 and public._tr184_wait_reason(pg_temp.org('A')) = 'not_due'
    and (select count(*) from public.quotes where org_id = pg_temp.org('A'))::text = pg_temp.get('A_quotes'), j::text);
  -- G reached its date without a final notice (cron down): the deletion moves to tomorrow
  update public.trial_retention_schedule set delete_on = pg_temp.today() where org_id = pg_temp.org('G');
  j := public.trial_retention_tick();
  perform pg_temp.res('22 missed final notice: date moved to tomorrow + final notice recorded',
    (select delete_on from public.trial_retention_schedule where org_id = pg_temp.org('G')) = pg_temp.today() + 1
    and pg_temp.nnot(pg_temp.org('G'), 'del1') = 1 and (j ->> 'final_notice_moved')::int = 1, j::text);
  perform pg_temp.res('23 a date is never moved earlier by the tick (A stays at tomorrow)',
    (select delete_on from public.trial_retention_schedule where org_id = pg_temp.org('A')) = pg_temp.today() + 1);
end $$;

-- ---- 5) the purge -----------------------------------------------------------------------------------------------
do $$ declare j jsonb; k text; s_before jsonb := '{}'::jsonb; s_after jsonb := '{}'::jsonb; v_g bigint; v_item uuid; begin
  perform pg_temp.su();
  -- one day later: A, N, G are due and their final notice is a day old
  update public.trial_retention_schedule set delete_on = pg_temp.today() where org_id in (pg_temp.org('A'), pg_temp.org('N'), pg_temp.org('G'));
  update public.trial_retention_notices set delete_on = pg_temp.today(), created_at = now() - interval '25 hours'
   where kind = 'del1' and org_id in (pg_temp.org('A'), pg_temp.org('G'));
  insert into public.trial_retention_notices(org_id, kind, expired_at, delete_on, dedupe_key, created_at)
    select pg_temp.org('N'), 'del1', expired_at, pg_temp.today(), 'tr184test:N', now() - interval '25 hours'
      from public.trial_retention_schedule where org_id = pg_temp.org('N');
  update public.trial_retention_notices set email_status = 'sent', email_sent_at = now() where org_id = pg_temp.org('G') and kind = 'del30';
  -- a row of studio C points at one of G's inventory items (legacy cross-studio link)
  select id into v_item from public.inventory_items where org_id = pg_temp.org('G') limit 1;
  insert into public.inv_shortage_alerts(org_id, item_id, event_date, need, have) values (pg_temp.org('C'), v_item, current_date + 5, 3, 1);
  perform pg_temp.res('24 ready: A due, N waits for an e-mailed warning, G due',
    public._tr184_wait_reason(pg_temp.org('A')) is null and public._tr184_wait_reason(pg_temp.org('N')) = 'no_warning_email_sent'
    and public._tr184_wait_reason(pg_temp.org('G')) is null,
    coalesce(public._tr184_wait_reason(pg_temp.org('A')), '-') || ' / ' || coalesce(public._tr184_wait_reason(pg_temp.org('N')), '-'));
  perform pg_temp.res('25 dry run shows the cross-studio link for G', (public.trial_retention_dry_run(pg_temp.org('G')) -> 'studios' -> 0
    -> 'cross_studio_links') ? 'inv_shortage_alerts.item_id->inventory_items');
  foreach k in array array['X', 'P', 'C', 'H', 'N', 'G', 'M'] loop
    s_before := s_before || jsonb_build_object(k, pg_temp.snap(pg_temp.org(k)));
  end loop;
  s_before := s_before || jsonb_build_object('SA', pg_temp.snap('a0000000-0000-4000-8000-000000000001'), 'SB', pg_temp.snap('b0000000-0000-4000-8000-000000000001'));
  perform pg_temp.put('A_before', pg_temp.snap(pg_temp.org('A'))::text);
  j := public.trial_retention_purge_due();
  perform pg_temp.res('26 purge run: A deleted, G refused, N waiting', (j ->> 'deleted')::int = 1 and (j ->> 'failed')::int = 1
    and (j ->> 'waiting')::int >= 1, j::text);
  perform pg_temp.res('27 A: every business table is empty', pg_temp.left_rows(pg_temp.org('A')) = 0
    and not exists (select 1 from public.quotes where org_id = pg_temp.org('A'))
    and not exists (select 1 from public.venues where org_id = pg_temp.org('A'))
    and not exists (select 1 from public.studio_layout_templates where org_id = pg_temp.org('A'))
    and not exists (select 1 from public.lead_archive where org_id = pg_temp.org('A')), pg_temp.snap(pg_temp.org('A'))::text);
  perform pg_temp.res('28 A: studio row, owner login + profile, subscription, settings kept',
    exists (select 1 from public.organizations where id = pg_temp.org('A'))
    and exists (select 1 from public.profiles p join auth.users u on u.id = p.id where p.org_id = pg_temp.org('A') and u.email = 'tr184_a@t.test')
    and (select status from public.studio_subscriptions where org_id = pg_temp.org('A')) = 'past_due'
    and (pg_temp.get('A_before')::jsonb ->> 'app_config') is not distinct from (pg_temp.snap(pg_temp.org('A')) ->> 'app_config')
    and (pg_temp.get('A_before')::jsonb ->> 'role_access') is not distinct from (pg_temp.snap(pg_temp.org('A')) ->> 'role_access'));
  perform pg_temp.res('29 A: schedule deleted, run row + audit row with counts only',
    (select status from public.trial_retention_schedule where org_id = pg_temp.org('A')) = 'deleted'
    and exists (select 1 from public.trial_retention_runs r where r.org_id = pg_temp.org('A') and r.action = 'purge' and r.ok
                  and (r.counts -> 'rows' ->> 'quotes')::int = pg_temp.get('A_quotes')::int)
    and exists (select 1 from public.audit_log a where a.org_id = pg_temp.org('A') and a.action = 'trial.retention_purged'
                  and a.actor_email = 'helm:retention' and (a.changed -> 'rows' ->> 'quotes')::int > 0
                  and not (a.changed ? 'name')));
  perform pg_temp.res('30 A: audit copies of deleted rows gone; billing / studio audit kept',
    not exists (select 1 from public.audit_log a where a.org_id = pg_temp.org('A') and a.entity = any(public._tr184_purge_tables()))
    and exists (select 1 from public.audit_log a where a.org_id = pg_temp.org('A') and a.action = 'subscription.trial_started'));
  foreach k in array array['X', 'P', 'C', 'H', 'N', 'G', 'M'] loop
    s_after := s_after || jsonb_build_object(k, pg_temp.snap(pg_temp.org(k)));
  end loop;
  s_after := s_after || jsonb_build_object('SA', pg_temp.snap('a0000000-0000-4000-8000-000000000001'), 'SB', pg_temp.snap('b0000000-0000-4000-8000-000000000001'));
  perform pg_temp.res('31 every other studio (trials, paid, sample master, fixtures) unchanged row for row',
    s_before - 'G' = s_after - 'G' and (s_before -> 'G') - 'audit_log' - 'trial_retention_runs' = (s_after -> 'G') - 'audit_log' - 'trial_retention_runs',
    (s_before -> 'M')::text);
  perform pg_temp.res('32 G refused (cross-studio link): nothing of G deleted, failure recorded, still scheduled',
    (select status from public.trial_retention_schedule where org_id = pg_temp.org('G')) = 'scheduled'
    and (select failures from public.trial_retention_schedule where org_id = pg_temp.org('G')) = 1
    and (select last_error from public.trial_retention_schedule where org_id = pg_temp.org('G')) like '%another studio%'
    and exists (select 1 from public.trial_retention_runs where org_id = pg_temp.org('G') and action = 'purge_failed' and not ok)
    and exists (select 1 from public.inv_shortage_alerts where org_id = pg_temp.org('C') and item_id = v_item));
  j := public.trial_retention_purge_due(); j := public.trial_retention_purge_due();
  perform pg_temp.res('33 G after 3 failures: status failed, left alone; A never purged twice',
    (select status from public.trial_retention_schedule where org_id = pg_temp.org('G')) = 'failed'
    and (select count(*) from public.trial_retention_runs where org_id = pg_temp.org('A') and action = 'purge') = 1
    and pg_temp.snap(pg_temp.org('G')) - 'audit_log' - 'trial_retention_runs' = (s_before -> 'G') - 'audit_log' - 'trial_retention_runs');
  j := public.trial_retention_tick();
  perform pg_temp.res('34 after the purge: A is "already deleted", nothing new for it',
    public._trial_retention_block(pg_temp.org('A')) = 'already_deleted'
    and (select count(*) from public.trial_retention_notices where org_id = pg_temp.org('A')) = 3, j::text);
end $$;

-- ---- 6) paid after scheduling, hold / release, retention change ----------------------------------------------------
do $$ declare j jsonb; e text; begin
  perform pg_temp.su();
  perform public._sub_record_payment(pg_temp.org('X'), 1180::numeric, 'INR'::text, current_date, current_date, current_date + 30,
    'card'::text, 'pay_tr184X'::text, null::uuid, null::text, null::text, null::text, null::numeric);
  update public.trial_retention_schedule set delete_on = pg_temp.today() + 30 where org_id = pg_temp.org('X');
  perform public.trial_retention_tick();
  perform pg_temp.res('35 X paid: schedule cancelled, no warning recorded',
    (select status from public.trial_retention_schedule where org_id = pg_temp.org('X')) = 'cancelled'
    and pg_temp.nnot(pg_temp.org('X'), 'del30') = 0);
  e := pg_temp.try(format('select public._trial_retention_purge_org(%L)', pg_temp.org('X')));
  perform pg_temp.res('36 X paid: a direct purge call is refused', e like 'P0001%refused%', e);
  perform pg_temp.res('37 H on hold: never scheduled, never purged', (select status from public.trial_retention_schedule where org_id = pg_temp.org('H')) = 'held'
    and public._tr184_wait_reason(pg_temp.org('H')) = 'status_held' and pg_temp.left_rows(pg_temp.org('H')) > 0);
  j := public.trial_retention_set_hold(pg_temp.org('H'), false, 'released');
  perform public.trial_retention_tick();
  perform pg_temp.res('38 H released: re-scheduled with >= 30 days notice + first warning',
    (select status from public.trial_retention_schedule where org_id = pg_temp.org('H')) = 'scheduled'
    and (select delete_on from public.trial_retention_schedule where org_id = pg_temp.org('H')) >= pg_temp.today() + 30
    and pg_temp.nnot(pg_temp.org('H'), 'del30') = 1, j::text);
  -- a final notice from 20 days ago (the switch was off meanwhile) is too old to delete on
  update public.trial_retention_schedule set delete_on = pg_temp.today() where org_id = pg_temp.org('H');
  insert into public.trial_retention_notices(org_id, kind, expired_at, delete_on, dedupe_key, created_at)
    select org_id, 'del1', expired_at, pg_temp.today(), 'tr184test:H', now() - interval '20 days'
      from public.trial_retention_schedule where org_id = pg_temp.org('H');
  perform pg_temp.res('38b stale final notice: not deletable, tick moves the date to tomorrow with a fresh notice',
    public._tr184_wait_reason(pg_temp.org('H')) = 'final_notice_pending');
  perform public.trial_retention_tick();
  perform pg_temp.res('38c fresh final notice for tomorrow', (select delete_on from public.trial_retention_schedule where org_id = pg_temp.org('H')) = pg_temp.today() + 1
    and exists (select 1 from public.trial_retention_notices where org_id = pg_temp.org('H') and kind = 'del1' and delete_on = pg_temp.today() + 1
                  and created_at > now() - interval '1 hour'));
  update public.helm_trial_retention set retention_days = 120 where id;
  perform public.trial_retention_tick();
  perform pg_temp.res('39 longer retention moves dates later only (N: last day + 120)',
    (select delete_on from public.trial_retention_schedule where org_id = pg_temp.org('N')) = pg_temp.today() - 70 + 120
    and public.trial_retention_mail_settings() = '{"retention_days": 120, "delete_enabled": true}'::jsonb);
  update public.helm_trial_retention set delete_enabled = false, retention_days = 60 where id;
  j := public.trial_retention_purge_due();
  e := jsonb_array_length(public.trial_retention_email_claim(50))::text;
  perform pg_temp.res('40 switch off again: job does nothing, pending warnings are not sent',
    j ->> 'delete_enabled' = 'false' and e = '0'
    and not exists (select 1 from public.trial_retention_notices where kind <> 'x7' and email_status = 'pending'), j::text || ' claimed ' || e);
end $$;

-- ---- 7) guards + privileges ---------------------------------------------------------------------------------------
do $$ declare e text; v uuid; begin
  perform pg_temp.su();
  select id into v from public.venues where org_id = pg_temp.org('C') limit 1;
  e := pg_temp.try(format('delete from public.venues where id = %L', v));
  perform pg_temp.res('41 venues still never deleted outside the purge', e like '42501%never deleted%', e);
  perform set_config('helm.trial_purge_org', pg_temp.org('C')::text, true);
  e := pg_temp.try(format('delete from public.venues where id = %L', v));
  perform pg_temp.res('42 the purge flag alone does not unlock the guard', e like '42501%never deleted%', e);
  e := pg_temp.try(format('delete from public.studio_layout_templates where org_id = %L', pg_temp.org('C')));
  perform pg_temp.res('43 studio templates still never deleted outside the purge', e like '42501%never deleted%', e);
  perform set_config('helm.trial_purge_org', '', true);
  perform pg_temp.res('44 app roles cannot run any retention function',
    not has_function_privilege('authenticated', 'public.trial_retention_tick()', 'execute')
    and not has_function_privilege('authenticated', 'public.trial_retention_purge_due(integer)', 'execute')
    and not has_function_privilege('authenticated', 'public._trial_retention_purge_org(uuid)', 'execute')
    and not has_function_privilege('authenticated', 'public.trial_retention_dry_run(uuid, boolean)', 'execute')
    and not has_function_privilege('authenticated', 'public.trial_retention_set_hold(uuid, boolean, text)', 'execute')
    and not has_function_privilege('authenticated', 'public.trial_retention_email_claim(integer)', 'execute')
    and not has_function_privilege('anon', 'public.trial_retention_tick()', 'execute')
    and not has_function_privilege('anon', 'public._trial_purge_allows(uuid)', 'execute')
    and not has_function_privilege('service_role', 'public._trial_retention_purge_org(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.trial_retention_tick()', 'execute')
    and has_function_privilege('service_role', 'public.trial_retention_dry_run(uuid, boolean)', 'execute'));
  perform pg_temp.res('45 app roles cannot read or write the retention tables',
    not has_table_privilege('authenticated', 'public.helm_trial_retention', 'select')
    and not has_table_privilege('authenticated', 'public.trial_retention_schedule', 'select')
    and not has_table_privilege('authenticated', 'public.trial_retention_notices', 'select')
    and not has_table_privilege('anon', 'public.trial_retention_runs', 'select')
    and not has_table_privilege('authenticated', 'public.helm_trial_retention', 'update')
    and not has_table_privilege('service_role', 'public.helm_trial_retention', 'update')
    and not has_table_privilege('service_role', 'public.trial_retention_schedule', 'delete')
    and has_table_privilege('service_role', 'public.trial_retention_runs', 'select'));
  perform pg_temp.login('tr184_c@t.test');
  e := pg_temp.try('select public.trial_retention_dry_run()');
  perform pg_temp.res('46 a studio admin cannot call the report', e like '42501%', e);
  e := pg_temp.try('update public.helm_trial_retention set delete_enabled = true');
  perform pg_temp.su();
  perform pg_temp.res('47 a studio admin cannot flip the switch', e like '42501%' and not (select delete_enabled from public.helm_trial_retention where id), e);
  perform pg_temp.res('48 the 0120 day 5 / 7 / 8 reminders still run', public.trial_reminders_tick() ? 'trial_reminders_new');
end $$;

select name, result from _uf order by name;
select case when count(*) filter (where result <> 'PASS') = 0 then 'TRIAL-RETENTION-0184: ALL PASS (' || count(*) || '/' || count(*) || ')'
            else 'TRIAL-RETENTION-0184: ' || count(*) filter (where result <> 'PASS') || ' FAILED of ' || count(*) end as summary from _uf;
rollback;
