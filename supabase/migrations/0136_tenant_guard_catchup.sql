-- 0136_tenant_guard_catchup.sql - CANONICAL forward-only. REQUIRES 0004 (tg_quote_org_match).
--
-- In plain words:
--   1) Every table that has both quote_id and org_id must carry the 0004 cross-studio guard
--      (trigger zz_quote_org_match): a row can never point at another studio's event. Tables
--      added since (vendor_bills 0124, event_reminders 0129, assign_notify_outbox 0132,
--      integration_webhook_events 0117) did not get it. This re-runs the 0004 install loop,
--      so any such table - now or later - is covered. Only adds triggers; no row is changed.
--   2) Trigger functions are never meant to be called directly. Newer ones (0124, 0132) only
--      revoked EXECUTE from PUBLIC, but Supabase grants anon / authenticated by default.
--      Revoke from all three for every public trigger function. Triggers keep firing (the
--      privilege is not checked when a trigger runs).
-- Idempotent: drop-if-exists + create, revoke is a no-op when already revoked.

do $$ declare r record; begin
  if to_regprocedure('public.tg_quote_org_match()') is null then return; end if;
  for r in
    select c.table_name from information_schema.columns c
      join information_schema.columns o on o.table_schema=c.table_schema and o.table_name=c.table_name and o.column_name='org_id'
      join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
    where c.table_schema='public' and c.column_name='quote_id'
      and c.table_name not in ('quotes','audit_log','lead_archive')
      and not exists (select 1 from pg_trigger tg join pg_class k on k.oid=tg.tgrelid
                      where k.relnamespace='public'::regnamespace and k.relname=c.table_name
                        and tg.tgname='zz_quote_org_match')
    order by 1
  loop
    execute format('create trigger zz_quote_org_match before insert or update on public.%I for each row execute function public.tg_quote_org_match()', r.table_name);
  end loop;
end $$;

do $$ declare r record; begin
  for r in
    select p.oid::regprocedure as fn from pg_proc p
    where p.pronamespace='public'::regnamespace and p.prorettype='trigger'::regtype
  loop
    execute format('revoke execute on function %s from public', r.fn);
    if exists (select 1 from pg_roles where rolname='anon') then
      execute format('revoke execute on function %s from anon', r.fn); end if;
    if exists (select 1 from pg_roles where rolname='authenticated') then
      execute format('revoke execute on function %s from authenticated', r.fn); end if;
  end loop;
end $$;

--   3) Every studio table (has org_id) carries the 0045 read-only guard zzz_studio_read_only,
--      so a suspended studio / ended trial cannot write through it. The tables added in
--      0116-0132 (user_dashboard_prefs, org_payment_accounts, org_whatsapp_accounts,
--      whatsapp_opt_outs, integration_webhook_events, trial_reminders, event_reminders,
--      invite_email_outbox, assign_notify_outbox) did not get it. The guard lets the service
--      role / cron through unchanged, so webhooks, ticks and mailers keep working; the
--      0116 trial exception for user_dashboard_prefs already lives inside the guard.
--      Only missing triggers are created; existing ones are left as they are.
do $$ declare t text; begin
  if to_regprocedure('public.tg_studio_read_only()') is null then return; end if;
  foreach t in array array['user_dashboard_prefs','org_payment_accounts','org_whatsapp_accounts','whatsapp_opt_outs',
                           'integration_webhook_events','trial_reminders','event_reminders','invite_email_outbox',
                           'assign_notify_outbox'] loop
    if to_regclass('public.' || t) is not null
       and exists (select 1 from pg_attribute a where a.attrelid = ('public.' || t)::regclass and a.attname = 'org_id' and not a.attisdropped)
       and not exists (select 1 from pg_trigger g where g.tgrelid = ('public.' || t)::regclass and g.tgname = 'zzz_studio_read_only') then
      execute format('create trigger zzz_studio_read_only before insert or update or delete on public.%I for each row execute function public.tg_studio_read_only(%L)', t, 'org_id');
    end if;
  end loop;
end $$;
