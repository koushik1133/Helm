-- 0177_trial_india_defaults.sql - CANONICAL forward-only.
-- REQUIRES 0089 (organizations.country / tax_region), 0097 (organizations.trial_mode),
--          0119 (start_self_serve_trial), 0159 (my_pending_start_trial), 0058 (studio_subscriptions),
--          0166 (organizations.is_sample_master).
--
-- In plain words:
--   The free trial is for India only: every free-trial studio is INR, Asia/Kolkata, country IN,
--   GST (tax region = the Indian state; Telangana when none is set, the trial city is Hyderabad).
--   Until now start_self_serve_trial() used the visitor's browser time zone (and a currency
--   guessed from it), so a visitor in the US got USD + America/Chicago.
--   * New nullable column organizations.trial_region. It is stamped 'IN' at the one moment a
--     free trial starts (trial_ends_at goes from empty to set together with trial_mode, which
--     only start_self_serve_trial / my_pending_start_trial do). Checkout trials of paid
--     "Create studio" studios (my_start_trial: trial_mode stays empty) are never stamped.
--   * A trigger keeps a stamped studio on INR / Asia/Kolkata / IN while it is still ON its free
--     trial (subscription status 'trial'). After the studio pays, it can change them freely.
--   * Only NEW trials are affected by this file: no existing row is updated here. Existing trial
--     studios are corrected by the separate, owner-run supabase/FIX-0177-existing-trials.sql.
--   Additive + idempotent: add column if not exists, create or replace, drop trigger if exists.
--   No DROP of data, DELETE or TRUNCATE. Safe to run twice.
-- ============================================================================

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'organizations' and column_name = 'trial_mode') then
    raise exception '0177: organizations.trial_mode (0097) is missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'organizations' and column_name = 'tax_region') then
    raise exception '0177: organizations.tax_region (0089) is missing'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'organizations' and column_name = 'is_sample_master') then
    raise exception '0177: organizations.is_sample_master (0166) is missing'; end if;
  if to_regclass('public.studio_subscriptions') is null then
    raise exception '0177: studio_subscriptions is missing'; end if;
end $$;

alter table public.organizations add column if not exists trial_region text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'organizations_trial_region_0177_chk') then
    alter table public.organizations add constraint organizations_trial_region_0177_chk
      check (trial_region is null or trial_region = 'IN') not valid;
  end if;
end $$;

create or replace function public.tg_org_trial_india()
returns trigger language plpgsql security definer set search_path = '' as $$
-- trial-india-0177: a free-trial studio is INR / Asia/Kolkata / IN / GST while on its trial
declare v_status text;
begin
  if coalesce(new.is_sample_master, false) then return new; end if;
  -- the moment a free trial starts: stamp it (checkout trials never set trial_mode here)
  if old.trial_ends_at is null and new.trial_ends_at is not null and new.trial_mode is not null then
    new.trial_region := 'IN';
  end if;
  if new.trial_region is distinct from 'IN' or new.trial_ends_at is null then return new; end if;
  select s.status into v_status from public.studio_subscriptions s where s.org_id = new.id;
  if v_status is not null and v_status <> 'trial' then return new; end if;   -- paid / converted: free to change
  new.currency := 'INR';
  new.timezone := 'Asia/Kolkata';
  new.country := 'IN';
  if nullif(btrim(coalesce(new.tax_region, '')), '') is null then new.tax_region := 'Telangana'; end if;
  return new;
end $$;
revoke all on function public.tg_org_trial_india() from public, anon, authenticated;

drop trigger if exists zzz_org_trial_india_0177 on public.organizations;
create trigger zzz_org_trial_india_0177 before update on public.organizations
  for each row execute function public.tg_org_trial_india();

notify pgrst, 'reload schema';
