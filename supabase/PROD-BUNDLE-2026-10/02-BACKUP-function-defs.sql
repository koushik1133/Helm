-- 02-BACKUP-function-defs.sql - READ ONLY. Run on PROD BEFORE step 10. Changes nothing.
-- It prints the CURRENT full definition (CREATE OR REPLACE ...) of every existing function that
-- 0116-0125 will replace. Click "Download CSV" (or copy the def column) and keep the file safely
-- (e.g. supabase/PROD-BUNDLE-2026-10/backup-prod-YYYYMMDD.csv). To roll back ONE function, paste
-- its saved def text back into the SQL editor and run it. Rows with def = NULL do not exist yet
-- (new in this bundle) - nothing to restore for them.
select f as function_signature,
       case when to_regprocedure(f) is null then null else pg_get_functiondef(to_regprocedure(f)) end as def
from unnest(array[
  'public.tg_studio_read_only()',
  'public._trial_seed_extra(uuid)',
  'public.start_trial()',
  'public.start_trial(text,text)',
  'public.my_trial_org()',
  'public.my_start_trial(text,text)',
  'public.checkout_attach_subscription(uuid,text,text,text)',
  'public.my_checkout_options()',
  'public.tg_sa54_profile()',
  'public._trial_refresh()',
  'public.dashboard_due_today()',
  'public.archive_lead()',
  'public.my_demo_status()',
  'public.enforce_no_overpayment_ms()',
  'public.tg_audit()'
]) as f;
-- Also worth saving once (read-only): the trigger list on leads, so 0125's new audit_trg can be
-- removed if ever needed with:  drop trigger if exists audit_trg on public.leads;
select tgname, pg_get_triggerdef(oid) from pg_trigger where tgrelid = 'public.leads'::regclass and not tgisinternal;
